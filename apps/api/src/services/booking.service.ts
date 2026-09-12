/**
 * BookingService — the two atomic claims that money and trust depend on.
 *
 * This service now orchestrates repositories rather than writing SQL. The
 * atomicity guarantees are unchanged; what changed is that the SQL enforcing
 * them lives in one place, so a future feature cannot accidentally write a
 * different table for the same concept (which is exactly how the slot
 * split-brain happened — see migration 010).
 *
 * TRANSACTION DISCIPLINE
 * ──────────────────────
 * Both methods wrap their work in withTransaction and pass txExecutor(client)
 * to every repository call. Omitting the executor would silently route the
 * write to a pooled connection OUTSIDE the transaction — the code would look
 * correct, the tests might pass under low concurrency, and the atomicity
 * would be gone. That is the one mistake this file must not make.
 */

import { withTransaction } from '../lib/db'
import { logger } from '../lib/logger'
import { requestRepo, bookingRepo, txExecutor } from '../repositories'
import type { ResourceSlot } from '@locogi/types'

export class BookingService {

  // ═══════════════════════════════════════════════════════════════════════════
  // QUOTE CONFIRMATION — the race-lock
  // ═══════════════════════════════════════════════════════════════════════════
  /**
   * Exactly one vendor can win a request. Every other concurrent caller gets
   * success: false and must be told the quote is gone.
   *
   * The guarantee comes from a single UPDATE whose WHERE clause names the only
   * legal predecessor states. Postgres serialises the row lock; rowCount tells
   * us who won.
   */
  async confirmQuote(
    requestId: string,
    responseId: string,
    agreedPrice: number,
    idempotencyKey: string
  ): Promise<{ success: boolean; reason?: 'lost_race' | 'invalid_response' }> {
    return withTransaction(async (client) => {
      const tx = txExecutor(client)

      // Idempotent retry — a client re-sending after a dropped response gets
      // success, not a spurious conflict.
      if (await requestRepo.wasAlreadyConfirmed(idempotencyKey, tx)) {
        return { success: true }
      }

      const vendorId = await bookingRepo.findVendorIdForResponse(responseId, tx)
      if (!vendorId) {
        return { success: false, reason: 'invalid_response' as const }
      }

      // ── THE LOCK ──────────────────────────────────────────────────────────
      const won = await requestRepo.confirmWithVendor(
        { requestId, vendorId, agreedPrice, idempotencyKey },
        tx
      )

      if (!won) {
        logger.info(
          { requestId, vendorId },
          'Quote confirmation lost the race — already confirmed'
        )
        return { success: false, reason: 'lost_race' as const }
      }

      await bookingRepo.markResponseConfirmed(responseId, tx)
      const missed = await bookingRepo.markOthersMissed(requestId, responseId, tx)

      logger.info(
        { requestId, vendorId, agreedPrice, othersMissed: missed },
        'Quote confirmed'
      )
      return { success: true }
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLOT BOOKING
  // ═══════════════════════════════════════════════════════════════════════════
  /**
   * Claim a slot and link it to the request in one transaction.
   *
   * Both writes must commit together. If the slot were claimed but the request
   * link failed, capacity would be consumed by a booking that no downstream
   * job can see — which is precisely the failure mode migration 010 repaired.
   */
  async bookSlot(
    slotId: string,
    requestId: string,
    idempotencyKey: string
  ): Promise<{ success: boolean; slot?: ResourceSlot }> {
    return withTransaction(async (client) => {
      const tx = txExecutor(client)

      const slot = await bookingRepo.claimSlot(slotId, tx)
      if (!slot) {
        // Full, cancelled, past, or absent — not distinguished on purpose.
        return { success: false }
      }

      // resource_slot_id is what appointment reminders, no-show detection,
      // reschedule, waitlist auto-offer and travel feasibility all join on.
      const linked = await requestRepo.confirmWithSlot(requestId, slotId, tx)

      if (!linked) {
        // The request moved out of a bookable state between the caller's read
        // and this write. Throwing rolls back the claim so capacity is not
        // leaked to a booking that will never exist.
        logger.warn(
          { requestId, slotId },
          'Slot claimed but request was no longer bookable — rolling back'
        )
        throw new BookingStateError(
          'Request is no longer in a bookable state'
        )
      }

      logger.info(
        { slotId, requestId, slotTime: slot.slotTime },
        'Slot booked and linked to request'
      )
      return { success: true, slot }
    }).catch((err) => {
      if (err instanceof BookingStateError) return { success: false }
      throw err
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // JOB PROGRESSION
  // ═══════════════════════════════════════════════════════════════════════════
  /**
   * Advance a confirmed job. Legal predecessors are enforced in the repository
   * so an out-of-order call is a no-op rather than a corruption.
   *
   * Note: userId is accepted for the audit trail and for the authorization
   * check that belongs here once the RBAC layer lands. It is deliberately not
   * used as a filter yet — the routes still own that check, and moving it
   * silently would create a gap.
   */
  async advanceStage(
    requestId: string,
    stage: 'in_progress' | 'completed',
    userId: string
  ): Promise<boolean> {
    const advanced = await requestRepo.advanceStage(requestId, stage)

    if (advanced) {
      logger.info({ requestId, stage, userId }, 'Job stage advanced')
    }
    return advanced
  }
}

/** Internal signal for rolling back a partially-completed slot booking. */
class BookingStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BookingStateError'
  }
}
