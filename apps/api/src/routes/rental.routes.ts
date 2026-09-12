import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { query } from '../lib/db'
import { requireAuth } from '../lib/auth'
import { requestRepo } from '../repositories'
import { RentalService } from '../services/rental.service'
import { getSearchCells, H3_RES_MID } from '../lib/h3'

const rentals = new RentalService()

const WindowSchema = z.object({
  from: z.string().datetime(),
  until: z.string().datetime(),
})

export async function rentalRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ─── Search available rentals for a window ──────────────────────────────────
  app.post('/rentals/search', async (req, reply) => {
    const Schema = WindowSchema.extend({
      categoryId: z.string().uuid(),
      lat: z.number().optional(),
      lng: z.number().optional(),
      maxPrice: z.number().int().positive().optional(),
    })

    const parsed = Schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }
    const d = parsed.data

    const h3Cells =
      d.lat && d.lng ? getSearchCells(d.lat, d.lng, H3_RES_MID, 3) : undefined

    const results = await rentals.findAvailable({
      categoryId: d.categoryId,
      from: d.from,
      until: d.until,
      h3Cells,
      maxPrice: d.maxPrice,
    })

    return reply.send({
      available: results,
      count: results.length,
      message:
        results.length === 0
          ? 'Nothing free for that window. Try different dates?'
          : `${results.length} available.`,
    })
  })

  // ─── Availability + price for one resource ──────────────────────────────────
  app.post<{ Params: { id: string } }>('/rentals/:id/quote', async (req, reply) => {
    const parsed = WindowSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const quote = await rentals.quote(req.params.id, parsed.data.from, parsed.data.until)
    if (!quote) return reply.code(404).send({ message: 'Resource not found' })

    return reply.send(quote)
  })

  // ─── Book a date range ──────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/rentals/:id/book', async (req, reply) => {
    const Schema = WindowSchema.extend({ requestId: z.string().uuid() })
    const parsed = Schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const owns = await requestRepo.isOwnedByCustomer(parsed.data.requestId, req.user!.id)
    if (!owns) {
      return reply.code(403).send({ message: 'Not your request' })
    }

    const quote = await rentals.quote(req.params.id, parsed.data.from, parsed.data.until)
    if (!quote) return reply.code(404).send({ message: 'Resource not found' })

    const result = await rentals.book({
      resourceId: req.params.id,
      requestId: parsed.data.requestId,
      from: parsed.data.from,
      until: parsed.data.until,
      depositAmount: quote.securityDeposit,
    })

    return reply.code(result.success ? 200 : 409).send({
      ...result,
      quote: result.success ? quote : undefined,
    })
  })

  // ─── Handover (vendor) ──────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/rentals/bookings/:id/handover', async (req, reply) => {
    const { conditionNotes, usageOut } = (req.body ?? {}) as {
      conditionNotes?: string
      usageOut?: number
    }

    const result = await rentals.handover(req.params.id, req.user!.id, {
      conditionNotes,
      usageOut,
    })
    return reply.code(result.success ? 200 : 409).send(result)
  })

  // ─── Return (vendor) ────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/rentals/bookings/:id/return', async (req, reply) => {
    const Schema = z.object({
      conditionNotes: z.string().max(1000).optional(),
      usageIn: z.number().optional(),
      damageReported: z.boolean().optional(),
      damageCharge: z.number().int().min(0).optional(),
    })

    const parsed = Schema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const result = await rentals.processReturn(req.params.id, req.user!.id, parsed.data)
    return reply.code(result.success ? 200 : 409).send(result)
  })

  // ─── Blackout a window (maintenance, owner use) ────────────────────────────
  app.post<{ Params: { id: string } }>('/rentals/:id/blackout', async (req, reply) => {
    const Schema = WindowSchema.extend({ reason: z.string().max(200).optional() })
    const parsed = Schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    // Only org members may black out their own resource
    const allowed = await query(
      `SELECT 1 FROM bookable_resources br
       JOIN organization_members om ON om.organization_id = br.organization_id
       WHERE br.id = $1 AND om.user_id = $2 AND om.can_accept_bookings = true`,
      [req.params.id, req.user!.id]
    )
    if (allowed.rowCount === 0) {
      return reply.code(403).send({ message: 'Not your resource' })
    }

    try {
      await query(
        `INSERT INTO resource_blackouts (resource_id, period, reason, created_by)
         VALUES ($1, tstzrange($2, $3), $4, $5)`,
        [req.params.id, parsed.data.from, parsed.data.until, parsed.data.reason ?? null, req.user!.id]
      )
      return reply.send({ success: true, message: 'Marked unavailable for that window.' })
    } catch (err) {
      if ((err as { code?: string }).code === '23P01') {
        return reply.code(409).send({
          message: 'That window overlaps an existing blackout.',
        })
      }
      throw err
    }
  })

  // ─── My active rentals ──────────────────────────────────────────────────────
  app.get('/rentals/mine', async (req, reply) => {
    const result = await query<{
      id: string
      resource_name: string
      org_name: string
      customer_from: string
      customer_until: string
      status: string
      deposit_amount: number | null
      deposit_status: string | null
    }>(
      `SELECT rb.id, br.name AS resource_name, o.display_name AS org_name,
              rb.customer_from, rb.customer_until, rb.status,
              rb.deposit_amount, rb.deposit_status
       FROM resource_bookings rb
       JOIN bookable_resources br ON br.id = rb.resource_id
       JOIN organizations o ON o.id = br.organization_id
       JOIN requests r ON r.id = rb.request_id
       WHERE r.customer_id = $1 AND rb.status <> 'cancelled'
       ORDER BY rb.customer_from DESC
       LIMIT 30`,
      [req.user!.id]
    )
    return reply.send({ rentals: result.rows })
  })

  // ─── Bundles (weddings and multi-vendor events) ─────────────────────────────
  const BundleSchema = z.object({
    title: z.string().min(2).max(160),
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    eventEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    venueArea: z.string().max(80).optional(),
    totalBudget: z.number().int().positive().optional(),
    guestCount: z.number().int().positive().optional(),
    items: z
      .array(
        z.object({
          roleLabel: z.string().min(2).max(60),
          categoryId: z.string().uuid().optional(),
          isRequired: z.boolean().optional(),
          budgetAllocation: z.number().int().min(0).optional(),
        })
      )
      .min(1)
      .max(20),
  })

  app.post('/bundles', async (req, reply) => {
    const parsed = BundleSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }
    const d = parsed.data

    const bundleResult = await query<{ id: string }>(
      `INSERT INTO booking_bundles
         (customer_id, title, event_date, event_end_date, venue_area,
          total_budget, guest_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        req.user!.id,
        d.title,
        d.eventDate ?? null,
        d.eventEndDate ?? null,
        d.venueArea ?? null,
        d.totalBudget ?? null,
        d.guestCount ?? null,
      ]
    )
    const bundleId = bundleResult.rows[0].id

    for (let i = 0; i < d.items.length; i++) {
      const item = d.items[i]
      await query(
        `INSERT INTO bundle_items
           (bundle_id, category_id, role_label, is_required,
            budget_allocation, display_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          bundleId,
          item.categoryId ?? null,
          item.roleLabel,
          item.isRequired ?? true,
          item.budgetAllocation ?? null,
          i,
        ]
      )
    }

    return reply.send({
      bundleId,
      itemCount: d.items.length,
      message:
        `"${d.title}" created with ${d.items.length} things to book. ` +
        `Tell me which one to start with and I'll find vendors for it.`,
    })
  })

  app.get('/bundles/mine', async (req, reply) => {
    const result = await query<{
      id: string
      title: string
      event_date: string | null
      status: string
      total_budget: number | null
      item_count: string
      booked_count: string
    }>(
      `SELECT b.id, b.title, b.event_date, b.status, b.total_budget,
              COUNT(bi.id) AS item_count,
              COUNT(bi.id) FILTER (WHERE bi.status = 'booked') AS booked_count
       FROM booking_bundles b
       LEFT JOIN bundle_items bi ON bi.bundle_id = b.id
       WHERE b.customer_id = $1 AND b.status <> 'cancelled'
       GROUP BY b.id
       ORDER BY b.event_date NULLS LAST`,
      [req.user!.id]
    )

    return reply.send({
      bundles: result.rows.map((b) => ({
        id: b.id,
        title: b.title,
        eventDate: b.event_date,
        status: b.status,
        totalBudget: b.total_budget,
        itemCount: Number(b.item_count),
        bookedCount: Number(b.booked_count),
      })),
    })
  })

  app.get<{ Params: { id: string } }>('/bundles/:id', async (req, reply) => {
    const items = await query<{
      id: string
      role_label: string
      status: string
      budget_allocation: number | null
      request_id: string | null
      category_name: string | null
      agreed_price: number | null
    }>(
      `SELECT bi.id, bi.role_label, bi.status, bi.budget_allocation,
              bi.request_id, sc.canonical_name AS category_name,
              r.agreed_price
       FROM bundle_items bi
       JOIN booking_bundles b ON b.id = bi.bundle_id
       LEFT JOIN service_categories sc ON sc.id = bi.category_id
       LEFT JOIN requests r ON r.id = bi.request_id
       WHERE bi.bundle_id = $1 AND b.customer_id = $2
       ORDER BY bi.display_order`,
      [req.params.id, req.user!.id]
    )

    const spent = items.rows.reduce((s, i) => s + (i.agreed_price ?? 0), 0)

    return reply.send({
      items: items.rows,
      totalSpent: spent,
    })
  })
}
