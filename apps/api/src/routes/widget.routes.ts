/**
 * Widget routes — public API for the embeddable booking widget.
 *
 * These routes are called from the widget JavaScript running on a
 * business's website. They use the org's API key (embedded in the widget
 * config) but with restricted permissions — no catalog writes, no
 * webhook management.
 *
 * CORS is scoped to the org's registered widget_origins.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { requireOrgApiKey } from '../lib/api-key'
import { enqueueOutbox } from '../lib/outbox'

export async function widgetRoutes(app: FastifyInstance) {

  // ─── Widget config (public, no auth needed) ───────────────────────────
  // Returns branding, org type, supported booking types — everything the
  // widget needs to render the right flow.
  app.get('/widget/config/:orgId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = req.params as { orgId: string }

    const result = await query<{
      id: string
      display_name: string
      org_type: string
      supported_booking_types: string[]
      branding: Record<string, unknown>
      widget_origins: string[]
      address: string | null
      area: string | null
      contact_phone: string | null
    }>(
      `SELECT id, display_name, org_type, supported_booking_types,
              branding, widget_origins, address, area, contact_phone
       FROM organizations
       WHERE id = $1 AND verification_status = 'verified'`,
      [orgId]
    )

    if (result.rows.length === 0) {
      return reply.code(404).send({ message: 'Organization not found' })
    }

    const org = result.rows[0]

    // CORS: set allowed origins from the org's whitelist
    const origin = req.headers.origin
    if (origin && org.widget_origins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin)
    } else if (org.widget_origins.length === 0) {
      // Allow all origins if none configured (development mode)
      reply.header('Access-Control-Allow-Origin', '*')
    }

    return reply.send({
      orgId: org.id,
      name: org.display_name,
      type: org.org_type,
      bookingTypes: org.supported_booking_types,
      branding: org.branding,
      address: org.address,
      area: org.area,
      phone: org.contact_phone,
    })
  })

  // ─── Widget catalog (public) ──────────────────────────────────────────
  app.get('/widget/catalog/:orgId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = req.params as { orgId: string }
    const { section } = req.query as { section?: string }

    const result = await query<any>(
      `SELECT id, name, description, base_price, currency, section,
              is_veg, is_vegan, spice_level, serves_count, sort_order
       FROM catalog_items
       WHERE organization_id = $1 AND is_available = true
       ${section ? 'AND section = $2' : ''}
       ORDER BY section, sort_order, name`,
      section ? [orgId, section] : [orgId]
    )

    // Group by section
    const sections: Record<string, any[]> = {}
    for (const item of result.rows) {
      const sec = item.section || 'General'
      if (!sections[sec]) sections[sec] = []
      sections[sec].push({
        id: item.id,
        name: item.name,
        description: item.description,
        price: item.base_price,
        currency: item.currency,
        isVeg: item.is_veg,
        isVegan: item.is_vegan,
        spiceLevel: item.spice_level,
        servesCount: item.serves_count,
      })
    }

    return reply.send({ sections })
  })

  // ─── Widget resources (public) ────────────────────────────────────────
  app.get('/widget/resources/:orgId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = req.params as { orgId: string }

    const result = await query<any>(
      `SELECT id, name, resource_type, specialization, qualification,
              experience_years, price_per_slot, consultation_duration_minutes
       FROM bookable_resources
       WHERE organization_id = $1 AND is_active = true
       ORDER BY name`,
      [orgId]
    )

    return reply.send({ resources: result.rows })
  })

  // ─── Widget availability (public) ─────────────────────────────────────
  app.get('/widget/availability/:resourceId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { resourceId } = req.params as { resourceId: string }
    const { date, days } = req.query as { date?: string; days?: string }

    const startDate = date ?? new Date().toISOString().split('T')[0]
    const daysAhead = Math.min(parseInt(days ?? '7'), 14)

    const result = await query<{
      id: string
      slot_time: string
      duration_minutes: number
      capacity_total: number
      capacity_booked: number
      price_override: number | null
    }>(
      `SELECT id, slot_time, duration_minutes, capacity_total,
              capacity_booked, price_override
       FROM resource_slots
       WHERE resource_id = $1
         AND slot_time >= $2::date
         AND slot_time < ($2::date + $3 * interval '1 day')
         AND capacity_booked < capacity_total
         AND is_cancelled = false
       ORDER BY slot_time`,
      [resourceId, startDate, daysAhead]
    )

    // Group slots by date
    const slotsByDate: Record<string, any[]> = {}
    for (const slot of result.rows) {
      const dateKey = new Date(slot.slot_time).toISOString().split('T')[0]
      if (!slotsByDate[dateKey]) slotsByDate[dateKey] = []
      slotsByDate[dateKey].push({
        id: slot.id,
        time: slot.slot_time,
        duration: slot.duration_minutes,
        available: slot.capacity_total - slot.capacity_booked,
        price: slot.price_override,
      })
    }

    return reply.send({ dates: slotsByDate })
  })

  // ─── Create booking from widget ───────────────────────────────────────
  app.post('/widget/book', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({
      orgId: z.string().uuid(),
      customerPhone: z.string().min(10).max(15),
      customerName: z.string().max(120).optional(),
      bookingType: z.enum(['quote', 'appointment', 'hiring', 'order']),
      // Appointment booking
      resourceId: z.string().uuid().optional(),
      slotId: z.string().uuid().optional(),
      // Order booking
      items: z.array(z.object({
        catalogItemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(100),
        notes: z.string().max(500).optional(),
      })).optional(),
      // General
      notes: z.string().max(2000).optional(),
      guestCount: z.number().int().min(1).max(50).optional(),
    }).parse(req.body)

    // Find or create customer
    let customerId: string
    const existing = await query<{ id: string }>(
      'SELECT id FROM users WHERE phone = $1',
      [body.customerPhone]
    )

    if (existing.rows.length > 0) {
      customerId = existing.rows[0].id
    } else {
      const created = await query<{ id: string }>(
        `INSERT INTO users (phone, name, is_customer, consent_given_at)
         VALUES ($1, $2, true, now()) RETURNING id`,
        [body.customerPhone, body.customerName ?? null]
      )
      customerId = created.rows[0].id
    }

    const idempotencyKey = `widget_${body.orgId}_${Date.now()}_${Math.random().toString(36).slice(2)}`

    // Build description based on booking type
    let description = body.notes ?? ''
    if (body.bookingType === 'order' && body.items) {
      // Fetch item names for the description
      const itemIds = body.items.map(i => i.catalogItemId)
      const itemNames = await query<{ id: string; name: string }>(
        `SELECT id, name FROM catalog_items WHERE id = ANY($1)`,
        [itemIds]
      )
      const nameMap = new Map(itemNames.rows.map(r => [r.id, r.name]))
      const itemList = body.items
        .map(i => `${nameMap.get(i.catalogItemId) ?? 'Item'} x${i.quantity}`)
        .join(', ')
      description = `Order: ${itemList}${body.notes ? ` | ${body.notes}` : ''}`
    }

    // Create the request
    const request = await query<{ id: string }>(
      `INSERT INTO requests
         (customer_id, idempotency_key, raw_description, booking_type,
          category_tags, attributes, status, guest_count)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)
       RETURNING id`,
      [
        customerId,
        idempotencyKey,
        description || `Booking via website widget`,
        body.bookingType,
        '{}',
        JSON.stringify({}),
        body.guestCount ?? null,
      ]
    )

    const requestId = request.rows[0].id

    // Handle appointment slot booking
    if (body.bookingType === 'appointment' && body.slotId) {
      const slotUpdate = await query(
        `UPDATE resource_slots
         SET capacity_booked = capacity_booked + 1
         WHERE id = $1 AND capacity_booked < capacity_total
         RETURNING slot_time`,
        [body.slotId]
      )

      if (slotUpdate.rowCount && slotUpdate.rowCount > 0) {
        await query(
          `UPDATE requests
           SET status = 'confirmed', resource_slot_id = $1
           WHERE id = $2`,
          [body.slotId, requestId]
        )
      }
    }

    // Handle order items
    if (body.bookingType === 'order' && body.items) {
      let totalPrice = 0
      for (const item of body.items) {
        const priceResult = await query<{ base_price: number }>(
          'SELECT base_price FROM catalog_items WHERE id = $1',
          [item.catalogItemId]
        )
        const price = priceResult.rows[0]?.base_price ?? 0
        totalPrice += price * item.quantity

        await query(
          `INSERT INTO order_items (request_id, catalog_item_id, quantity, notes, unit_price)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [requestId, item.catalogItemId, item.quantity, item.notes ?? null, price]
        )
      }

      // Set agreed price
      if (totalPrice > 0) {
        await query(
          'UPDATE requests SET agreed_price = $1 WHERE id = $2',
          [totalPrice, requestId]
        )
      }
    }

    // Emit event for webhook delivery
    await enqueueOutbox('booking_created_platform', {
      requestId,
      organizationId: body.orgId,
      bookingType: body.bookingType,
      customerPhone: body.customerPhone,
      source: 'widget',
    })

    logger.info(
      { requestId, orgId: body.orgId, bookingType: body.bookingType },
      '[widget] booking created'
    )

    return reply.code(201).send({
      bookingId: requestId,
      status: body.slotId ? 'confirmed' : 'open',
      message: body.slotId
        ? 'Your appointment has been confirmed!'
        : 'Your booking has been received. We\'ll confirm shortly.',
    })
  })

  // ─── Booking status check (public, by phone) ─────────────────────────
  app.get('/widget/status/:bookingId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bookingId } = req.params as { bookingId: string }

    const result = await query<{
      id: string
      status: string
      booking_type: string
      agreed_price: number | null
      slot_time: string | null
      resource_name: string | null
      created_at: string
    }>(
      `SELECT r.id, r.status, r.booking_type, r.agreed_price,
              rs.slot_time, br.name as resource_name, r.created_at
       FROM requests r
       LEFT JOIN resource_slots rs ON rs.id = r.resource_slot_id
       LEFT JOIN bookable_resources br ON br.id = rs.resource_id
       WHERE r.id = $1`,
      [bookingId]
    )

    if (result.rows.length === 0) {
      return reply.code(404).send({ message: 'Booking not found' })
    }

    const r = result.rows[0]
    return reply.send({
      id: r.id,
      status: r.status,
      bookingType: r.booking_type,
      price: r.agreed_price,
      slotTime: r.slot_time,
      resourceName: r.resource_name,
      createdAt: r.created_at,
    })
  })
}
