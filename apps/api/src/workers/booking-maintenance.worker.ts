import { Worker } from 'bullmq'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { vendorRepo, requestRepo } from '../repositories'
import { BookingLifecycleService } from '../services/booking-lifecycle.service'
import { RecurringService } from '../services/recurring.service'
import { NotificationService } from '../services/notification.service'
import { RentalService } from '../services/rental.service'

const lifecycle = new BookingLifecycleService()
const recurring = new RecurringService()
const notifications = new NotificationService()
const rentals = new RentalService()

/**
 * Booking maintenance worker. Runs hourly.
 *
 * Fixes the slot-exhaustion time bomb and closes the loops that were
 * previously left dangling:
 *
 *  1. Roll the slot window forward   ← fixes silent zero-slot failure
 *  2. Materialise recurring bookings
 *  3. Detect no-shows on timeout
 *  4. Expire stale waitlist offers, re-offer to the next person
 *  5. Prune expired waitlist entries
 *  6. Recover reliability scores over time
 */
export const bookingMaintenanceWorker = new Worker(
  'booking-maintenance',
  async () => {
    const results = {
      slotsGenerated: 0,
      recurringMaterialized: 0,
      noShowsDetected: 0,
      offersExpired: 0,
      waitlistPruned: 0,
      scoresRecovered: 0,
      rentalsOverdue: 0,
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 1. ROLL THE SLOT WINDOW FORWARD
    //
    // This is the bug fix. Previously slots were generated once, 4 weeks out,
    // and nothing extended them. Every restaurant and doctor would silently
    // show "no slots available" after a month with no error anywhere.
    // ═══════════════════════════════════════════════════════════════════════
    const schedules = await query<{
      id: string
      resource_id: string
      days_of_week: number[]
      start_time: string
      end_time: string
      duration_minutes: number
      capacity_per_slot: number
      horizon_days: number
      blackout_dates: string[] | null
      last_generated_until: string | null
    }>(
      `SELECT id, resource_id, days_of_week, start_time, end_time,
              duration_minutes, capacity_per_slot, horizon_days,
              blackout_dates, last_generated_until
       FROM slot_schedules
       WHERE is_active = true
         AND (
           last_generated_until IS NULL
           OR last_generated_until < (now() + (horizon_days || ' days')::interval)::date
         )
       LIMIT 200`
    )

    for (const sch of schedules.rows) {
      try {
        const generated = await generateSlotsForSchedule(sch)
        results.slotsGenerated += generated
      } catch (err) {
        logger.error(
          { err, scheduleId: sch.id },
          'Slot generation failed for schedule'
        )
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2. MATERIALISE RECURRING BOOKINGS
    // ═══════════════════════════════════════════════════════════════════════
    const series = await query<{ id: string }>(
      `SELECT id FROM recurring_bookings
       WHERE status = 'active'
         AND (
           last_materialized_until IS NULL
           OR last_materialized_until < (now() + interval '14 days')::date
         )
       LIMIT 200`
    )

    for (const s of series.rows) {
      try {
        const created = await recurring.materialize(s.id, 21)
        results.recurringMaterialized += created.length
      } catch (err) {
        logger.error({ err, recurringId: s.id }, 'Recurring materialization failed')
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 3. NO-SHOW DETECTION
    //
    // A confirmed booking whose time passed 2+ hours ago and never moved to
    // in_progress is very likely a no-show. We don't auto-penalise — we ASK,
    // because guessing wrong damages someone's reliability score unfairly.
    // ═══════════════════════════════════════════════════════════════════════
    const stale = await query<{
      id: string
      customer_id: string
      confirmed_vendor_id: string | null
      slot_time: string
    }>(
      `SELECT r.id, r.customer_id, r.confirmed_vendor_id, rs.slot_time
       FROM requests r
       JOIN resource_slots rs ON rs.id = r.resource_slot_id
       WHERE r.status = 'confirmed'
         AND rs.slot_time < now() - interval '2 hours'
         AND rs.slot_time > now() - interval '48 hours'
         AND NOT EXISTS (
           SELECT 1 FROM events e
           WHERE e.request_id = r.id AND e.event_type = 'no_show_check_sent'
         )
       LIMIT 100`
    )

    // One bulk lookup instead of one query per stale booking. At the LIMIT 100
    // above this replaced up to 100 sequential round-trips with a single query.
    const vendorUserIds = await vendorRepo.findUserIdsByVendorIds(
      stale.rows
        .map((b) => b.confirmed_vendor_id)
        .filter((id): id is string => id !== null)
    )

    for (const booking of stale.rows) {
      // Ask both sides what happened
      const targets = [booking.customer_id]
      const vendorUserId = booking.confirmed_vendor_id
        ? vendorUserIds.get(booking.confirmed_vendor_id)
        : undefined
      if (vendorUserId) targets.push(vendorUserId)

      for (const userId of targets) {
        notifications
          .deliver(userId, {
            title: 'Did this appointment happen?',
            body: 'Tap to confirm it went ahead, or report a no-show.',
            data: {
              type: 'no_show_check',
              requestId: booking.id,
              deepLink: `locogi://chat/${booking.id}`,
            },
          })
          .catch(() => {})
      }

      await query(
        `INSERT INTO events (event_type, request_id, metadata)
         VALUES ('no_show_check_sent', $1, $2)`,
        [booking.id, JSON.stringify({ slotTime: booking.slot_time })]
      )
      results.noShowsDetected++
    }

    // Anything still unanswered after 48 hours: close it as completed rather
    // than penalising either side on no evidence
    const autoClose = await requestRepo.autoCompletePastSlots(48)
    if (autoClose.length > 0) {
      logger.info(
        { count: autoClose.length },
        'Auto-closed stale bookings as completed (no evidence of no-show)'
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4. EXPIRE WAITLIST OFFERS, RE-OFFER TO THE NEXT PERSON
    // ═══════════════════════════════════════════════════════════════════════
    const expiredOffers = await query<{ id: string; offered_slot_id: string }>(
      `UPDATE waitlist_entries
       SET status = 'waiting', offered_slot_id = NULL,
           offered_at = NULL, offer_expires_at = NULL,
           position = position + 100          -- send them to the back
       WHERE status = 'offered' AND offer_expires_at < now()
       RETURNING id, offered_slot_id`
    )

    results.offersExpired = expiredOffers.rows.length

    // Pass the slot to the next person in line
    for (const exp of expiredOffers.rows) {
      if (exp.offered_slot_id) {
        try {
          await lifecycle.offerFreedSlot(exp.offered_slot_id)
        } catch (err) {
          logger.error({ err }, 'Re-offer to next waitlist entry failed')
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 5. PRUNE WAITLIST ENTRIES WHOSE DATE HAS PASSED
    // ═══════════════════════════════════════════════════════════════════════
    const pruned = await query<{ id: string; request_id: string }>(
      `UPDATE waitlist_entries
       SET status = 'expired'
       WHERE status IN ('waiting','offered')
         AND desired_date < current_date
         AND flexible_on_date = false
       RETURNING id, request_id`
    )
    results.waitlistPruned = pruned.rows.length

    for (const p of pruned.rows) {
      await requestRepo.expireRequest(p.request_id)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6. RELIABILITY RECOVERY
    //
    // A single bad week shouldn't follow someone forever. Scores recover
    // slowly toward 100 with sustained good behaviour.
    // ═══════════════════════════════════════════════════════════════════════
    const recoveredVendors = await query<{ id: string }>(
      `UPDATE vendors
       SET reliability_score = LEAST(100, reliability_score + 2)
       WHERE reliability_score < 100
         AND NOT EXISTS (
           SELECT 1 FROM no_shows ns
           WHERE ns.vendor_id = vendors.id
             AND ns.created_at > now() - interval '14 days'
             AND ns.resolution IS DISTINCT FROM 'overturned'
         )
       RETURNING id`
    )

    const recoveredUsers = await query<{ id: string }>(
      `UPDATE users
       SET reliability_score = LEAST(100, reliability_score + 2),
           booking_restricted_until = CASE
             WHEN booking_restricted_until < now() THEN NULL
             ELSE booking_restricted_until
           END
       WHERE reliability_score < 100
         AND NOT EXISTS (
           SELECT 1 FROM no_shows ns
           WHERE ns.user_id = users.id
             AND ns.created_at > now() - interval '14 days'
             AND ns.resolution IS DISTINCT FROM 'overturned'
         )
       RETURNING id`
    )

    results.scoresRecovered = recoveredVendors.rowCount + recoveredUsers.rowCount

    // ═══════════════════════════════════════════════════════════════════════
    // 7. FLAG OVERDUE RENTALS
    // ═══════════════════════════════════════════════════════════════════════
    try {
      results.rentalsOverdue = await rentals.flagOverdue()
    } catch (err) {
      logger.error({ err }, 'Overdue rental sweep failed')
    }

    logger.info(results, 'Booking maintenance complete')
  },
  { connection: { url: process.env.REDIS_URL! } }
)

// ─── Slot generation from a schedule rule ────────────────────────────────────
async function generateSlotsForSchedule(sch: {
  id: string
  resource_id: string
  days_of_week: number[]
  start_time: string
  end_time: string
  duration_minutes: number
  capacity_per_slot: number
  horizon_days: number
  blackout_dates: string[] | null
  last_generated_until: string | null
}): Promise<number> {

  const [startH, startM] = sch.start_time.split(':').map(Number)
  const [endH, endM] = sch.end_time.split(':').map(Number)
  const blackouts = new Set(sch.blackout_dates ?? [])

  // Resume from the watermark, or today
  const from = sch.last_generated_until
    ? new Date(new Date(sch.last_generated_until).getTime() + 86_400_000)
    : new Date()

  const until = new Date(Date.now() + sch.horizon_days * 86_400_000)
  let created = 0
  const now = new Date()

  for (
    let d = new Date(from);
    d <= until;
    d = new Date(d.getTime() + 86_400_000)
  ) {
    const dateStr = d.toISOString().split('T')[0]
    if (blackouts.has(dateStr)) continue

    const istDay = new Date(
      d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
    ).getDay()
    if (!sch.days_of_week.includes(istDay)) continue

    const dayStart = new Date(d)
    dayStart.setHours(startH, startM, 0, 0)
    const dayEnd = new Date(d)
    dayEnd.setHours(endH, endM, 0, 0)

    for (
      let t = new Date(dayStart);
      t < dayEnd;
      t = new Date(t.getTime() + sch.duration_minutes * 60_000)
    ) {
      if (t <= now) continue

      const inserted = await query(
        `INSERT INTO resource_slots
           (resource_id, slot_time, duration_minutes, capacity_total)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (resource_id, slot_time) DO NOTHING`,
        [sch.resource_id, t.toISOString(), sch.duration_minutes, sch.capacity_per_slot]
      )
      if (inserted.rowCount > 0) created++
    }
  }

  await query(
    `UPDATE slot_schedules
     SET last_generated_until = $2, updated_at = now()
     WHERE id = $1`,
    [sch.id, until.toISOString().split('T')[0]]
  )

  return created
}
