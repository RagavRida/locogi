/**
 * BookingLifecycleService — everything that happens to a booking after
 * confirmation and before completion.
 *
 * The original model had exactly two post-confirmation transitions:
 * in_progress and completed. Reality has many more, and each one that's
 * missing is a support ticket or a lost customer.
 */

import type { PoolClient } from 'pg'
import { query, withTransaction } from '../lib/db'
import { logger } from '../lib/logger'
import { enqueueOutbox } from '../lib/outbox'
import { vendorRepo, requestRepo, txExecutor } from '../repositories'
import { NotificationService } from './notification.service'

const notifications = new NotificationService()

export interface RescheduleResult {
  success: boolean
  reason?: 'not_found' | 'too_late' | 'limit_reached' | 'slot_taken' | 'not_reschedulable'
  message: string
  newSlotTime?: string
}

export class BookingLifecycleService {

  // ═══════════════════════════════════════════════════════════════════════════
  // RESCHEDULE — atomic slot swap
  // ═══════════════════════════════════════════════════════════════════════════
  async reschedule(params: {
    requestId: string
    newSlotId: string
    initiatedBy: 'customer' | 'vendor'
    userId: string
    reason?: string
  }): Promise<RescheduleResult> {

    return withTransaction<RescheduleResult>(async (client) => {
      // Lock the request row so a concurrent cancel can't race us
      const reqResult = await client.query<{
        id: string
        status: string
        resource_slot_id: string | null
        reschedule_count: number
        customer_id: string
        confirmed_vendor_id: string | null
        slot_time: string | null
      }>(
        `SELECT r.id, r.status, r.resource_slot_id, r.reschedule_count,
                r.customer_id, r.confirmed_vendor_id, rs.slot_time
         FROM requests r
         LEFT JOIN resource_slots rs ON rs.id = r.resource_slot_id
         WHERE r.id = $1
         FOR UPDATE OF r`,
        [params.requestId]
      )

      const booking = reqResult.rows[0]
      if (!booking) {
        return { success: false, reason: 'not_found', message: 'Booking not found.' }
      }

      if (!['confirmed', 'disrupted'].includes(booking.status)) {
        return {
          success: false,
          reason: 'not_reschedulable',
          message: `A booking that is ${booking.status} cannot be rescheduled.`,
        }
      }

      // ── Policy checks ───────────────────────────────────────────────────
      const policy = await this.getPolicy(client, params.requestId)

      if (booking.reschedule_count >= policy.maxReschedules) {
        return {
          success: false,
          reason: 'limit_reached',
          message:
            `This booking has already been moved ${booking.reschedule_count} times. ` +
            `Please cancel and book fresh, or message the vendor directly.`,
        }
      }

      // Customers must give notice; vendors may reschedule any time (their
      // disruption, their problem to communicate)
      if (params.initiatedBy === 'customer' && booking.slot_time) {
        const hoursUntil =
          (new Date(booking.slot_time).getTime() - Date.now()) / 3_600_000
        if (hoursUntil < policy.rescheduleNoticeHours) {
          return {
            success: false,
            reason: 'too_late',
            message:
              `Rescheduling needs at least ${policy.rescheduleNoticeHours} hours' notice. ` +
              `Please message the vendor directly to work something out.`,
          }
        }
      }

      // ── Claim the new slot atomically ───────────────────────────────────
      const claim = await client.query<{ id: string; slot_time: string }>(
        `UPDATE resource_slots
         SET capacity_booked = capacity_booked + 1
         WHERE id = $1
           AND capacity_booked < capacity_total
           AND is_cancelled = false
           AND slot_time > now()
         RETURNING id, slot_time`,
        [params.newSlotId]
      )

      if (claim.rowCount === 0) {
        return {
          success: false,
          reason: 'slot_taken',
          message: 'That slot was just taken. Here are the other open times.',
        }
      }

      const newSlot = claim.rows[0]

      // ── Release the old slot ────────────────────────────────────────────
      if (booking.resource_slot_id) {
        await client.query(
          `UPDATE resource_slots
           SET capacity_booked = GREATEST(0, capacity_booked - 1)
           WHERE id = $1`,
          [booking.resource_slot_id]
        )
      }

      // ── Move the booking ────────────────────────────────────────────────
      // Guarded now: previously this could drag a completed or cancelled
      // request back into a live booking via a late reschedule.
      const moved = await requestRepo.rescheduleToSlot(
        params.requestId,
        params.newSlotId,
        txExecutor(client)
      )
      if (!moved) {
        throw new RescheduleRefused(
          'That booking is no longer in a state that can be rescheduled.'
        )
      }

      // ── Audit trail ─────────────────────────────────────────────────────
      await client.query(
        `INSERT INTO booking_reschedules
           (request_id, from_slot_id, to_slot_id, from_slot_time, to_slot_time,
            initiated_by, initiated_by_user, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          params.requestId,
          booking.resource_slot_id,
          params.newSlotId,
          booking.slot_time ?? newSlot.slot_time,
          newSlot.slot_time,
          params.initiatedBy,
          params.userId,
          params.reason ?? null,
        ]
      )

      // ── System message in the chat thread, so both sides see it ─────────
      const timeStr = new Date(newSlot.slot_time).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
      await client.query(
        `INSERT INTO messages (request_id, sender_id, text, message_type, metadata)
         VALUES ($1, $2, $3, 'system', $4)`,
        [
          params.requestId,
          params.userId,
          `Booking moved to ${timeStr} by the ${params.initiatedBy}.`,
          JSON.stringify({ event: 'rescheduled', newSlotTime: newSlot.slot_time }),
        ]
      )

      // ── Freed slot may unblock someone on the waitlist ─────────────────
      if (booking.resource_slot_id) {
        await enqueueOutbox(
          'slot_freed',
          { slotId: booking.resource_slot_id },
          client
        )
      }

      logger.info(
        {
          requestId: params.requestId,
          by: params.initiatedBy,
          count: booking.reschedule_count + 1,
        },
        'Booking rescheduled'
      )

      // Notify the other party
      const notifyUserId =
        params.initiatedBy === 'customer'
          ? await this.vendorUserId(client, booking.confirmed_vendor_id)
          : booking.customer_id

      if (notifyUserId) {
        notifications
          .deliver(
            notifyUserId,
            {
              title: '📅 Booking moved',
              body: `New time: ${timeStr}`,
              data: {
                type: 'rescheduled',
                requestId: params.requestId,
                deepLink: `locogi://chat/${params.requestId}`,
              },
            },
            true
          )
          .catch(() => {})
      }

