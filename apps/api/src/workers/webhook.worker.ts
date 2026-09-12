/**
 * Webhook delivery worker.
 *
 * Drains pending webhook_deliveries every 5 seconds, delivering each one
 * via the WebhookService. Failed deliveries are retried with exponential
 * backoff (handled by the service).
 */

import { Worker } from 'bullmq'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { WebhookService } from '../services/webhook.service'

const webhooks = new WebhookService()

export const webhookWorker = new Worker(
  'webhooks',
  async () => {
    const pending = await query<{ id: string }>(
      `SELECT id FROM webhook_deliveries
       WHERE status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= now())
       ORDER BY created_at ASC
       LIMIT 20`
    )

    if (pending.rows.length === 0) return

    let delivered = 0
    let failed = 0

    for (const row of pending.rows) {
      const ok = await webhooks.deliver(row.id)
      if (ok) delivered++
      else failed++
    }

    if (delivered > 0 || failed > 0) {
      logger.info({ delivered, failed }, '[webhook-worker] batch complete')
    }
  },
  { connection: { url: process.env.REDIS_URL! } }
)
