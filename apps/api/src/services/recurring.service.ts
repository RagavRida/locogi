/**
 * RecurringService — standing bookings.
 *
 * A large slice of Indian household services is recurring, not one-off:
 * a maid every morning, a cook twice a day, tiffin delivered daily, a
 * physio course of 12 sessions, house cleaning every Sunday.
 *
 * Without this, a customer would have to raise a fresh request every single
 * day and re-match to a possibly different vendor each time — which defeats
 * the point of having a trusted maid.
 *
 * Design: store the RULE, materialise a rolling window of concrete request
 * rows. Each occurrence is a real booking that can be individually skipped,
 * rescheduled, or marked complete, but they all belong to one series with
 * one vendor.
 */

import { query, withTransaction } from '../lib/db'
import { logger } from '../lib/logger'
import { requestRepo } from '../repositories'
import { v4 as uuidv4 } from 'uuid'

export type Frequency =
  | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'custom'

export class RecurringService {

  // ─── Create a series ────────────────────────────────────────────────────────
  async create(params: {
    customerId: string
    vendorId?: string
    resourceId?: string
    categoryId?: string
    rawDescription: string
    attributes: Record<string, unknown>
    frequency: Frequency
    daysOfWeek?: number[]
    timeOfDay: string          // '07:30'
    durationMinutes?: number
    startsOn: string           // '2026-08-10'
    endsOn?: string
    totalOccurrences?: number
    pricePerOccurrence?: number
    billing?: 'per_occurrence' | 'monthly' | 'upfront'
  }): Promise<{
    recurringId: string
    firstOccurrences: string[]
    summary: string
  }> {

    const days = this.resolveDays(params.frequency, params.daysOfWeek)

    const result = await query<{ id: string }>(
      `INSERT INTO recurring_bookings
         (customer_id, vendor_id, resource_id, category_id, raw_description,
          attributes, frequency, days_of_week, time_of_day, duration_minutes,
          starts_on, ends_on, total_occurrences, price_per_occurrence, billing,
          status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               CASE WHEN $2::uuid IS NULL THEN 'pending_vendor' ELSE 'active' END)
       RETURNING id`,
      [
        params.customerId,
        params.vendorId ?? null,
        params.resourceId ?? null,
        params.categoryId ?? null,
        params.rawDescription,
        JSON.stringify(params.attributes),
        params.frequency,
        days,
        params.timeOfDay,
        params.durationMinutes ?? 60,
        params.startsOn,
        params.endsOn ?? null,
        params.totalOccurrences ?? null,
        params.pricePerOccurrence ?? null,
        params.billing ?? 'per_occurrence',
      ]
    )

    const recurringId = result.rows[0].id

    // Materialise the first two weeks immediately so the customer sees
    // concrete dates rather than an abstract promise
    const created = params.vendorId
      ? await this.materialize(recurringId, 14)
      : []

    logger.info(
      { recurringId, frequency: params.frequency, occurrences: created.length },
      'Recurring booking created'
    )

    return {
      recurringId,
      firstOccurrences: created,
      summary: this.describeSeries(
        params.frequency,
        days,
        params.timeOfDay,
        params.totalOccurrences,
        params.endsOn
      ),
    }
  }