      return {
        success: true,
        message: `Moved to ${timeStr}.`,
        newSlotTime: newSlot.slot_time,
      }
    }).catch((err): RescheduleResult => {
      // The new state guard refused the move. Rolling back was the point —
      // the old slot stays claimed — but the caller wants a 409, not a 500.
      if (err instanceof RescheduleRefused) {
        return {
          success: false,
          reason: 'not_reschedulable',
          message: err.message,
        }
      }
      throw err
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NO-SHOW — report, verify, apply consequences
  // ═══════════════════════════════════════════════════════════════════════════
  async reportNoShow(params: {
    requestId: string
    party: 'customer' | 'vendor'   // who failed to show
    reportedBy: string
  }): Promise<{ success: boolean; message: string }> {

    const reqResult = await query<{
      status: string
      customer_id: string
      confirmed_vendor_id: string | null
      slot_time: string | null
    }>(
      `SELECT r.status, r.customer_id, r.confirmed_vendor_id, rs.slot_time
       FROM requests r
       LEFT JOIN resource_slots rs ON rs.id = r.resource_slot_id
       WHERE r.id = $1`,
      [params.requestId]
    )

    const booking = reqResult.rows[0]
    if (!booking) return { success: false, message: 'Booking not found.' }

    if (!['confirmed', 'in_progress'].includes(booking.status)) {
      return {
        success: false,
        message: `Cannot report a no-show on a booking that is ${booking.status}.`,
      }
    }

    // Can only report after the appointment time has passed
    if (booking.slot_time && new Date(booking.slot_time) > new Date()) {
      return {
        success: false,
        message: 'You can report a no-show only after the scheduled time.',
      }
    }

    // Verify the reporter is the OTHER party
    const isCustomerReporting = params.reportedBy === booking.customer_id
    if (
      (params.party === 'customer' && isCustomerReporting) ||
      (params.party === 'vendor' && !isCustomerReporting)
    ) {
      return { success: false, message: 'You cannot report yourself as a no-show.' }
    }

    await withTransaction(async (client) => {
      const offenderUserId =
        params.party === 'customer'
          ? booking.customer_id
          : await this.vendorUserId(client, booking.confirmed_vendor_id)

      await client.query(
        `INSERT INTO no_shows
           (request_id, party, user_id, vendor_id, detection, reported_by)
         VALUES ($1,$2,$3,$4,'reported_by_other',$5)`,
        [
          params.requestId,
          params.party,
          offenderUserId,
          params.party === 'vendor' ? booking.confirmed_vendor_id : null,
          params.reportedBy,
        ]
      )

      // Guarded now: a no-show could previously be reported against a
      // completed or cancelled request, wrecking the offender's score.
      await requestRepo.markNoShow(
        params.requestId,
        params.party,
        txExecutor(client)
      )

      // ── Apply reliability consequences ─────────────────────────────────
      if (params.party === 'vendor' && booking.confirmed_vendor_id) {
        await client.query(
          `UPDATE vendors
           SET no_show_count = no_show_count + 1,
               reliability_score = GREATEST(0, reliability_score - 15)
           WHERE id = $1`,
          [booking.confirmed_vendor_id]
        )
      } else if (offenderUserId) {
        const result = await client.query<{ no_show_count: number }>(
          `UPDATE users
           SET no_show_count = no_show_count + 1,
               reliability_score = GREATEST(0, reliability_score - 10)
           WHERE id = $1
           RETURNING no_show_count`,
          [offenderUserId]
        )

        // Three strikes → restricted from booking for a week. Restriction,
        // not a ban — people have genuine emergencies.
        const count = result.rows[0]?.no_show_count ?? 0
        if (count >= 3) {
          await client.query(
            `UPDATE users
             SET booking_restricted_until = now() + interval '7 days'
             WHERE id = $1`,
            [offenderUserId]
          )
          logger.warn(
            { userId: offenderUserId, count },
            'Customer restricted from booking after repeated no-shows'
          )
        }
      }

      // Free the slot so someone else can use it
      await client.query(
        `UPDATE resource_slots
         SET capacity_booked = GREATEST(0, capacity_booked - 1)
         WHERE id = (SELECT resource_slot_id FROM requests WHERE id = $1)`,
        [params.requestId]
      )
    })

    logger.info(
      { requestId: params.requestId, party: params.party },
      'No-show recorded'
    )

    return {
      success: true,
      message:
        params.party === 'vendor'
          ? "Recorded. We're sorry — this affects the vendor's reliability score. " +
            'Want me to find someone else?'
          : 'Recorded. The slot has been released.',
    }
  }

  /** The reported party can dispute — no-shows shouldn't be unilateral. */
  async disputeNoShow(
    noShowId: string,
    userId: string,
    note: string
  ): Promise<{ success: boolean }> {
    const result = await query(
      `UPDATE no_shows
       SET is_disputed = true, dispute_note = $3
       WHERE id = $1
         AND (user_id = $2 OR vendor_id IN (SELECT id FROM vendors WHERE user_id = $2))
         AND is_disputed = false`,
      [noShowId, userId, note.slice(0, 1000)]
    )
    return { success: (result.rowCount ?? 0) > 0 }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WAITLIST
  // ═══════════════════════════════════════════════════════════════════════════
  async joinWaitlist(params: {
    requestId: string
    resourceId: string
    customerId: string
    desiredDate: string
    desiredTimeFrom?: string
    desiredTimeUntil?: string
    partySize?: number
    flexibleOnDate?: boolean
  }): Promise<{ position: number; estimatedMessage: string }> {

    const posResult = await query<{ next_pos: number }>(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
       FROM waitlist_entries
       WHERE resource_id = $1 AND desired_date = $2::date AND status = 'waiting'`,
      [params.resourceId, params.desiredDate]
    )
    const position = posResult.rows[0]?.next_pos ?? 1

    await query(
      `INSERT INTO waitlist_entries
         (request_id, resource_id, customer_id, desired_date,
          desired_time_from, desired_time_until, party_size,
          flexible_on_date, position)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9)`,
      [
        params.requestId,
        params.resourceId,
        params.customerId,
        params.desiredDate,
        params.desiredTimeFrom ?? null,
        params.desiredTimeUntil ?? null,
        params.partySize ?? null,
        params.flexibleOnDate ?? false,
        position,
      ]
    )

    await requestRepo.markWaitlisted(params.requestId)

    return {
      position,
      estimatedMessage:
        position === 1
          ? "You're first in line. I'll ping you the moment something opens up."
          : `You're #${position} on the waitlist. I'll notify you if a slot frees up.`,
    }
  }

  /**
   * A slot freed up — offer it to the front of the queue with a short hold.
   * Called by the outbox worker on the 'slot_freed' event.
   */
  async offerFreedSlot(slotId: string): Promise<{ offered: boolean }> {
    const slotResult = await query<{
      id: string
      resource_id: string
      slot_time: string
      capacity_booked: number
      capacity_total: number
    }>(
      `SELECT id, resource_id, slot_time, capacity_booked, capacity_total
       FROM resource_slots
       WHERE id = $1 AND is_cancelled = false AND slot_time > now()`,
      [slotId]
    )

    const slot = slotResult.rows[0]
    if (!slot || slot.capacity_booked >= slot.capacity_total) {
      return { offered: false }
    }

    const slotDate = slot.slot_time.split('T')[0]
    const slotTime = new Date(slot.slot_time)

    // Front of the queue whose stated window covers this slot
    const candidate = await query<{
      id: string
      customer_id: string
      request_id: string
    }>(
      `SELECT id, customer_id, request_id
       FROM waitlist_entries
       WHERE resource_id = $1
         AND status = 'waiting'
         AND (desired_date = $2::date OR flexible_on_date = true)
         AND (desired_time_from IS NULL OR desired_time_from <= $3::time)
         AND (desired_time_until IS NULL OR desired_time_until >= $3::time)
       ORDER BY position ASC
       LIMIT 1`,
      [slot.resource_id, slotDate, slotTime.toTimeString().slice(0, 8)]
    )

    const entry = candidate.rows[0]
    if (!entry) return { offered: false }

    // Hold it for 15 minutes
    const expiresAt = new Date(Date.now() + 15 * 60_000)
    await query(
      `UPDATE waitlist_entries
       SET status = 'offered', offered_slot_id = $2,
           offered_at = now(), offer_expires_at = $3
       WHERE id = $1`,
      [entry.id, slotId, expiresAt]
    )

    const timeStr = slotTime.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    })

    notifications
      .deliver(
        entry.customer_id,
        {
          title: '🎉 A slot opened up',
          body: `${timeStr} is free — yours for the next 15 minutes. Tap to claim.`,
          data: {
            type: 'waitlist_offer',
            requestId: entry.request_id,
            waitlistId: entry.id,
            deepLink: `locogi://chat/${entry.request_id}`,
          },
        },
        true
      )
      .catch(() => {})

    logger.info({ slotId, waitlistId: entry.id }, 'Freed slot offered to waitlist')
    return { offered: true }
  }

  /** Claim an offered slot (atomic — the offer may have expired). */
  async claimWaitlistOffer(
    waitlistId: string,
    customerId: string
  ): Promise<{ success: boolean; message: string }> {
    return withTransaction(async (client) => {
      const entryResult = await client.query<{
        request_id: string
        offered_slot_id: string
      }>(
        `SELECT request_id, offered_slot_id
         FROM waitlist_entries
         WHERE id = $1 AND customer_id = $2
           AND status = 'offered'
           AND offer_expires_at > now()
         FOR UPDATE`,
        [waitlistId, customerId]
      )

      const entry = entryResult.rows[0]
      if (!entry) {
        return { success: false, message: 'That offer has expired or was already claimed.' }
      }

      const claim = await client.query(
        `UPDATE resource_slots
         SET capacity_booked = capacity_booked + 1
         WHERE id = $1 AND capacity_booked < capacity_total AND is_cancelled = false
         RETURNING slot_time`,
        [entry.offered_slot_id]
      )

      if (claim.rowCount === 0) {
        await client.query(
          `UPDATE waitlist_entries SET status = 'waiting', offered_slot_id = NULL,
             offered_at = NULL, offer_expires_at = NULL WHERE id = $1`,
          [waitlistId]
        )
        return { success: false, message: 'That slot just filled. Still on the list.' }
      }

      await client.query(
        `UPDATE waitlist_entries SET status = 'claimed' WHERE id = $1`,
        [waitlistId]
      )
      // Guarded now: claiming an offer could previously resurrect a request
      // the customer had already cancelled while queued.
      await requestRepo.confirmFromWaitlist(
        entry.request_id,
        entry.offered_slot_id,
        txExecutor(client)
      )

      const timeStr = new Date(claim.rows[0].slot_time as string).toLocaleString(
        'en-IN',
        { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }
      )

      return { success: true, message: `Confirmed for ${timeStr}.` }
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VENDOR DISRUPTION — cancel a slot/day and cascade to affected bookings
  // ═══════════════════════════════════════════════════════════════════════════
  async createDisruption(params: {
    organizationId: string
    resourceId?: string
    disruptionType: 'resource_unavailable' | 'org_closed' | 'slot_cancelled'
    affectsFrom: string
    affectsUntil: string
    reason: string
    createdBy: string
  }): Promise<{
    disruptionId: string
    affectedCount: number
    message: string
  }> {

    return withTransaction(async (client) => {
      const disruption = await client.query<{ id: string }>(
        `INSERT INTO booking_disruptions
           (organization_id, resource_id, disruption_type,
            affects_from, affects_until, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
          params.organizationId,
          params.resourceId ?? null,
          params.disruptionType,
          params.affectsFrom,
          params.affectsUntil,
          params.reason,
          params.createdBy,
        ]
      )
      const disruptionId = disruption.rows[0].id

      // Cancel the affected slots
      const cancelled = await client.query<{ id: string }>(
        `UPDATE resource_slots rs
         SET is_cancelled = true, cancelled_at = now(), cancel_reason = $1
         WHERE rs.slot_time BETWEEN $2 AND $3
           AND rs.is_cancelled = false
           AND rs.resource_id IN (
             SELECT id FROM bookable_resources
             WHERE organization_id = $4
               AND ($5::uuid IS NULL OR id = $5::uuid)
           )
         RETURNING rs.id`,
        [
          params.reason,
          params.affectsFrom,
          params.affectsUntil,
          params.organizationId,
          params.resourceId ?? null,
        ]
      )

      const slotIds = cancelled.rows.map((r) => r.id)
      if (slotIds.length === 0) {
        return {
          disruptionId,
          affectedCount: 0,
          message: 'No slots in that window — nothing to cancel.',
        }
      }

      // Find every affected booking and mark it disrupted
      const affected = await requestRepo.markDisruptedBySlots(
        slotIds,
        txExecutor(client)
      )

      // System message + notification per affected customer
      for (const booking of affected) {
        await client.query(
          `INSERT INTO messages (request_id, sender_id, text, message_type, metadata)
           VALUES ($1, $2, $3, 'system', $4)`,
          [
            booking.id,
            params.createdBy,
            `The vendor has cancelled this slot. Reason: ${params.reason}. ` +
              `You can pick another time or find a different vendor.`,
            JSON.stringify({ event: 'disrupted', disruptionId }),
          ]
        )

        // Queue via outbox so notification failure can't roll back the cancel
        await enqueueOutbox(
          'booking_disrupted',
          {
            requestId: booking.id,
            customerId: booking.customerId,
            reason: params.reason,
          },
          client
        )
      }

      await client.query(
        `UPDATE booking_disruptions
         SET affected_booking_count = $2 WHERE id = $1`,
        [disruptionId, affected.length]
      )

      logger.warn(
        {
          disruptionId,
          slotsCancelled: slotIds.length,
          bookingsAffected: affected.length,
        },
        'Vendor disruption cascaded'
      )

      return {
        disruptionId,
        affectedCount: affected.length,
        message:
          (affected.length) === 0
            ? `${slotIds.length} slots closed. No customers were affected.`
            : `${slotIds.length} slots closed. ${affected.length} customers notified ` +
              `and offered alternatives.`,
      }
    })
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  private async getPolicy(
    client: { query: (q: string, v?: unknown[]) => Promise<{ rows: unknown[] }> },
    requestId: string
  ): Promise<{
    freeCancellationHours: number
    maxReschedules: number
    rescheduleNoticeHours: number
  }> {
    const result = (await client.query(
      `SELECT cp.free_cancellation_hours, cp.max_reschedules, cp.reschedule_notice_hours
       FROM requests r
       LEFT JOIN request_categories rc ON rc.request_id = r.id
       LEFT JOIN cancellation_policies cp
         ON cp.category_id = rc.category_id
         OR cp.organization_id = r.organization_id
       WHERE r.id = $1
       ORDER BY cp.organization_id NULLS LAST
       LIMIT 1`,
      [requestId]
    )) as {
      rows: Array<{
        free_cancellation_hours: number | null
        max_reschedules: number | null
        reschedule_notice_hours: number | null
      }>
    }

    const p = result.rows[0]
    return {
      freeCancellationHours: p?.free_cancellation_hours ?? 24,
      maxReschedules: p?.max_reschedules ?? 2,
      rescheduleNoticeHours: p?.reschedule_notice_hours ?? 4,
    }
  }

  /**
   * Resolve a vendor's notifiable user inside the CALLER's transaction.
   *
   * The PoolClient is threaded through as an executor rather than falling back
   * to the pool. Reading on a pooled connection here would read pre-transaction
   * state — harmless for this particular lookup today, but the habit is what
   * keeps the transaction boundary honest as this method grows.
   */
  private async vendorUserId(
    client: PoolClient,
    vendorId: string | null
  ): Promise<string | null> {
    if (!vendorId) return null
    return vendorRepo.findUserIdByVendorId(vendorId, txExecutor(client))
  }
}

/**
 * Signals that a reschedule was refused because the booking had already moved
 * on. Thrown so the enclosing transaction rolls back the slot release — the
 * old slot must not be freed if the move itself did not happen.
 */
class RescheduleRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RescheduleRefused'
  }
}
