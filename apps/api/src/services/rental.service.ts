/**
 * RentalService — date-range bookings (rentals and venues).
 *
 * Point-in-time appointments use a capacity counter. Date ranges need
 * something stronger, because "Friday 6pm to Sunday 8pm" can overlap another
 * booking in ways a counter cannot express.
 *
 * The guarantee here comes from a native Postgres EXCLUDE constraint:
 *
 *   EXCLUDE USING gist (resource_id WITH =, period WITH &&)
 *
 * Two overlapping bookings on the same resource are IMPOSSIBLE at the database
 * level. Not "prevented by application logic" — impossible. That's the same
 * standard as the atomic race-lock, achieved declaratively.
 *
 * A concurrent double-book raises SQLSTATE 23P01 (exclusion_violation), which
 * we catch and translate into a clean 409.
 */

import { query, withTransaction } from '../lib/db'
import { logger } from '../lib/logger'
import { enqueueOutbox } from '../lib/outbox'
import { requestRepo, txExecutor } from '../repositories'

const EXCLUSION_VIOLATION = '23P01'

export interface AvailabilityWindow {
  from: string
  until: string
}

export interface RentalQuote {
  available: boolean
  resourceId: string
  resourceName: string
  durationHours: number
  basePrice: number
  securityDeposit: number
  includedUsage: number | null
  usageUnit: string | null
  excessUsageRate: number | null
  totalPayable: number
  conflictReason?: string
}

export class RentalService {

  // ─── Is this resource free for the window? ──────────────────────────────────
  async checkAvailability(
    resourceId: string,
    from: string,
    until: string
  ): Promise<{ available: boolean; reason?: string; nextFreeFrom?: string }> {

    const resourceResult = await query<{
      turnaround_minutes: number
      min_booking_duration_hours: number | null
      max_booking_duration_hours: number | null
      is_active: boolean
    }>(
      `SELECT turnaround_minutes, min_booking_duration_hours,
              max_booking_duration_hours, is_active
       FROM bookable_resources WHERE id = $1`,
      [resourceId]
    )

    const resource = resourceResult.rows[0]
    if (!resource) return { available: false, reason: 'Resource not found' }
    if (!resource.is_active) {
      return { available: false, reason: 'This item is not currently available for rent' }
    }

    const hours = (new Date(until).getTime() - new Date(from).getTime()) / 3_600_000

    if (hours <= 0) {
      return { available: false, reason: 'Return time must be after pickup time' }
    }
    if (resource.min_booking_duration_hours && hours < resource.min_booking_duration_hours) {
      return {
        available: false,
        reason: `Minimum rental is ${resource.min_booking_duration_hours} hours`,
      }
    }
    if (resource.max_booking_duration_hours && hours > resource.max_booking_duration_hours) {
      return {
        available: false,
        reason: `Maximum rental is ${resource.max_booking_duration_hours} hours`,
      }
    }

    // Extend the window by the turnaround buffer on both sides — a car needs
    // cleaning between renters, a hall needs resetting
    const buffer = resource.turnaround_minutes ?? 0
    const periodFrom = new Date(new Date(from).getTime() - buffer * 60_000)
    const periodUntil = new Date(new Date(until).getTime() + buffer * 60_000)

    // Existing bookings
    const conflict = await query<{ customer_from: string; customer_until: string }>(
      `SELECT customer_from, customer_until
       FROM resource_bookings
       WHERE resource_id = $1
         AND status <> 'cancelled'
         AND period && tstzrange($2, $3)
       ORDER BY customer_until ASC
       LIMIT 1`,
      [resourceId, periodFrom.toISOString(), periodUntil.toISOString()]
    )

    if (conflict.rows.length > 0) {
      return {
        available: false,
        reason: 'Already booked for part of that window',
        nextFreeFrom: conflict.rows[0].customer_until,
      }
    }

    // Blackouts (maintenance, owner use, festival closure)
    const blackout = await query<{ reason: string | null }>(
      `SELECT reason FROM resource_blackouts
       WHERE resource_id = $1 AND period && tstzrange($2, $3)
       LIMIT 1`,
      [resourceId, periodFrom.toISOString(), periodUntil.toISOString()]
    )

    if (blackout.rows.length > 0) {
      return {
        available: false,
        reason: blackout.rows[0].reason ?? 'Unavailable during that period',
      }
    }

    return { available: true }
  }

