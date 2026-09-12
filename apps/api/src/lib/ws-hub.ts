/**
 * The realtime hub: who is connected, what they watch, and how a message
 * reaches them across processes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS EXISTS TO SOLVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A WebSocket lives in ONE process. The outbox worker that learns a booking
 * was confirmed may be running in a different one. Without a bridge, a user
 * connected to instance B never hears about an event processed on instance A,
 * and the bug is invisible on a single-instance dev machine — it appears only
 * once you scale, intermittently, for some users.
 *
 * So every publish goes through Redis pub/sub. Each instance subscribes, and
 * delivers to whichever of its own sockets care. Publishing locally as well
 * would double-deliver, so it does not: the local instance receives its own
 * message back through Redis like everyone else. One path, always.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No delivery guarantee, no replay buffer, no missed-event cursor. Messages
 * are invalidation nudges (see WsServerMessage in @locogi/types) and the
 * client refetches from Postgres on reconnect. Building at-least-once
 * delivery over a socket means an ack protocol, a per-client outbox and an
 * ordering guarantee — a lot of machinery to duplicate what a refetch does
 * for free.
 *
 * It also holds no business state. The hub knows socket ids and topic
 * strings; it has never heard of a booking.
 */

import type { WsServerMessage, WsTopic } from '@locogi/types'
import { logger } from './logger'

/** The bit of a WebSocket the hub actually uses, so tests need no server. */
export interface Sendable {
  send(data: string): void
  close(code?: number, reason?: string): void
  readyState: number
}

/** ws.OPEN. Hardcoded so this module needs no import from `ws`. */
export const WS_OPEN = 1

export interface Connection {
  id: string
  userId: string
  socket: Sendable
  topics: Set<string>
  /** Last time we saw any evidence this peer is alive. */
  lastSeenAt: number
}

/** Canonical string for a topic, so subscriptions dedupe correctly. */
export function topicKey(topic: WsTopic): string {
  return `${topic.kind}:${topic.id}`
}

export const REDIS_CHANNEL = 'locogi:ws'

/**
 * What crosses Redis: the message plus who may see it.
 *
 * `audience` is a list of user ids, resolved by the PUBLISHER against the
 * database. Receiving instances do not re-check — they cannot, cheaply,
 * without a query per delivery. That places the authorization boundary at
 * publish time, which is the only place that knows who owns the booking.
 */
export interface WireEnvelope {
  audience: string[]
  message: WsServerMessage
}

export interface HubPublisher {
  publish(channel: string, payload: string): Promise<unknown>
}

export class WebSocketHub {
  private readonly connections = new Map<string, Connection>()

  /** topicKey → connection ids. Reverse index so fan-out is O(subscribers). */
  private readonly byTopic = new Map<string, Set<string>>()

  /** userId → connection ids. One person, several devices. */
  private readonly byUser = new Map<string, Set<string>>()

  private publisher: HubPublisher | null = null
  private seq = 0

  /** Wire up the cross-instance bridge. Without it, delivery is local only. */
  setPublisher(publisher: HubPublisher | null): void {
    this.publisher = publisher
  }

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  add(userId: string, socket: Sendable): Connection {
    const id = `c${++this.seq}_${Date.now().toString(36)}`
    const conn: Connection = {
      id,
      userId,
      socket,
      topics: new Set(),
      lastSeenAt: Date.now(),
    }

    this.connections.set(id, conn)

    let userConns = this.byUser.get(userId)
    if (!userConns) {
      userConns = new Set()
      this.byUser.set(userId, userConns)
    }
    userConns.add(id)

    return conn
  }

  /**
   * Forget a connection and every index entry pointing at it.
   *
   * Leaking here is not benign: a stale id in `byTopic` means every future
   * fan-out on that topic does a map lookup that misses, and the sets grow
   * without bound for the life of the process.
   */
  remove(connectionId: string): void {
    const conn = this.connections.get(connectionId)
    if (!conn) return

    for (const key of conn.topics) {
      const subs = this.byTopic.get(key)
      if (subs) {
        subs.delete(connectionId)
        if (subs.size === 0) this.byTopic.delete(key)
      }
    }

    const userConns = this.byUser.get(conn.userId)
    if (userConns) {
      userConns.delete(connectionId)
      if (userConns.size === 0) this.byUser.delete(conn.userId)
    }

    this.connections.delete(connectionId)
  }

  get(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId)
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────────

  /**
   * Subscribe a connection to a topic.
   *
   * Authorization is the CALLER's job and happens before this — the hub has
   * no idea who owns a booking. The route checks ownership, then calls this.
   */
  subscribe(connectionId: string, topic: WsTopic): boolean {
    const conn = this.connections.get(connectionId)
    if (!conn) return false

    // A bounded number of topics per connection. Without a cap, a malicious
    // client could subscribe to millions of ids and exhaust memory — each
    // one is cheap, but nothing else stops them.
    if (conn.topics.size >= MAX_TOPICS_PER_CONNECTION) {
      logger.warn(
        { userId: conn.userId, topics: conn.topics.size },
        'WS subscription limit reached'
      )
      return false
    }

    const key = topicKey(topic)
    conn.topics.add(key)

    let subs = this.byTopic.get(key)
    if (!subs) {
      subs = new Set()
      this.byTopic.set(key, subs)
    }
    subs.add(connectionId)
    return true
  }

