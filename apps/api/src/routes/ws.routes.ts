/**
 * The WebSocket endpoint.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTHENTICATION, AND WHY IT LOOKS DIFFERENT FROM EVERY OTHER ROUTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `requireAuth` reads an Authorization header. The browser WebSocket API
 * cannot set headers on the handshake — that is a limitation of the API, not
 * a choice — so the token arrives as a query parameter instead.
 *
 * That has a real cost: query strings land in access logs and proxy logs in a
 * way headers usually do not. It is accepted here because the alternative
 * (an unauthenticated socket that authenticates in its first frame) means a
 * window where an anonymous connection exists and consumes resources, and
 * because these are short-lived access tokens rather than refresh tokens.
 *
 * Everything else `requireAuth` does still happens: signature verification,
 * user lookup, and the ban check. A banned user must not hold a live socket.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SUBSCRIPTION AUTHORIZATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A client asking to watch `booking:X` proves nothing. Ownership is checked
 * against the database before the subscription is recorded — and checked
 * AGAIN at publish time, where the audience list is built. Two independent
 * gates, because a subscription outlives the check that created it: a booking
 * can be reassigned while a socket is open.
 */

import type { FastifyInstance } from 'fastify'
// Imported for its declaration merging: this is what teaches Fastify's route
// options about `websocket: true` and gives the handler a SocketStream.
import type { SocketStream } from '@fastify/websocket'
import '@fastify/websocket'
import jwt from 'jsonwebtoken'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { hub, WS_OPEN, type Sendable } from '../lib/ws-hub'
import type { WsClientMessage, WsServerMessage, WsTopic } from '@locogi/types'

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'dev-only-insecure-secret'

/** Silence after which a connection is presumed dead. */
const IDLE_TIMEOUT_MS = 90_000
/** How often the server prods quiet clients and reaps the unresponsive. */
const HEARTBEAT_MS = 30_000

function now(): string {
  return new Date().toISOString()
}

function reply(type: WsServerMessage['type'], extra: Partial<WsServerMessage> = {}): WsServerMessage {
  return { type, ts: now(), ...extra }
}

/**
 * Verify a handshake token the same way `requireAuth` verifies a header.
 *
 * Returns null for every failure mode without distinguishing them — an
 * unauthenticated socket has no business learning whether a token was
 * expired, forged, or belonged to a banned account.
 */
async function authenticate(token: string | undefined): Promise<string | null> {
  if (!token) return null

  let userId: string
  try {
    const decoded = jwt.verify(token, ACCESS_SECRET) as { sub: string }
    userId = decoded.sub
  } catch {
    return null
  }

  const { rows } = await query<{ id: string; is_banned: boolean }>(
    'SELECT id, is_banned FROM users WHERE id = $1',
    [userId]
  )
  const user = rows[0]
  if (!user || user.is_banned) return null

  return user.id
}

/**
 * May this user watch this topic?
 *
 * Both topic kinds resolve to a request, and the predicate is in the SQL so
 * there is no fetched row to forget to compare. A vendor assigned to the job
 * is allowed too — they need tracking updates for their own booking.
 */
async function canSubscribe(userId: string, topic: WsTopic): Promise<boolean> {
  const { rows } = await query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM requests r
        WHERE r.id = $1
          AND (
            r.customer_id = $2
            OR r.confirmed_vendor_id IN (SELECT id FROM vendors WHERE user_id = $2)
          )
     ) AS allowed`,
    [topic.id, userId]
  )
  return rows[0]?.allowed === true
}

function parseClientMessage(raw: string): WsClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null

    const m = parsed as Record<string, unknown>
    if (m.action !== 'subscribe' && m.action !== 'unsubscribe' && m.action !== 'ping') {
      return null
    }

    if (m.action === 'ping') return { action: 'ping' }

    const t = m.topic as Record<string, unknown> | undefined
    if (!t || (t.kind !== 'booking' && t.kind !== 'tracking')) return null
    if (typeof t.id !== 'string' || t.id.length === 0 || t.id.length > 64) return null

    return { action: m.action, topic: { kind: t.kind, id: t.id } }
  } catch {
    return null
  }
}

export async function wsRoutes(app: FastifyInstance) {
  // Prod quiet clients and drop the ones that never answer. Registered on the
  // app so it stops with the server rather than outliving it.
  const heartbeat = setInterval(() => {
    hub.reapStale(IDLE_TIMEOUT_MS)
  }, HEARTBEAT_MS)

  app.addHook('onClose', async () => {
    clearInterval(heartbeat)
  })

  app.get<{ Querystring: { token?: string } }>(
    '/ws',
    { websocket: true },
    async (connection: SocketStream, req) => {
    const socket = connection.socket as unknown as Sendable

    const token = req.query?.token
    const userId = await authenticate(token)

    if (!userId) {
      // 1008 = policy violation. Closed immediately rather than left open in
      // an unauthenticated state.
      socket.close(1008, 'unauthorized')
      return
    }

    const conn = hub.add(userId, socket)
    logger.debug({ userId, connectionId: conn.id }, 'WS connected')

    const ws = connection.socket as unknown as {
      on(event: string, cb: (...args: unknown[]) => void): void
    }

    ws.on('message', (raw: unknown) => {
      void (async () => {
        hub.touch(conn.id)

        const text = String(raw)
        // A frame far larger than any legal message is not worth parsing.
        if (text.length > 4096) {
          hub.sendTo(conn.id, reply('error', { data: { reason: 'message_too_large' } }))
          return
        }

        const parsed = parseClientMessage(text)
        if (!parsed) {
          hub.sendTo(conn.id, reply('error', { data: { reason: 'malformed' } }))
          return
        }

        if (parsed.action === 'ping') {
          hub.sendTo(conn.id, reply('pong'))
          return
        }

        const topic = parsed.topic!

        if (parsed.action === 'unsubscribe') {
          hub.unsubscribe(conn.id, topic)
          hub.sendTo(conn.id, reply('unsubscribed', { topic }))
          return
        }

        // ── subscribe: authorize before recording ─────────────────────────
        const allowed = await canSubscribe(userId, topic).catch(() => false)
        if (!allowed) {
          // Same answer whether the booking is someone else's or does not
          // exist, so this cannot be used to discover ids.
          hub.sendTo(conn.id, reply('error', { topic, data: { reason: 'not_found' } }))
          return
        }

        if (!hub.subscribe(conn.id, topic)) {
          hub.sendTo(conn.id, reply('error', { topic, data: { reason: 'too_many_subscriptions' } }))
          return
        }

        hub.sendTo(conn.id, reply('subscribed', { topic }))
      })()
    })

    ws.on('pong', () => hub.touch(conn.id))

    ws.on('close', () => {
      hub.remove(conn.id)
      logger.debug({ connectionId: conn.id }, 'WS disconnected')
    })

    ws.on('error', (err: unknown) => {
      logger.debug({ connectionId: conn.id, err }, 'WS error')
      hub.remove(conn.id)
    })

    // Tell the client the socket is live and authenticated, so it knows to
    // (re)subscribe. On a reconnect this is its cue to refetch state.
    if (socket.readyState === WS_OPEN) {
      hub.sendTo(conn.id, reply('subscribed', { data: { ready: true } }))
    }
    }
  )
}
