/**
 * Publishing realtime events, and the Redis bridge that carries them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE AUTHORIZATION HAPPENS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Right here. Each `notify*` function resolves the audience — the set of user
 * ids allowed to hear about this booking — by querying the database, and the
 * hub delivers only to those users.
 *
 * That placement is deliberate. The receiving instance cannot re-check
 * ownership without a query per delivery, so the check has to happen once, at
 * publish time, in the only place that knows who owns what.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT GOES OVER THE WIRE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Identifiers, never state. `{ bookingId, phase }` — enough for the client to
 * know what to refetch, and to render a phase label without waiting. Not the
 * status, not the price, not the vendor. See WsServerMessage in
 * @locogi/types for why.
 */

import { redis } from '../lib/redis'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { hub, REDIS_CHANNEL, type WireEnvelope } from '../lib/ws-hub'
import type { TrackingPhase, WsServerMessage } from '@locogi/types'

// ─────────────────────────────────────────────────────────────────────────────
// The Redis bridge
// ─────────────────────────────────────────────────────────────────────────────

let subscriber: ReturnType<typeof redis.duplicate> | null = null

/**
 * Connect this instance to the cross-instance channel.
 *
 * node-redis puts a connection into subscriber mode exclusively — it can no
 * longer run ordinary commands — so this MUST be a duplicate. Sharing the
 * main client would break every rate-limit check and OTP read in the process.
 *
 * Failure is survivable: without the bridge the hub delivers locally, so
 * clients on this instance still get their nudges and everyone else falls
 * back to refetching. Realtime is an enhancement, not a dependency.
 */
export async function startRealtimeBridge(): Promise<void> {
  if (subscriber) return

  try {
    subscriber = redis.duplicate()
    subscriber.on('error', (err) => logger.error({ err }, 'Realtime subscriber error'))
    await subscriber.connect()

    await subscriber.subscribe(REDIS_CHANNEL, (payload: string) => {
      try {
        const envelope = JSON.parse(payload) as WireEnvelope
        hub.deliverLocal(envelope)
      } catch (err) {
        logger.warn({ err }, 'Unparseable realtime envelope')
      }
    })

    // The hub publishes through the MAIN client (which stays in normal mode)
    // and receives through the duplicate. One direction each.
    hub.setPublisher(redis)

    logger.info('Realtime bridge connected')
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : 'unknown' },
      'Realtime bridge unavailable — falling back to local-only delivery'
    )
    subscriber = null
    hub.setPublisher(null)
  }
}

export async function stopRealtimeBridge(): Promise<void> {
  hub.setPublisher(null)
  if (subscriber) {
    try {
      await subscriber.unsubscribe(REDIS_CHANNEL)
      await subscriber.quit()
    } catch {
      /* shutting down anyway */
    }
    subscriber = null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audience resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everyone entitled to hear about this booking: the customer, and the
 * assigned vendor's user if there is one.
 *
 * Returns an empty array on any failure, which means nobody is notified —
 * the correct direction to fail. A realtime nudge that does not arrive costs
 * a refresh; one that arrives at the wrong person is a data leak.
 */
async function audienceFor(requestId: string): Promise<string[]> {
  try {
    const { rows } = await query<{ user_id: string }>(
      `SELECT r.customer_id AS user_id
         FROM requests r WHERE r.id = $1
       UNION
       SELECT v.user_id
         FROM requests r
         JOIN vendors v ON v.id = r.confirmed_vendor_id
        WHERE r.id = $1`,
      [requestId]
    )
    return rows.map((r) => r.user_id)
  } catch (err) {
    logger.warn({ err, requestId }, 'Could not resolve realtime audience')
    return []
  }
}

function message(
  type: WsServerMessage['type'],
  kind: 'booking' | 'tracking',
  id: string,
  data?: Record<string, unknown>
): WsServerMessage {
  return { type, topic: { kind, id }, data, ts: new Date().toISOString() }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export class RealtimeService {
  /**
   * A booking changed in some way worth refetching.
   *
   * `reason` is a hint for logging and for the client to decide whether to
   * animate — never the new state itself.
   */
  async bookingChanged(requestId: string, reason: string): Promise<void> {
    const audience = await audienceFor(requestId)
    if (audience.length === 0) return

    await hub.publish(
      audience,
      message('booking.changed', 'booking', requestId, { bookingId: requestId, reason })
    )
  }

  /** The provider moved, or their phase changed. */
  async trackingUpdated(
    requestId: string,
    data: { phase?: TrackingPhase; movedAt?: string }
  ): Promise<void> {
    const audience = await audienceFor(requestId)
    if (audience.length === 0) return

    await hub.publish(
      audience,
      message('tracking.updated', 'tracking', requestId, {
        bookingId: requestId,
        ...data,
      })
    )
  }

  /** A vendor quoted on a request. */
  async quoteReceived(requestId: string): Promise<void> {
    const audience = await audienceFor(requestId)
    if (audience.length === 0) return

    await hub.publish(
      audience,
      message('quote.received', 'booking', requestId, { bookingId: requestId })
    )
  }

  /** Drop every socket for a user — called when an account is banned. */
  disconnectUser(userId: string, reason: string): number {
    return hub.closeUser(userId, reason)
  }
}

export const realtime = new RealtimeService()
