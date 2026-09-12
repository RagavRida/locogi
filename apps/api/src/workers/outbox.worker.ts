import { Worker } from 'bullmq'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { withCorrelation, newCorrelationId } from '../lib/correlation'
import { NotificationService } from '../services/notification.service'
import { realtime } from '../services/realtime.service'
import { WebhookService } from '../services/webhook.service'

const notifications = new NotificationService()
const webhooks = new WebhookService()
const MAX_RETRIES = 3

/**
 * Outbox pattern worker.
 *
 * Side effects (notifications, analytics) are written to outbox_events inside
 * the same DB transaction as the state change. This worker drains them.
 *
 * Guarantee: if the DB write succeeded, the side effect WILL eventually fire,
 * even if the process crashed immediately after the transaction committed.
 */
export const outboxWorker = new Worker(
  'outbox',
  async () => {
    const pending = await query<{
      id: string
      event_type: string
      payload: Record<string, unknown>
      retry_count: number
      correlation_id: string | null
    }>(
      `SELECT id, event_type, payload, retry_count, correlation_id
       FROM outbox_events
       WHERE status = 'pending' AND retry_count < $1
       ORDER BY created_at ASC
       LIMIT 50`,
      [MAX_RETRIES]
    )

    if (pending.rows.length === 0) return

    for (const event of pending.rows) {
      // ── Re-establish the trace across the commit boundary ────────────────
      //
      // AsyncLocalStorage cannot reach here: this runs minutes after the
      // request that enqueued the event, possibly in a different process.
      // Reading the id off the row is what keeps "chat message → booking →
      // push notification" one traceable journey instead of two unrelated
      // sets of log lines.
      //
      // A row with no correlation id predates migration 015 or was written
      // outside a request. It gets a fresh id so the event's own processing
      // is still traceable — just not linked to a cause.
      await withCorrelation(
        {
          correlationId: event.correlation_id ?? newCorrelationId(),
          source: 'worker',
          operation: `outbox:${event.event_type}`,
        },
        async () => {
      try {
        await processEvent(event.event_type, event.payload)

        // ── Fan out to webhooks ──────────────────────────────────────────
        // Every outbox event is a potential webhook trigger. The webhook
        // service checks if any org has subscriptions for this event type.
        await fanOutToWebhooks(event.event_type, event.payload)

        await query(
          `UPDATE outbox_events
           SET status = 'sent', processed_at = now()
           WHERE id = $1`,
          [event.id]
        )
      } catch (err) {
        const nextRetry = event.retry_count + 1
        const failed = nextRetry >= MAX_RETRIES

        await query(
          `UPDATE outbox_events
           SET retry_count = $1,
                status = $2,
                processed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
           WHERE id = $3`,
          [nextRetry, failed ? 'failed' : 'pending', event.id]
        )

        logger.error(
          { eventId: event.id, type: event.event_type, retry: nextRetry, err },
          failed ? 'Outbox event dead-lettered' : 'Outbox event retry scheduled'
        )
      }
        }
      )
    }

    logger.debug({ processed: pending.rows.length }, 'Outbox drained')
  },
  { connection: { url: process.env.REDIS_URL! } }
)

async function processEvent(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  switch (eventType) {
    case 'notification_failed': {
      // Retry a notification that failed on all channels earlier
      const { userId, payload: notifPayload } = payload as {
        userId: string
        payload: { title: string; body: string; data?: Record<string, unknown> }
      }
      await notifications.deliver(userId, notifPayload, true)
      break
    }

    case 'booking_confirmed': {
      const { requestId } = payload as { requestId: string }
      await notifications.notifyBookingConfirmed(requestId)
      // Nudge any open socket so a screen showing this booking updates
      // without waiting for the user to pull to refresh. Additive: the push
      // notification above is unchanged and remains the reliable path.
      await realtime.bookingChanged(requestId, 'confirmed')
      break
    }

    case 'slot_freed': {
      // A cancellation or reschedule freed a slot — offer it to the waitlist
      const { slotId } = payload as { slotId: string }
      const { BookingLifecycleService } = await import(
        '../services/booking-lifecycle.service'
      )
      await new BookingLifecycleService().offerFreedSlot(slotId)
      break
    }

    case 'booking_disrupted': {
      const { requestId, customerId, reason } = payload as {
        requestId: string
        customerId: string
        reason: string
      }
      await notifications.deliver(
        customerId,
        {
          title: '⚠️ Your booking was cancelled by the vendor',
          body: `${reason}. Tap to pick another time or find someone else.`,
          data: {
            type: 'disrupted',
            requestId,
            deepLink: `locogi://chat/${requestId}`,
          },
        },
        true // critical — falls through to WhatsApp if push fails
      )
      await realtime.bookingChanged(requestId, 'disrupted')
      break
    }

    // ── Platform events (from the B2B API) ────────────────────────────────
    case 'booking_created_platform':
    case 'booking_confirmed_platform':
    case 'booking_cancelled_platform':
    case 'booking_completed_platform': {
      // These are handled purely by webhook fan-out below.
      // No push notification needed — the business's system handles it.
      const { requestId } = payload as { requestId: string }
      logger.info({ requestId, eventType }, '[platform] event processed')
      break
    }

    default:
      logger.warn({ eventType }, 'Unknown outbox event type — marking sent')
  }
}

/**
 * Fan out an outbox event to all matching webhook subscriptions.
 *
 * Maps internal event types (e.g. "booking_confirmed") to webhook event
 * types (e.g. "booking.confirmed") and enqueues deliveries.
 */
async function fanOutToWebhooks(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  // Map internal event types to webhook event types
  const eventMap: Record<string, string> = {
    'booking_confirmed': 'booking.confirmed',
    'booking_disrupted': 'booking.cancelled',
    'slot_freed': 'booking.rescheduled',
    'booking_created_platform': 'booking.created',
    'booking_confirmed_platform': 'booking.confirmed',
    'booking_cancelled_platform': 'booking.cancelled',
    'booking_completed_platform': 'booking.completed',
  }

  const webhookEventType = eventMap[eventType]
  if (!webhookEventType) return // not a webhook-worthy event

  // Determine the org ID from the payload
  const orgId = (payload.organizationId ?? payload.orgId) as string | undefined
  if (!orgId) {
    // Try to look up from the request
    const requestId = payload.requestId as string | undefined
    if (!requestId) return

    const result = await query<{ organization_id: string }>(
      `SELECT om.organization_id
       FROM requests r
       JOIN organization_members om ON om.user_id = r.confirmed_vendor_id
       WHERE r.id = $1
       LIMIT 1`,
      [requestId]
    )

    if (result.rows.length === 0) return

    await webhooks.enqueueDeliveries(
      result.rows[0].organization_id,
      webhookEventType,
      payload
    )
    return
  }

  await webhooks.enqueueDeliveries(orgId, webhookEventType, payload)
}