  // ─── Materialise concrete occurrences ──────────────────────────────────────
  async materialize(recurringId: string, daysAhead = 21): Promise<string[]> {
    const seriesResult = await query<{
      id: string
      customer_id: string
      vendor_id: string | null
      resource_id: string | null
      category_id: string | null
      raw_description: string
      attributes: Record<string, unknown>
      days_of_week: number[]
      time_of_day: string
      duration_minutes: number
      starts_on: string
      ends_on: string | null
      total_occurrences: number | null
      completed_occurrences: number
      price_per_occurrence: number | null
      last_materialized_until: string | null
      pause_from: string | null
      pause_until: string | null
      status: string
    }>(
      'SELECT * FROM recurring_bookings WHERE id = $1',
      [recurringId]
    )

    const s = seriesResult.rows[0]
    if (!s || s.status !== 'active' || !s.vendor_id) return []

    // Start from the watermark, or the series start date
    const from = s.last_materialized_until
      ? new Date(new Date(s.last_materialized_until).getTime() + 86_400_000)
      : new Date(s.starts_on)

    const horizon = new Date(Date.now() + daysAhead * 86_400_000)
    const seriesEnd = s.ends_on ? new Date(s.ends_on) : null
    const until = seriesEnd && seriesEnd < horizon ? seriesEnd : horizon

    // Respect an occurrence cap (e.g. a 12-session physio course)
    let remaining = s.total_occurrences
      ? s.total_occurrences - s.completed_occurrences
      : Infinity

    const [hh, mm] = s.time_of_day.split(':').map(Number)
    const created: string[] = []

    for (
      let d = new Date(from);
      d <= until && remaining > 0;
      d = new Date(d.getTime() + 86_400_000)
    ) {
      // IST day-of-week
      const istDay = new Date(
        d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
      ).getDay()
      if (!s.days_of_week.includes(istDay)) continue

      // Skip a paused window
      if (s.pause_from && s.pause_until) {
        const day = d.toISOString().split('T')[0]
        if (day >= s.pause_from && day <= s.pause_until) continue
      }

      const occurrenceAt = new Date(d)
      occurrenceAt.setHours(hh, mm, 0, 0)
      if (occurrenceAt <= new Date()) continue

      // Deterministic idempotency key so re-running never duplicates
      const idempotencyKey = `rec_${recurringId}_${occurrenceAt.toISOString().split('T')[0]}`

      const inserted = await query<{ id: string }>(
        `INSERT INTO requests
           (customer_id, idempotency_key, raw_description, attributes,
            booking_type, status, confirmed_vendor_id, resource_id,
            agreed_price, recurring_booking_id, occurrence_number, expires_at)
         VALUES ($1,$2,$3,$4,'appointment','confirmed',$5,$6,$7,$8,$9,$10)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          s.customer_id,
          idempotencyKey,
          s.raw_description,
          JSON.stringify(s.attributes),
          s.vendor_id,
          s.resource_id,
          s.price_per_occurrence,
          recurringId,
          s.completed_occurrences + created.length + 1,
          occurrenceAt.toISOString(),
        ]
      )

      if (inserted.rows[0]) {
        created.push(inserted.rows[0].id)
        remaining--

        // Link to the category so it shows up in the right place
        if (s.category_id) {
          await query(
            `INSERT INTO request_categories (request_id, category_id, confidence)
             VALUES ($1, $2, 1.0)
             ON CONFLICT DO NOTHING`,
            [inserted.rows[0].id, s.category_id]
          )
        }
      }
    }

    await query(
      `UPDATE recurring_bookings
       SET last_materialized_until = $2, updated_at = now()
       WHERE id = $1`,
      [recurringId, until.toISOString().split('T')[0]]
    )

    // Series finished?
    if (
      s.total_occurrences &&
      s.completed_occurrences + created.length >= s.total_occurrences
    ) {
      await query(
        `UPDATE recurring_bookings SET status = 'completed' WHERE id = $1`,
        [recurringId]
      )
    }

    return created
  }

  // ─── Skip a single occurrence (going out of town on Tuesday) ───────────────
  async skipOccurrence(
    requestId: string,
    customerId: string,
    reason?: string
  ): Promise<{ success: boolean; message: string }> {
    const result = await requestRepo.cancelRecurringOccurrence(requestId, customerId)

    if (!result.cancelled) {
      return { success: false, message: 'Could not skip that one — already past or changed.' }
    }

    await query(
      `INSERT INTO messages (request_id, sender_id, text, message_type)
       VALUES ($1, $2, $3, 'system')`,
      [
        requestId,
        customerId,
        `Customer skipped this occurrence.${reason ? ` Reason: ${reason}` : ''}`,
      ]
    )

    return {
      success: true,
      message: 'Skipped just this one. The rest of your schedule is unchanged.',
    }
  }

  // ─── Pause a series (travelling for two weeks) ─────────────────────────────
  async pause(
    recurringId: string,
    customerId: string,
    from: string,
    until: string
  ): Promise<{ success: boolean; cancelledCount: number }> {
    return withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE recurring_bookings
         SET status = 'paused', pause_from = $3::date, pause_until = $4::date,
             updated_at = now()
         WHERE id = $1 AND customer_id = $2 AND status = 'active'`,
        [recurringId, customerId, from, until]
      )

      if (upd.rowCount === 0) return { success: false, cancelledCount: 0 }

      // Cancel already-materialised occurrences inside the pause window
      const cancelled = await requestRepo.cancelRecurringOccurrences(recurringId, { from, until })

      return { success: true, cancelledCount: cancelled }
    })
  }

  async resume(recurringId: string, customerId: string): Promise<boolean> {
    const result = await query(
      `UPDATE recurring_bookings
       SET status = 'active', pause_from = NULL, pause_until = NULL,
           updated_at = now()
       WHERE id = $1 AND customer_id = $2 AND status = 'paused'`,
      [recurringId, customerId]
    )
    if ((result.rowCount ?? 0) > 0) {
      await this.materialize(recurringId, 21)
      return true
    }
    return false
  }

  // ─── Cancel the whole series ───────────────────────────────────────────────
  async cancel(
    recurringId: string,
    customerId: string
  ): Promise<{ success: boolean; cancelledCount: number }> {
    return withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE recurring_bookings
         SET status = 'cancelled', updated_at = now()
         WHERE id = $1 AND customer_id = $2
           AND status IN ('active','paused','pending_vendor')`,
        [recurringId, customerId]
      )
      if (upd.rowCount === 0) return { success: false, cancelledCount: 0 }

      // Cancel all future occurrences, leave past ones intact for history
      const cancelled = await requestRepo.cancelRecurringOccurrences(recurringId)

      return { success: true, cancelledCount: cancelled }
    })
  }

  // ─── Vendor accepts a pending series ──────────────────────────────────────
  async vendorAccept(
    recurringId: string,
    vendorId: string,
    pricePerOccurrence: number
  ): Promise<{ success: boolean; occurrencesCreated: number }> {
    const upd = await query(
      `UPDATE recurring_bookings
       SET vendor_id = $2, price_per_occurrence = $3,
           status = 'active', updated_at = now()
       WHERE id = $1 AND status = 'pending_vendor'`,
      [recurringId, vendorId, pricePerOccurrence]
    )
    if (upd.rowCount === 0) return { success: false, occurrencesCreated: 0 }

    const created = await this.materialize(recurringId, 21)
    return { success: true, occurrencesCreated: created.length }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  private resolveDays(freq: Frequency, explicit?: number[]): number[] {
    switch (freq) {
      case 'daily':
        return [0, 1, 2, 3, 4, 5, 6]
      case 'weekdays':
        return [1, 2, 3, 4, 5]
      case 'weekly':
      case 'biweekly':
      case 'monthly':
      case 'custom':
        return explicit && explicit.length > 0 ? explicit : [1]
      default:
        return [1]
    }
  }

  private describeSeries(
    freq: Frequency,
    days: number[],
    time: string,
    total?: number,
    endsOn?: string
  ): string {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const [hh, mm] = time.split(':').map(Number)
    const period = hh >= 12 ? 'pm' : 'am'
    const hour12 = hh % 12 === 0 ? 12 : hh % 12
    const timeStr = `${hour12}:${String(mm).padStart(2, '0')} ${period}`

    let when: string
    if (freq === 'daily') when = 'every day'
    else if (freq === 'weekdays') when = 'Monday to Friday'
    else if (days.length === 7) when = 'every day'
    else if (days.length === 1) when = `every ${dayNames[days[0]]}`
    else when = days.map((d) => dayNames[d].slice(0, 3)).join(', ')

    let term = ''
    if (total) term = `, ${total} sessions total`
    else if (endsOn) {
      const end = new Date(endsOn).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short',
      })
      term = `, until ${end}`
    }

    return `${when} at ${timeStr}${term}`
  }
}
