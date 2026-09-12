import { Worker } from 'bullmq'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { QUOTABLE_STATES } from '../domain/request-state'
import { requestRepo } from '../repositories'
import { MatchingService } from '../services/matching.service'
import { NotificationService } from '../services/notification.service'

const matching = new MatchingService()
const notifications = new NotificationService()

export const expiryWorker = new Worker(
  'expiry',
  async () => {
    // ── Stage 1: requests past expiry that still have rematch attempts left ──
    const rematchable = await query<{
      id: string
      customer_id: string
      category_tags: string[]
      rematching_attempt: number
    }>(
      `SELECT id, customer_id, category_tags, rematching_attempt
       FROM requests
       WHERE status = ANY($1::text[])
         AND expires_at < now()
         AND rematching_attempt < 2`,
      [QUOTABLE_STATES]
    )

    for (const req of rematchable.rows) {
      const nextAttempt = req.rematching_attempt + 1

      // Widen the search radius and try again
      const vendors = await matching.rematch(req.id, nextAttempt)

      if (vendors.length > 0) {
        await query(
          `UPDATE requests
           SET rematching_attempt = $1,
               expires_at = now() + interval '2 hours'
           WHERE id = $2`,
          [nextAttempt, req.id]
        )

        for (const v of vendors) {
          await query(
            `INSERT INTO request_responses (request_id, vendor_id, status)
             VALUES ($1, $2, 'pending')
             ON CONFLICT (request_id, vendor_id) DO NOTHING`,
            [req.id, v.id]
          )
        }

        await notifications.notifyVendorsOfRequest(
          vendors,
          req.id,
          'Request reopened — wider area',
          'quote'
        )

        logger.info(
          { requestId: req.id, attempt: nextAttempt, found: vendors.length },
          'Request rematched with wider radius'
        )
      } else {
        // No more vendors to try — bump the counter so it expires next sweep
        await query(
          'UPDATE requests SET rematching_attempt = 2 WHERE id = $1',
          [req.id]
        )
      }
    }

    // ── Stage 2: fully exhausted requests → expire them ─────────────────────
    const expired = await requestRepo.expireExhausted(2)

    for (const req of expired) {
      await query(
        `UPDATE request_responses SET status = 'missed'
         WHERE request_id = $1 AND status = 'pending'`,
        [req.id]
      )
      await notifications.notifyRequestExpired(req.id, req.customerId)
    }

    if (expired.length > 0 || rematchable.rows.length > 0) {
      logger.info(
        { expired: expired.length, rematched: rematchable.rows.length },
        'Expiry sweep complete'
      )
    }
  },
  { connection: { url: process.env.REDIS_URL! } }
)