  unsubscribe(connectionId: string, topic: WsTopic): void {
    const conn = this.connections.get(connectionId)
    if (!conn) return

    const key = topicKey(topic)
    conn.topics.delete(key)

    const subs = this.byTopic.get(key)
    if (subs) {
      subs.delete(connectionId)
      if (subs.size === 0) this.byTopic.delete(key)
    }
  }

  // ─── Delivery ──────────────────────────────────────────────────────────────

  /**
   * Publish to every instance.
   *
   * Goes out over Redis even when the recipient is connected to THIS process.
   * Delivering locally as well would double-send, and "sometimes twice" is a
   * far nastier bug than "always once" — it only shows up when the sender and
   * receiver happen to share an instance.
   *
   * Falls back to local delivery only when there is no publisher at all
   * (single-process dev, or Redis down), where double delivery is impossible.
   */
  async publish(audience: string[], message: WsServerMessage): Promise<void> {
    if (audience.length === 0) return

    const envelope: WireEnvelope = { audience, message }

    if (!this.publisher) {
      this.deliverLocal(envelope)
      return
    }

    try {
      await this.publisher.publish(REDIS_CHANNEL, JSON.stringify(envelope))
    } catch (err) {
      // Realtime is an enhancement; the REST API still works. Deliver to
      // whoever is local and log, rather than failing the caller's request.
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'WS publish over Redis failed — delivering locally only'
      )
      this.deliverLocal(envelope)
    }
  }

  /**
   * Deliver a message that arrived from Redis (or locally in the fallback).
   *
   * Two filters, both required: the connection must be subscribed to the
   * topic AND belong to a user in the audience. Topic alone is not enough —
   * a client could subscribe to a guessed booking id, and the audience check
   * is what makes that useless.
   */
  deliverLocal(envelope: WireEnvelope): number {
    const { audience, message } = envelope
    const allowed = new Set(audience)

    // A message with no topic (a broadcast to a user, e.g. pong) goes to all
    // of that user's connections.
    const targets: Connection[] = []

    if (message.topic) {
      const subs = this.byTopic.get(topicKey(message.topic))
      if (!subs) return 0
      for (const id of subs) {
        const conn = this.connections.get(id)
        if (conn && allowed.has(conn.userId)) targets.push(conn)
      }
    } else {
      for (const userId of audience) {
        for (const id of this.byUser.get(userId) ?? []) {
          const conn = this.connections.get(id)
          if (conn) targets.push(conn)
        }
      }
    }

    let sent = 0
    const payload = JSON.stringify(message)

    for (const conn of targets) {
      if (conn.socket.readyState !== WS_OPEN) continue
      try {
        conn.socket.send(payload)
        sent++
      } catch (err) {
        // A send that throws means the peer is gone in a way the readyState
        // has not caught up with. Drop it rather than retrying into a void.
        logger.debug({ connectionId: conn.id }, 'WS send failed; dropping connection')
        this.remove(conn.id)
      }
    }

    return sent
  }

  /** Send directly to one connection — acks, errors, pong. */
  sendTo(connectionId: string, message: WsServerMessage): boolean {
    const conn = this.connections.get(connectionId)
    if (!conn || conn.socket.readyState !== WS_OPEN) return false
    try {
      conn.socket.send(JSON.stringify(message))
      return true
    } catch {
      this.remove(connectionId)
      return false
    }
  }

  // ─── Liveness ──────────────────────────────────────────────────────────────

  touch(connectionId: string): void {
    const conn = this.connections.get(connectionId)
    if (conn) conn.lastSeenAt = Date.now()
  }

  /**
   * Close connections that have gone quiet.
   *
   * A TCP connection to a device that lost signal in a lift can stay "open"
   * for a very long time. Without this, those accumulate — each holding a
   * socket, a heap entry and a slot in every topic it subscribed to.
   */
  reapStale(maxIdleMs: number, now = Date.now()): number {
    const dead: string[] = []
    for (const conn of this.connections.values()) {
      if (now - conn.lastSeenAt > maxIdleMs) dead.push(conn.id)
    }

    for (const id of dead) {
      const conn = this.connections.get(id)
      try {
        conn?.socket.close(1001, 'idle timeout')
      } catch {
        /* already gone */
      }
      this.remove(id)
    }

    if (dead.length > 0) logger.debug({ reaped: dead.length }, 'Reaped stale WS connections')
    return dead.length
  }

  // ─── Introspection, for /healthz and tests ────────────────────────────────

  stats(): { connections: number; users: number; topics: number } {
    return {
      connections: this.connections.size,
      users: this.byUser.size,
      topics: this.byTopic.size,
    }
  }

  /** Every connection belonging to a user — used to disconnect on ban. */
  closeUser(userId: string, reason = 'session ended'): number {
    const ids = [...(this.byUser.get(userId) ?? [])]
    for (const id of ids) {
      const conn = this.connections.get(id)
      try {
        conn?.socket.close(1008, reason)
      } catch {
        /* already gone */
      }
      this.remove(id)
    }
    return ids.length
  }
}

/**
 * Cap on distinct topics one socket may watch.
 *
 * Nothing else bounds it: subscribing is cheap for the client and costs the
 * server a set entry each time, so an unbounded client is a memory attack.
 * A real user watches a handful of bookings.
 */
export const MAX_TOPICS_PER_CONNECTION = 50

/** Process-wide hub. */
export const hub = new WebSocketHub()
