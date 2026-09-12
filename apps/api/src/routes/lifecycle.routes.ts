import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { query } from '../lib/db'
import { requireAuth } from '../lib/auth'
import { requestRepo, vendorRepo } from '../repositories'
import { BookingLifecycleService } from '../services/booking-lifecycle.service'
import { RecurringService } from '../services/recurring.service'
import { OrganizationService } from '../services/organization.service'

const lifecycle = new BookingLifecycleService()
const recurring = new RecurringService()
const orgs = new OrganizationService()

export async function lifecycleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ═══════════════════════════════════════════════════════════════════════════
  // RESCHEDULE
  // ═══════════════════════════════════════════════════════════════════════════
  app.post<{ Params: { id: string } }>('/requests/:id/reschedule', async (req, reply) => {
    const { newSlotId, reason } = (req.body ?? {}) as {
      newSlotId?: string
      reason?: string
    }
    if (!newSlotId) return reply.code(400).send({ message: 'newSlotId is required' })

    // Is the caller the customer or the vendor on this booking?
    const party = await requestRepo.resolveParty(req.params.id, req.user!.id)
    if (!party) {
      return reply.code(403).send({ message: 'Not your booking' })
    }

    const result = await lifecycle.reschedule({
      requestId: req.params.id,
      newSlotId,
      initiatedBy: party,
      userId: req.user!.id,
      reason,
    })

    return reply.code(result.success ? 200 : 409).send(result)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // NO-SHOW
  // ═══════════════════════════════════════════════════════════════════════════
  app.post<{ Params: { id: string } }>('/requests/:id/no-show', async (req, reply) => {
    const { party } = (req.body ?? {}) as { party?: 'customer' | 'vendor' }
    if (party !== 'customer' && party !== 'vendor') {
      return reply.code(400).send({ message: "party must be 'customer' or 'vendor'" })
    }

    const result = await lifecycle.reportNoShow({
      requestId: req.params.id,
      party,
      reportedBy: req.user!.id,
    })

    return reply.code(result.success ? 200 : 409).send(result)
  })

  app.post<{ Params: { id: string } }>('/no-shows/:id/dispute', async (req, reply) => {
    const { note } = (req.body ?? {}) as { note?: string }
    if (!note || note.length < 10) {
      return reply.code(400).send({
        message: 'Please explain what happened (at least 10 characters).',
      })
    }

    const result = await lifecycle.disputeNoShow(req.params.id, req.user!.id, note)
    return reply.code(result.success ? 200 : 404).send({
      ...result,
      message: result.success
        ? "Dispute recorded. Our team will review it and the score impact is paused meanwhile."
        : 'Could not find that no-show record, or it was already disputed.',
    })
  })

  // Confirm the appointment DID happen (the happy path of the no-show check)
  app.post<{ Params: { id: string } }>('/requests/:id/confirm-attended', async (req, reply) => {
    const completed = await requestRepo.completeAsParty(req.params.id, req.user!.id)
    if (!completed) {
      return reply.code(409).send({ message: 'Could not update that booking.' })
    }
    return reply.send({ success: true, message: 'Marked as completed.' })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // WAITLIST
  // ═══════════════════════════════════════════════════════════════════════════
  const WaitlistSchema = z.object({
    resourceId: z.string().uuid(),
    desiredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    desiredTimeFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    desiredTimeUntil: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    partySize: z.number().int().min(1).max(50).optional(),
    flexibleOnDate: z.boolean().optional(),
  })

  app.post<{ Params: { id: string } }>('/requests/:id/waitlist', async (req, reply) => {
    const parsed = WaitlistSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const owns = await requestRepo.isOwnedByCustomer(req.params.id, req.user!.id)
    if (!owns) {
      return reply.code(403).send({ message: 'Not your request' })
    }

    const result = await lifecycle.joinWaitlist({
      requestId: req.params.id,
      customerId: req.user!.id,
      ...parsed.data,
    })

    return reply.send(result)
  })

  app.post<{ Params: { id: string } }>('/waitlist/:id/claim', async (req, reply) => {
    const result = await lifecycle.claimWaitlistOffer(req.params.id, req.user!.id)
    return reply.code(result.success ? 200 : 409).send(result)
  })

  app.delete<{ Params: { id: string } }>('/waitlist/:id', async (req, reply) => {
    await query(
      `UPDATE waitlist_entries SET status = 'cancelled'
       WHERE id = $1 AND customer_id = $2 AND status IN ('waiting','offered')`,
      [req.params.id, req.user!.id]
    )
    return reply.send({ success: true, message: 'Removed from the waitlist.' })
  })

  app.get('/waitlist/mine', async (req, reply) => {
    const result = await query<{
      id: string
      resource_name: string
      org_name: string
      desired_date: string
      position: number
      status: string
      offer_expires_at: string | null
    }>(
      `SELECT w.id, br.name AS resource_name, o.display_name AS org_name,
              w.desired_date, w.position, w.status, w.offer_expires_at
       FROM waitlist_entries w
       JOIN bookable_resources br ON br.id = w.resource_id
       JOIN organizations o ON o.id = br.organization_id
       WHERE w.customer_id = $1 AND w.status IN ('waiting','offered')
       ORDER BY w.created_at DESC`,
      [req.user!.id]
    )
    return reply.send({ entries: result.rows })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // RECURRING BOOKINGS
  // ═══════════════════════════════════════════════════════════════════════════
  const RecurringSchema = z.object({
    vendorId: z.string().uuid().optional(),
    resourceId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    rawDescription: z.string().min(5).max(1000),
    attributes: z.record(z.unknown()).default({}),
    frequency: z.enum(['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'custom']),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/),
    durationMinutes: z.number().int().min(15).max(600).optional(),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    totalOccurrences: z.number().int().min(1).max(365).optional(),
    pricePerOccurrence: z.number().int().min(0).optional(),
    billing: z.enum(['per_occurrence', 'monthly', 'upfront']).optional(),
  })

  app.post('/recurring', async (req, reply) => {
    const parsed = RecurringSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const result = await recurring.create({
      customerId: req.user!.id,
      ...parsed.data,
    })

    return reply.send({
      ...result,
      message: parsed.data.vendorId
        ? `Set up: ${result.summary}. First ${result.firstOccurrences.length} ` +
          `bookings are confirmed.`
        : `Set up: ${result.summary}. Finding a vendor who can commit to this schedule.`,
    })
  })

  app.get('/recurring/mine', async (req, reply) => {
    const result = await query<{
      id: string
      raw_description: string
      frequency: string
      days_of_week: number[]
      time_of_day: string
      status: string
      price_per_occurrence: number | null
      completed_occurrences: number
      total_occurrences: number | null
      vendor_name: string | null
      next_occurrence: string | null
    }>(
      `SELECT rb.id, rb.raw_description, rb.frequency, rb.days_of_week,
              rb.time_of_day, rb.status, rb.price_per_occurrence,
              rb.completed_occurrences, rb.total_occurrences,
              u.name AS vendor_name,
              (SELECT MIN(expires_at) FROM requests
               WHERE recurring_booking_id = rb.id
                 AND status = 'confirmed' AND expires_at > now()) AS next_occurrence
       FROM recurring_bookings rb
       LEFT JOIN vendors v ON v.id = rb.vendor_id
       LEFT JOIN users u ON u.id = v.user_id
       WHERE rb.customer_id = $1 AND rb.status != 'cancelled'
       ORDER BY rb.created_at DESC`,
      [req.user!.id]
    )
    return reply.send({ series: result.rows })
  })

  app.get<{ Params: { id: string } }>('/recurring/:id/occurrences', async (req, reply) => {
    const result = await query<{
      id: string
      occurrence_number: number
      status: string
      expires_at: string
      agreed_price: number | null
    }>(
      `SELECT r.id, r.occurrence_number, r.status, r.expires_at, r.agreed_price
       FROM requests r
       JOIN recurring_bookings rb ON rb.id = r.recurring_booking_id
       WHERE r.recurring_booking_id = $1 AND rb.customer_id = $2
       ORDER BY r.expires_at ASC`,
      [req.params.id, req.user!.id]
    )
    return reply.send({ occurrences: result.rows })
  })

  app.post<{ Params: { id: string } }>('/requests/:id/skip', async (req, reply) => {
    const { reason } = (req.body ?? {}) as { reason?: string }
    const result = await recurring.skipOccurrence(req.params.id, req.user!.id, reason)
    return reply.code(result.success ? 200 : 409).send(result)
  })

  app.post<{ Params: { id: string } }>('/recurring/:id/pause', async (req, reply) => {
    const { from, until } = (req.body ?? {}) as { from?: string; until?: string }
    if (!from || !until) {
      return reply.code(400).send({ message: 'from and until dates are required' })
    }

    const result = await recurring.pause(req.params.id, req.user!.id, from, until)
    return reply.code(result.success ? 200 : 409).send({
      ...result,
      message: result.success
        ? `Paused. ${result.cancelledCount} upcoming bookings cancelled for that window.`
        : 'Could not pause that series.',
    })
  })

  app.post<{ Params: { id: string } }>('/recurring/:id/resume', async (req, reply) => {
    const ok = await recurring.resume(req.params.id, req.user!.id)
    return reply.code(ok ? 200 : 409).send({
      success: ok,
      message: ok ? 'Resumed. Upcoming bookings are back on.' : 'Could not resume.',
    })
  })

  app.delete<{ Params: { id: string } }>('/recurring/:id', async (req, reply) => {
    const result = await recurring.cancel(req.params.id, req.user!.id)
    return reply.code(result.success ? 200 : 409).send({
      ...result,
      message: result.success
        ? `Cancelled. ${result.cancelledCount} upcoming bookings removed. ` +
          `Past bookings stay in your history.`
        : 'Could not cancel that series.',
    })
  })

  // Vendor accepts a pending recurring series
  app.post<{ Params: { id: string } }>('/recurring/:id/accept', async (req, reply) => {
    const { pricePerOccurrence } = (req.body ?? {}) as { pricePerOccurrence?: number }
    if (!pricePerOccurrence || pricePerOccurrence <= 0) {
      return reply.code(400).send({ message: 'A price per visit is required' })
    }

    const vendorId = await vendorRepo.findIdByUserId(req.user!.id)
    if (!vendorId) return reply.code(400).send({ message: 'No vendor profile' })

    const result = await recurring.vendorAccept(
      req.params.id,
      vendorId,
      pricePerOccurrence
    )

    return reply.code(result.success ? 200 : 409).send({
      ...result,
      message: result.success
        ? `Accepted. ${result.occurrencesCreated} bookings scheduled.`
        : 'That series is no longer available.',
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // VENDOR DISRUPTION (cancel a day / a doctor's OPD / close the restaurant)
  // ═══════════════════════════════════════════════════════════════════════════
  const DisruptionSchema = z.object({
    organizationId: z.string().uuid(),
    resourceId: z.string().uuid().optional(),
    disruptionType: z.enum(['resource_unavailable', 'org_closed', 'slot_cancelled']),
    affectsFrom: z.string(),
    affectsUntil: z.string(),
    reason: z.string().min(3).max(500),
  })

  app.post('/disruptions', async (req, reply) => {
    const parsed = DisruptionSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const allowed = await orgs.checkPermission(
      req.user!.id,
      parsed.data.organizationId,
      'accept_bookings'
    )
    if (!allowed) {
      return reply.code(403).send({ message: 'You cannot manage this organization' })
    }

    const result = await lifecycle.createDisruption({
      ...parsed.data,
      createdBy: req.user!.id,
    })

    return reply.send(result)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // BOOKING FOR SOMEONE ELSE
  // ═══════════════════════════════════════════════════════════════════════════
  const BeneficiarySchema = z.object({
    name: z.string().min(2).max(120),
    relationship: z.string().max(40).optional(),
    phone: z.string().regex(/^\+91[6-9]\d{9}$/).optional(),
    age: z.number().int().min(0).max(120).optional(),
    gender: z.string().max(20).optional(),
  })

  app.post<{ Params: { id: string } }>('/requests/:id/beneficiary', async (req, reply) => {
    const parsed = BeneficiarySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const owns = await requestRepo.isOwnedByCustomer(req.params.id, req.user!.id)
    if (!owns) {
      return reply.code(403).send({ message: 'Not your booking' })
    }

    const d = parsed.data
    await query(
      `INSERT INTO booking_beneficiaries
         (request_id, name, relationship, phone, age, gender, consent_confirmed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.params.id,
        d.name,
        d.relationship ?? null,
        d.phone ?? null,
        d.age ?? null,
        d.gender ?? null,
        req.user!.id,
      ]
    )

    return reply.send({
      success: true,
      message: `Booking is for ${d.name}. The vendor will see their name and contact.`,
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // CANCELLATION POLICY (shown before confirming)
  // ═══════════════════════════════════════════════════════════════════════════
  app.get<{ Params: { id: string } }>('/requests/:id/policy', async (req, reply) => {
    const result = await query<{
      free_cancellation_hours: number
      late_cancellation_fee_percent: number
      no_show_fee_percent: number
      max_reschedules: number
      reschedule_notice_hours: number
      policy_text: string | null
      reschedule_count: number
    }>(
      `SELECT cp.free_cancellation_hours, cp.late_cancellation_fee_percent,
              cp.no_show_fee_percent, cp.max_reschedules,
              cp.reschedule_notice_hours, cp.policy_text, r.reschedule_count
       FROM requests r
       LEFT JOIN request_categories rc ON rc.request_id = r.id
       LEFT JOIN cancellation_policies cp
         ON cp.category_id = rc.category_id OR cp.organization_id = r.organization_id
       WHERE r.id = $1
       ORDER BY cp.organization_id NULLS LAST
       LIMIT 1`,
      [req.params.id]
    )

    const p = result.rows[0]
    return reply.send({
      freeCancellationHours: p?.free_cancellation_hours ?? 24,
      lateCancellationFeePercent: p?.late_cancellation_fee_percent ?? 0,
      noShowFeePercent: p?.no_show_fee_percent ?? 0,
      maxReschedules: p?.max_reschedules ?? 2,
      reschedulesUsed: p?.reschedule_count ?? 0,
      rescheduleNoticeHours: p?.reschedule_notice_hours ?? 4,
      policyText: p?.policy_text ?? 'Free cancellation up to 24 hours before.',
    })
  })
}