  // ─── Price it up ────────────────────────────────────────────────────────────
  async quote(
    resourceId: string,
    from: string,
    until: string
  ): Promise<RentalQuote | null> {
    const resourceResult = await query<{
      id: string
      name: string
      base_price: number | null
      price_unit: string | null
      security_deposit: number | null
      specs: Record<string, unknown> | null
    }>(
      `SELECT id, name, base_price, price_unit, security_deposit, specs
       FROM bookable_resources WHERE id = $1`,
      [resourceId]
    )

    const r = resourceResult.rows[0]
    if (!r) return null

    const availability = await this.checkAvailability(resourceId, from, until)
    const hours = (new Date(until).getTime() - new Date(from).getTime()) / 3_600_000

    // Interpret the unit the vendor priced in
    let basePrice = 0
    if (r.base_price) {
      switch (r.price_unit) {
        case 'per_hour':
          basePrice = Math.ceil(hours) * r.base_price
          break
        case 'per_session':
        case 'per_visit':
          // Treated as a day rate for rentals
          basePrice = Math.ceil(hours / 24) * r.base_price
          break
        default:
          basePrice = Math.ceil(hours / 24) * r.base_price
      }
    }

    const specs = r.specs ?? {}
    const includedPerDay = Number(specs.included_usage_per_day ?? 0) || null
    const days = Math.ceil(hours / 24)

    return {
      available: availability.available,
      resourceId: r.id,
      resourceName: r.name,
      durationHours: Math.round(hours * 10) / 10,
      basePrice,
      securityDeposit: r.security_deposit ?? 0,
      includedUsage: includedPerDay ? includedPerDay * days : null,
      usageUnit: (specs.usage_unit as string) ?? null,
      excessUsageRate: Number(specs.excess_usage_rate ?? 0) || null,
      totalPayable: basePrice + (r.security_deposit ?? 0),
      conflictReason: availability.reason,
    }
  }

