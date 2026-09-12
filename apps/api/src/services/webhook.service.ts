/**
 * WebhookService — register, deliver, and manage webhook subscriptions.
 *
 * Webhook delivery is async: events are written to `webhook_deliveries` and
 * the webhook worker drains them with exponential backoff.
 *
 * Signature verification uses HMAC-SHA256:
 *   signature = HMAC-SHA256(signing_secret, "{timestamp}.{payload}")
 *
 * The receiving server verifies:
 *   1. Compute expected = HMAC-SHA256(secret, header_timestamp + "." + body)
 *   2. Compare with the X-Locogi-Signature header
 *   3. Reject if timestamp is > 5 minutes old (replay protection)
 */

import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { generateSigningSecret, signWebhookPayload } from '../lib/api-key'

// ─── Event types that can be subscribed to ──────────────────────────────────
export const WEBHOOK_EVENTS = [
  'booking.created',
  'booking.confirmed',
  'booking.cancelled',
  'booking.completed',
  'booking.rescheduled',
  'booking.no_show',
  'order.placed',
  'order.ready',
  'order.picked_up',
  'order.delivered',
  'payment.received',
  'payment.refunded',
  'resource.updated',
  'catalog.updated',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export function isWebhookEvent(v: string): v is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(v)
}

// ─── Subscription types ─────────────────────────────────────────────────────
export interface WebhookSubscription {
  id: string
  organizationId: string
  url: string
  events: WebhookEvent[]
  isActive: boolean
  description: string | null
  consecutiveFailures: number
  lastDeliveryAt: string | null
  createdAt: string
}

export class WebhookService {

  // ─── Register a new webhook ─────────────────────────────────────────────
  async register(params: {
    organizationId: string
    url: string
    events?: WebhookEvent[]
    description?: string
  }): Promise<{ subscription: WebhookSubscription; signingSecret: string }> {
    const secret = generateSigningSecret()

    const result = await query<{
      id: string
      organization_id: string
      url: string
      events: string[]
      is_active: boolean
      description: string | null
      consecutive_failures: number
      last_delivery_at: string | null
      created_at: string
      signing_secret: string
    }>(
      `INSERT INTO webhook_subscriptions
         (organization_id, url, events, signing_secret, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        params.organizationId,
        params.url,
        params.events ?? WEBHOOK_EVENTS,
        secret,
        params.description ?? null,
      ]
    )

    const row = result.rows[0]
    return {
      subscription: this.toSubscription(row),
      signingSecret: secret, // shown once, never stored in plaintext again... wait, it IS stored. That's fine for HMAC secrets.
    }
  }

  // ─── List webhooks for an org ───────────────────────────────────────────
  async listForOrg(organizationId: string): Promise<WebhookSubscription[]> {
    const result = await query<any>(
      `SELECT * FROM webhook_subscriptions
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [organizationId]
    )
    return result.rows.map(this.toSubscription)
  }

  // ─── Delete a webhook ──────────────────────────────────────────────────
  async remove(subscriptionId: string, organizationId: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM webhook_subscriptions
       WHERE id = $1 AND organization_id = $2`,
      [subscriptionId, organizationId]
    )
    return (result.rowCount ?? 0) > 0
  }

  // ─── Enqueue a webhook delivery ────────────────────────────────────────
  //
  // Called by the outbox worker when it processes an event. Finds all
  // subscriptions for the org that listen to this event type.
  async enqueueDeliveries(
    organizationId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<number> {
    // Find matching subscriptions
    const subs = await query<{
      id: string
      url: string
      signing_secret: string
    }>(
      `SELECT id, url, signing_secret
       FROM webhook_subscriptions
       WHERE organization_id = $1
         AND is_active = true
         AND $2 = ANY(events)
         AND disabled_at IS NULL`,
      [organizationId, eventType]
    )

    if (subs.rows.length === 0) return 0

    // Create delivery records for each subscription
    for (const sub of subs.rows) {
      await query(
        `INSERT INTO webhook_deliveries
           (subscription_id, organization_id, event_type, payload, next_retry_at)
         VALUES ($1, $2, $3, $4, now())`,
        [sub.id, organizationId, eventType, JSON.stringify(payload)]
      )
    }

    logger.info(
      { organizationId, eventType, subscriptions: subs.rows.length },
      '[webhook] deliveries enqueued'
    )

    return subs.rows.length
  }

  // ─── Deliver a single webhook (called by the worker) ───────────────────
  async deliver(deliveryId: string): Promise<boolean> {
    const result = await query<{
      id: string
      subscription_id: string
      organization_id: string
      event_type: string
      payload: Record<string, unknown>
      attempt: number
      max_attempts: number
    }>(
      `SELECT d.*, s.url, s.signing_secret
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.subscription_id
       WHERE d.id = $1`,
      [deliveryId]
    )

    const delivery = result.rows[0] as any
    if (!delivery) return false

    const timestamp = Math.floor(Date.now() / 1000)
    const payloadStr = JSON.stringify({
      id: delivery.id,
      type: delivery.event_type,
      data: delivery.payload,
      created_at: new Date().toISOString(),
    })

    const signature = signWebhookPayload(payloadStr, delivery.signing_secret, timestamp)

    const start = Date.now()
    try {
      const response = await fetch(delivery.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Locogi-Signature': signature,
          'X-Locogi-Timestamp': String(timestamp),
          'X-Locogi-Event': delivery.event_type,
          'X-Locogi-Delivery-Id': delivery.id,
          'User-Agent': 'Locogi-Webhooks/1.0',
        },
        body: payloadStr,
        signal: AbortSignal.timeout(10_000), // 10s timeout
      })

      const responseTimeMs = Date.now() - start
      const responseBody = await response.text().catch(() => '')

      if (response.ok) {
        // Success
        await query(
          `UPDATE webhook_deliveries
           SET status = 'sent', http_status = $1, response_body = $2,
               response_time_ms = $3, delivered_at = now(), attempt = attempt + 1
           WHERE id = $4`,
          [response.status, responseBody.slice(0, 500), responseTimeMs, deliveryId]
        )

        // Reset consecutive failure counter on the subscription
        await query(
          `UPDATE webhook_subscriptions
           SET consecutive_failures = 0, last_delivery_at = now()
           WHERE id = $1`,
          [delivery.subscription_id]
        )

        return true
      } else {
        // HTTP error
        await this.recordFailure(
          deliveryId,
          delivery.subscription_id,
          delivery.attempt + 1,
          delivery.max_attempts,
          response.status,
          `HTTP ${response.status}: ${responseBody.slice(0, 200)}`,
          responseTimeMs
        )
        return false
      }
    } catch (err) {
      const responseTimeMs = Date.now() - start
      const message = err instanceof Error ? err.message : 'Unknown error'

      await this.recordFailure(
        deliveryId,
        delivery.subscription_id,
        delivery.attempt + 1,
        delivery.max_attempts,
        null,
        message,
        responseTimeMs
      )
      return false
    }
  }

  // ─── Record a failed delivery with exponential backoff ─────────────────
  private async recordFailure(
    deliveryId: string,
    subscriptionId: string,
    attempt: number,
    maxAttempts: number,
    httpStatus: number | null,
    errorMessage: string,
    responseTimeMs: number
  ): Promise<void> {
    const isDead = attempt >= maxAttempts

    // Exponential backoff: 10s, 30s, 90s, 270s, 810s
    const backoffSeconds = isDead ? 0 : 10 * Math.pow(3, attempt - 1)

    await query(
      `UPDATE webhook_deliveries
       SET status = $1, http_status = $2, error_message = $3,
           response_time_ms = $4, attempt = $5,
           next_retry_at = CASE WHEN $1 = 'pending' THEN now() + interval '1 second' * $6 ELSE NULL END
       WHERE id = $7`,
      [
        isDead ? 'dead_lettered' : 'pending',
        httpStatus,
        errorMessage,
        responseTimeMs,
        attempt,
        backoffSeconds,
        deliveryId,
      ]
    )

    // Track consecutive failures on the subscription
    await query(
      `UPDATE webhook_subscriptions
       SET consecutive_failures = consecutive_failures + 1,
           last_failure_at = now()
       WHERE id = $1`,
      [subscriptionId]
    )

    // Auto-disable after 50 consecutive failures
    await query(
      `UPDATE webhook_subscriptions
       SET disabled_at = now(),
           disabled_reason = 'Auto-disabled after 50 consecutive delivery failures',
           is_active = false
       WHERE id = $1 AND consecutive_failures >= 50 AND disabled_at IS NULL`,
      [subscriptionId]
    )

    logger.warn(
      { deliveryId, subscriptionId, attempt, isDead, errorMessage },
      isDead ? '[webhook] delivery dead-lettered' : '[webhook] delivery retry scheduled'
    )
  }

  // ─── Row mapper ────────────────────────────────────────────────────────
  private toSubscription(row: any): WebhookSubscription {
    return {
      id: row.id,
      organizationId: row.organization_id,
      url: row.url,
      events: row.events,
      isActive: row.is_active,
      description: row.description,
      consecutiveFailures: row.consecutive_failures,
      lastDeliveryAt: row.last_delivery_at,
      createdAt: row.created_at,
    }
  }
}