  // ─── Book it (the exclusion constraint does the hard part) ──────────────────
  async book(params: {
    resourceId: string
    requestId: string
    from: string
    until: string
    depositAmount?: number
  }): Promise<{
    success: boolean
    bookingId?: string
    reason?: 'conflict' | 'invalid' | 'unavailable'
    message: string
  }> {

    const pre = await this.checkAvailability(params.resourceId, params.from, params.until)
    if (!pre.available) {
      return {
        success: false,
        reason: 'unavailable',
        message: pre.reason ?? 'Not available for that window',
      }
    }

    const bufferResult = await query<{ turnaround_minutes: number }>(
      'SELECT turnaround_minutes FROM bookable_resources WHERE id = $1',
      [params.resourceId]
    )
    const buffer = bufferResult.rows[0]?.turnaround_minutes ?? 0

    const periodFrom = new Date(new Date(params.from).getTime() - buffer * 60_000)
    const periodUntil = new Date(new Date(params.until).getTime() + buffer * 60_000)

    try {
      return await withTransaction(async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO resource_bookings
             (resource_id, request_id, period, customer_from, customer_until,
              status, deposit_amount, deposit_status)
           VALUES ($1, $2, tstzrange($3, $4), $5, $6, 'confirmed', $7,
                   CASE WHEN $7::integer > 0 THEN 'pending' ELSE NULL END)
           RETURNING id`,
          [
            params.resourceId,
            params.requestId,
            periodFrom.toISOString(),
            periodUntil.toISOString(),
            params.from,
            params.until,
            params.depositAmount ?? 0,
          ]
        )

        // Guarded now: rental booking could previously confirm a request
        // that had already been cancelled or completed.
        await requestRepo.confirmRental(params.requestId, txExecutor(client))

        const bookingId = inserted.rows[0].id
        logger.info(
          { bookingId, resourceId: params.resourceId },
          'Date-range booking created'
        )

        return {
          success: true,
          bookingId,
          message: 'Booked.',
        }
      })
    } catch (err) {
      // The exclusion constraint fired — someone booked the same window in
      // the microseconds between our pre-check and the insert. This is the
      // correct outcome, not a bug.
      const code = (err as { code?: string }).code
      if (code === EXCLUSION_VIOLATION) {
        logger.info(
          { resourceId: params.resourceId },
          'Exclusion constraint prevented a concurrent double-booking'
        )
        return {
          success: false,
          reason: 'conflict',
          message: 'Someone just booked that window. Let me show you what else is free.',
        }
      }
      throw err
    }
  }

  // ─── Handover (vendor gives the item to the customer) ──────────────────────
  async handover(
    bookingId: string,
    vendorUserId: string,
    params: { conditionNotes?: string; usageOut?: number }
  ): Promise<{ success: boolean; message: string }> {

    const result = await query(
      `UPDATE resource_bookings rb
       SET status = 'in_progress',
           handed_over_at = now(),
           condition_notes_out = $3,
           usage_out = $4
       WHERE rb.id = $1
         AND rb.status = 'confirmed'
         AND EXISTS (
           SELECT 1 FROM bookable_resources br
           JOIN organization_members om ON om.organization_id = br.organization_id
           WHERE br.id = rb.resource_id
             AND om.user_id = $2
             AND om.can_accept_bookings = true
         )`,
      [bookingId, vendorUserId, params.conditionNotes ?? null, params.usageOut ?? null]
    )

    if (result.rowCount === 0) {
      return { success: false, message: 'Could not mark handover — check the booking status.' }
    }

    return { success: true, message: 'Handover recorded. Rental is now active.' }
  }

  // ─── Return ────────────────────────────────────────────────────────────────
  async processReturn(
    bookingId: string,
    vendorUserId: string,
    params: {
      conditionNotes?: string
      usageIn?: number
      damageReported?: boolean
      damageCharge?: number
    }
  ): Promise<{
    success: boolean
    message: string
    excessUsageCharge?: number
    depositRefund?: number
  }> {

    return withTransaction(async (client) => {
      const bookingResult = await client.query<{
        id: string
        usage_out: number | null
        included_usage: number | null
        excess_usage_rate: number | null
        usage_unit: string | null
        deposit_amount: number | null
        customer_until: string
      }>(
        `SELECT rb.id, rb.usage_out, rb.included_usage, rb.excess_usage_rate,
                rb.usage_unit, rb.deposit_amount, rb.customer_until
         FROM resource_bookings rb
         JOIN bookable_resources br ON br.id = rb.resource_id
         JOIN organization_members om ON om.organization_id = br.organization_id
         WHERE rb.id = $1
           AND rb.status = 'in_progress'
           AND om.user_id = $2
           AND om.can_accept_bookings = true
         FOR UPDATE OF rb`,
        [bookingId, vendorUserId]
      )

      const booking = bookingResult.rows[0]
      if (!booking) {
        return { success: false, message: 'Could not find an active rental to close.' }
      }

      // Excess usage (km beyond the included allowance, for instance)
      let excessCharge = 0
      if (
        params.usageIn != null &&
        booking.usage_out != null &&
        booking.included_usage != null &&
        booking.excess_usage_rate
      ) {
        const used = params.usageIn - booking.usage_out
        const excess = Math.max(0, used - booking.included_usage)
        excessCharge = Math.round(excess * booking.excess_usage_rate)
      }

      const damageCharge = params.damageReported ? (params.damageCharge ?? 0) : 0
      const totalCharges = excessCharge + damageCharge
      const deposit = booking.deposit_amount ?? 0
      const refund = Math.max(0, deposit - totalCharges)

      const depositStatus =
        deposit === 0
          ? null
          : refund === deposit
          ? 'refunded'
          : refund === 0
          ? 'forfeited'
          : 'partially_refunded'

      await client.query(
        `UPDATE resource_bookings
         SET status = 'returned',
             returned_at = now(),
             condition_notes_in = $2,
             usage_in = $3,
             damage_reported = $4,
             damage_charge = $5,
             deposit_status = $6
         WHERE id = $1`,
        [
          bookingId,
          params.conditionNotes ?? null,
          params.usageIn ?? null,
          params.damageReported ?? false,
          damageCharge || null,
          depositStatus,
        ]
      )

      // The request id comes from the booking row rather than the caller, so
      // resolve it first and then go through the guarded transition.
      const linked = await client.query<{ request_id: string }>(
        'SELECT request_id FROM resource_bookings WHERE id = $1',
        [bookingId]
      )
      const linkedRequestId = linked.rows[0]?.request_id
      if (linkedRequestId) {
        await requestRepo.advanceStage(
          linkedRequestId,
          'completed',
          txExecutor(client)
        )
      }

      const parts: string[] = ['Return recorded.']
      if (excessCharge > 0) {
        parts.push(`Excess ${booking.usage_unit ?? 'usage'} charge: ₹${excessCharge}.`)
      }
      if (damageCharge > 0) parts.push(`Damage charge: ₹${damageCharge}.`)
      if (deposit > 0) parts.push(`Deposit refund: ₹${refund} of ₹${deposit}.`)

      return {
        success: true,
        message: parts.join(' '),
        excessUsageCharge: excessCharge || undefined,
        depositRefund: deposit > 0 ? refund : undefined,
      }
    })
  }

  // ─── Find available resources in a category for a window ───────────────────
  async findAvailable(params: {
    categoryId: string
    from: string
    until: string
    h3Cells?: string[]
    maxPrice?: number
  }): Promise<RentalQuote[]> {

    const geoClause = params.h3Cells?.length
      ? `AND o.h3_r7 = ANY($4::text[])`
      : ''

    const values: unknown[] = [params.categoryId, params.from, params.until]
    if (params.h3Cells?.length) values.push(params.h3Cells)

    // Exclude anything already booked or blacked out for the window in one pass
    const result = await query<{ id: string }>(
      `SELECT br.id
       FROM bookable_resources br
       JOIN organizations o ON o.id = br.organization_id
       JOIN vendor_categories vc ON vc.vendor_id = o.vendor_id
       WHERE vc.category_id = $1
         AND br.is_active = true
         AND o.verification_status = 'verified'
         ${geoClause}
         AND NOT EXISTS (
           SELECT 1 FROM resource_bookings rb
           WHERE rb.resource_id = br.id
             AND rb.status <> 'cancelled'
             AND rb.period && tstzrange($2, $3)
         )
         AND NOT EXISTS (
           SELECT 1 FROM resource_blackouts rbl
           WHERE rbl.resource_id = br.id
             AND rbl.period && tstzrange($2, $3)
         )
       ORDER BY br.base_price NULLS LAST
       LIMIT 10`,
      values
    )

    const quotes: RentalQuote[] = []
    for (const row of result.rows) {
      const q = await this.quote(row.id, params.from, params.until)
      if (q && q.available) {
        if (!params.maxPrice || q.basePrice <= params.maxPrice) quotes.push(q)
      }
    }

    return quotes
  }

  // ─── Overdue detection (called by the maintenance worker) ──────────────────
  async flagOverdue(): Promise<number> {
    const result = await query<{ id: string; request_id: string }>(
      `UPDATE resource_bookings
       SET status = 'overdue'
       WHERE status = 'in_progress'
         AND customer_until < now() - interval '2 hours'
       RETURNING id, request_id`
    )

    for (const b of result.rows) {
      await enqueueOutbox('rental_overdue', {
        bookingId: b.id,
        requestId: b.request_id,
      })
    }

    if (result.rows.length > 0) {
      logger.warn({ count: result.rows.length }, 'Rentals flagged overdue')
    }
    return result.rows.length
  }
}
