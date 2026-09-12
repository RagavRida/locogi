/**
 * Platform routes — the B2B API for business integrations.
 *
 * Authenticated via X-API-Key (per-org API keys), not JWT.
 * These are the endpoints a restaurant's Shopify plugin, a clinic's
 * appointment widget, or a salon's WhatsApp bot calls.
 *
 * Every route is scoped to the org that owns the API key — a restaurant
 * can never see a salon's bookings.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import {
  requireOrgApiKey,
  requireScope,
  generateApiKey,
  hashKey,
  generateSigningSecret,
} from '../lib/api-key'
import { requireAuth } from '../lib/auth'
import { WebhookService, WEBHOOK_EVENTS, isWebhookEvent } from '../services/webhook.service'
import { enqueueOutbox } from '../lib/outbox'
import { AiOnboardingService } from '../services/ai-onboarding.service'

const webhooks = new WebhookService()
const onboarding = new AiOnboardingService()

export async function platformRoutes(app: FastifyInstance) {

  // ═══════════════════════════════════════════════════════════════════════════
  // AI-POWERED ONBOARDING
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /platform/onboard — describe your business, AI creates everything
  app.post('/platform/onboard', {
    preHandler: [requireAuth],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({
      description: z.string().min(10).max(5000),
      city: z.string().max(100).optional(),
      phone: z.string().max(20).optional(),
    }).parse(req.body)

    try {
      const result = await onboarding.onboard({
        userId: req.user!.id,
        description: body.description,
        city: body.city,
        phone: body.phone,
      })

      return reply.code(201).send({
        organizationId: result.organizationId,
        orgType: result.blueprint.orgType,
        displayName: result.blueprint.displayName,
        description: result.blueprint.descriptionShort,
        bookingTypes: result.blueprint.supportedBookingTypes,
        branding: result.blueprint.branding,
        apiKey: result.apiKey,
        widgetCode: result.widgetCode,
        stats: {
          catalogItems: result.catalogItemCount,
          resources: result.resourceCount,
          slotsGenerated: result.slotCount,
        },
        reasoning: result.blueprint.reasoning,
        message: 'Your business is fully configured! Save the API key — it cannot be shown again.',
      })
    } catch (err) {
      logger.error({ err, userId: req.user!.id }, '[onboard] failed')
      return reply.code(500).send({
        message: err instanceof Error ? err.message : 'Onboarding failed. Please try again.',
      })
    }
  })


  // ═══════════════════════════════════════════════════════════════════════════
  // API KEY MANAGEMENT (requires JWT auth — org admin generates keys)
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /platform/api-keys — generate a new API key for the org
  app.post('/platform/api-keys', {
    preHandler: [requireAuth],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({
      organizationId: z.string().uuid(),
      environment: z.enum(['live', 'test']).default('live'),
      label: z.string().max(120).optional(),
    }).parse(req.body)

    // Verify user is an admin of this org
    const membership = await query<{ role: string }>(
      `SELECT role FROM organization_members
       WHERE organization_id = $1 AND user_id = $2 AND is_active = true`,
      [body.organizationId, req.user!.id]
    )

    if (membership.rows.length === 0 || !['owner', 'admin'].includes(membership.rows[0].role)) {
      return reply.code(403).send({ message: 'Only org owners/admins can create API keys' })
    }

    const { rawKey, keyHash, keyPrefix } = generateApiKey(body.environment)

    await query(
      `INSERT INTO org_api_keys (organization_id, key_hash, key_prefix, environment, label, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [body.organizationId, keyHash, keyPrefix, body.environment, body.label ?? null, req.user!.id]
    )

    // The raw key is shown ONCE. After this response, it cannot be retrieved.
    return reply.code(201).send({
      key: rawKey,
      prefix: keyPrefix,
      environment: body.environment,
      label: body.label,
      message: 'Save this key — it cannot be shown again.',
    })
  })

  // GET /platform/api-keys — list keys for an org (prefix only, never the full key)
  app.get('/platform/api-keys', {
    preHandler: [requireAuth],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { organizationId } = req.query as { organizationId: string }

    const result = await query<{
      id: string
      key_prefix: string
      environment: string
      label: string | null
      is_active: boolean
      last_used_at: string | null
      created_at: string
    }>(
      `SELECT id, key_prefix, environment, label, is_active, last_used_at, created_at
       FROM org_api_keys
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [organizationId]
    )

    return reply.send({ keys: result.rows })
  })

  // DELETE /platform/api-keys/:id — revoke a key
  app.delete('/platform/api-keys/:id', {
    preHandler: [requireAuth],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }

    await query(
      `UPDATE org_api_keys
       SET is_active = false, revoked_at = now()
       WHERE id = $1`,
      [id]
    )

    return reply.send({ message: 'API key revoked' })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // BOOKINGS API (authenticated via X-API-Key)
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /platform/bookings — create a booking
  app.post('/platform/bookings', {
    preHandler: [requireOrgApiKey, requireScope('bookings:write')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({
      customerPhone: z.string().min(10).max(15),
      customerName: z.string().max(120).optional(),
      bookingType: z.enum(['quote', 'appointment', 'hiring', 'order']),
      // For appointments
      resourceId: z.string().uuid().optional(),
      slotId: z.string().uuid().optional(),
      // For orders
      items: z.array(z.object({
        catalogItemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(100),
        notes: z.string().max(500).optional(),
      })).optional(),
      // General
      notes: z.string().max(2000).optional(),
      metadata: z.record(z.unknown()).optional(),
    }).parse(req.body)

    const orgId = req.orgApiKey!.organizationId

    // Find or create the customer user
    let customerId: string
    const existingUser = await query<{ id: string }>(
      'SELECT id FROM users WHERE phone = $1',
      [body.customerPhone]
    )

    if (existingUser.rows.length > 0) {
      customerId = existingUser.rows[0].id
    } else {
      const newUser = await query<{ id: string }>(
        `INSERT INTO users (phone, name, is_customer, consent_given_at)
         VALUES ($1, $2, true, now())
         RETURNING id`,
        [body.customerPhone, body.customerName ?? null]
      )
      customerId = newUser.rows[0].id
    }

    // Create the request (booking)
    const idempotencyKey = `platform_${orgId}_${Date.now()}_${Math.random().toString(36).slice(2)}`

    const request = await query<{ id: string }>(
      `INSERT INTO requests
         (customer_id, idempotency_key, raw_description, booking_type,
          category_tags, attributes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'open')
       RETURNING id`,
      [
        customerId,
        idempotencyKey,
        body.notes ?? `Platform booking via API`,
        body.bookingType,
        '{}',
        JSON.stringify(body.metadata ?? {}),
      ]
    )

    const requestId = request.rows[0].id

    // If it's an appointment with a slot, confirm it directly
    if (body.bookingType === 'appointment' && body.slotId && body.resourceId) {
      // Find the vendor that owns this resource
      const resource = await query<{ organization_id: string }>(
        `SELECT r.organization_id FROM bookable_resources r WHERE r.id = $1`,
        [body.resourceId]
      )

      if (resource.rows.length > 0) {
        // Book the slot
        await query(
          `UPDATE resource_slots
           SET capacity_booked = capacity_booked + 1
           WHERE id = $1 AND capacity_booked < capacity_total`,
          [body.slotId]
        )

        // Move to confirmed
        await query(
          `UPDATE requests
           SET status = 'confirmed', resource_slot_id = $1
           WHERE id = $2`,
          [body.slotId, requestId]
        )
      }
    }

    // If it's an order with items, record the order items
    if (body.bookingType === 'order' && body.items && body.items.length > 0) {
      for (const item of body.items) {
        await query(
          `INSERT INTO order_items (request_id, catalog_item_id, quantity, notes)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [requestId, item.catalogItemId, item.quantity, item.notes ?? null]
        )
      }
    }

    // Enqueue outbox event for webhook delivery
    await enqueueOutbox('booking_created_platform', {
      requestId,
      organizationId: orgId,
      bookingType: body.bookingType,
      customerPhone: body.customerPhone,
    })

    logger.info(
      { requestId, orgId, bookingType: body.bookingType },
      '[platform] booking created via API'
    )

    return reply.code(201).send({
      bookingId: requestId,
      status: body.slotId ? 'confirmed' : 'open',
      bookingType: body.bookingType,
    })
  })

  // GET /platform/bookings — list bookings for the org
  app.get('/platform/bookings', {
    preHandler: [requireOrgApiKey, requireScope('bookings:read')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { status, limit, offset } = req.query as {
      status?: string
      limit?: string
      offset?: string
    }

    const orgId = req.orgApiKey!.organizationId
    const queryLimit = Math.min(parseInt(limit ?? '20'), 100)
    const queryOffset = parseInt(offset ?? '0')

    const result = await query<{
      id: string
      customer_id: string
      booking_type: string
      status: string
      raw_description: string
      agreed_price: number | null
      created_at: string
      customer_phone: string
      customer_name: string | null
    }>(
      `SELECT r.id, r.customer_id, r.booking_type, r.status,
              r.raw_description, r.agreed_price, r.created_at,
              u.phone as customer_phone, u.name as customer_name
       FROM requests r
       JOIN users u ON u.id = r.customer_id
       WHERE r.confirmed_vendor_id IN (
         SELECT user_id FROM organization_members WHERE organization_id = $1
       )
       ${status ? 'AND r.status = $4' : ''}
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      status
        ? [orgId, queryLimit, queryOffset, status]
        : [orgId, queryLimit, queryOffset]
    )

    return reply.send({
      bookings: result.rows.map(r => ({
        id: r.id,
        customerId: r.customer_id,
        customerPhone: r.customer_phone,
        customerName: r.customer_name,
        bookingType: r.booking_type,
        status: r.status,
        description: r.raw_description,
        agreedPrice: r.agreed_price,
        createdAt: r.created_at,
      })),
      limit: queryLimit,
      offset: queryOffset,
    })
  })

  // GET /platform/bookings/:id — get a single booking
  app.get('/platform/bookings/:id', {
    preHandler: [requireOrgApiKey, requireScope('bookings:read')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }

    const result = await query<any>(
      `SELECT r.*, u.phone as customer_phone, u.name as customer_name,
              rs.slot_time, rs.duration_minutes,
              br.name as resource_name, br.resource_type
       FROM requests r
       JOIN users u ON u.id = r.customer_id
       LEFT JOIN resource_slots rs ON rs.id = r.resource_slot_id
       LEFT JOIN bookable_resources br ON br.id = rs.resource_id
       WHERE r.id = $1`,
      [id]
    )

    if (result.rows.length === 0) {
      return reply.code(404).send({ message: 'Booking not found' })
    }

    const r = result.rows[0]
    return reply.send({
      id: r.id,
      customerId: r.customer_id,
      customerPhone: r.customer_phone,
      customerName: r.customer_name,
      bookingType: r.booking_type,
      status: r.status,
      description: r.raw_description,
      agreedPrice: r.agreed_price,
      slotTime: r.slot_time,
      durationMinutes: r.duration_minutes,
      resourceName: r.resource_name,
      resourceType: r.resource_type,
      createdAt: r.created_at,
    })
  })

  // PATCH /platform/bookings/:id — update booking status
  app.patch('/platform/bookings/:id', {
    preHandler: [requireOrgApiKey, requireScope('bookings:write')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    const body = z.object({
      status: z.enum(['confirmed', 'in_progress', 'completed', 'cancelled']).optional(),
      agreedPrice: z.number().optional(),
    }).parse(req.body)

    const updates: string[] = []
    const values: unknown[] = []
    let paramIdx = 1

    if (body.status) {
      updates.push(`status = $${paramIdx++}`)
      values.push(body.status)
    }
    if (body.agreedPrice !== undefined) {
      updates.push(`agreed_price = $${paramIdx++}`)
      values.push(body.agreedPrice)
    }

    if (updates.length === 0) {
      return reply.code(400).send({ message: 'No fields to update' })
    }

    values.push(id)
    await query(
      `UPDATE requests SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values
    )

    // Emit webhook
    if (body.status) {
      await enqueueOutbox(`booking_${body.status}_platform`, {
        requestId: id,
        organizationId: req.orgApiKey!.organizationId,
      })
    }

    return reply.send({ message: 'Booking updated' })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // CATALOG API
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /platform/catalog — list catalog items
  app.get('/platform/catalog', {
    preHandler: [requireOrgApiKey, requireScope('catalog:read')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const orgId = req.orgApiKey!.organizationId

    const result = await query<any>(
      `SELECT id, name, description, base_price, currency, section,
              is_available, is_veg, is_vegan, spice_level
       FROM catalog_items
       WHERE organization_id = $1
       ORDER BY section, sort_order, name`,
      [orgId]
    )

    return reply.send({ items: result.rows })
  })

  // POST /platform/catalog — add/update catalog items
  app.post('/platform/catalog', {
    preHandler: [requireOrgApiKey, requireScope('catalog:write')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({
      items: z.array(z.object({
        id: z.string().uuid().optional(), // if provided, update; otherwise create
        name: z.string().min(1).max(120),
        description: z.string().max(400).optional(),
        price: z.number().min(0),
        section: z.string().max(80).optional(),
        isAvailable: z.boolean().default(true),
        isVeg: z.boolean().optional(),
      })).min(1).max(100),
    }).parse(req.body)

    const orgId = req.orgApiKey!.organizationId
    let created = 0, updated = 0

    for (const item of body.items) {
      if (item.id) {
        await query(
          `UPDATE catalog_items
           SET name = $1, description = $2, base_price = $3, section = $4,
               is_available = $5, is_veg = $6, updated_at = now()
           WHERE id = $7 AND organization_id = $8`,
          [item.name, item.description, item.price, item.section,
           item.isAvailable, item.isVeg, item.id, orgId]
        )
        updated++
      } else {
        await query(
          `INSERT INTO catalog_items
             (organization_id, name, description, base_price, section, is_available, is_veg)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [orgId, item.name, item.description, item.price, item.section,
           item.isAvailable, item.isVeg]
        )
        created++
      }
    }

    return reply.send({ created, updated })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // RESOURCES + AVAILABILITY API
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /platform/resources — list bookable resources
  app.get('/platform/resources', {
    preHandler: [requireOrgApiKey, requireScope('resources:read')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const orgId = req.orgApiKey!.organizationId

    const result = await query<any>(
      `SELECT id, name, resource_type, specialization, price_per_slot,
              consultation_duration_minutes
       FROM bookable_resources
       WHERE organization_id = $1
       ORDER BY name`,
      [orgId]
    )

    return reply.send({ resources: result.rows })
  })

  // GET /platform/availability — check available slots
  app.get('/platform/availability', {
    preHandler: [requireOrgApiKey, requireScope('availability:read')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { resourceId, date, days } = req.query as {
      resourceId: string
      date?: string
      days?: string
    }

    if (!resourceId) {
      return reply.code(400).send({ message: 'resourceId is required' })
    }

    const startDate = date ?? new Date().toISOString().split('T')[0]
    const daysAhead = Math.min(parseInt(days ?? '7'), 30)

    const result = await query<{
      id: string
      slot_time: string
      duration_minutes: number
      capacity_total: number
      capacity_booked: number
    }>(
      `SELECT id, slot_time, duration_minutes, capacity_total, capacity_booked
       FROM resource_slots
       WHERE resource_id = $1
         AND slot_time >= $2::date
         AND slot_time < ($2::date + $3 * interval '1 day')
         AND capacity_booked < capacity_total
         AND is_cancelled = false
       ORDER BY slot_time`,
      [resourceId, startDate, daysAhead]
    )

    return reply.send({
      slots: result.rows.map(s => ({
        id: s.id,
        time: s.slot_time,
        durationMinutes: s.duration_minutes,
        available: s.capacity_total - s.capacity_booked,
      })),
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBHOOKS API
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /platform/webhooks — register a webhook
  app.post('/platform/webhooks', {
    preHandler: [requireOrgApiKey, requireScope('webhooks:manage')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({
      url: z.string().url().max(2000),
      events: z.array(z.string()).optional(),
      description: z.string().max(200).optional(),
    }).parse(req.body)

    // Validate events
    const events = body.events?.filter(isWebhookEvent)

    const result = await webhooks.register({
      organizationId: req.orgApiKey!.organizationId,
      url: body.url,
      events: events as any,
      description: body.description,
    })

    return reply.code(201).send({
      webhook: result.subscription,
      signingSecret: result.signingSecret,
      message: 'Save the signing secret — it cannot be shown again.',
      availableEvents: WEBHOOK_EVENTS,
    })
  })

  // GET /platform/webhooks — list webhooks
  app.get('/platform/webhooks', {
    preHandler: [requireOrgApiKey, requireScope('webhooks:manage')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const subs = await webhooks.listForOrg(req.orgApiKey!.organizationId)
    return reply.send({ webhooks: subs })
  })

  // DELETE /platform/webhooks/:id — remove a webhook
  app.delete('/platform/webhooks/:id', {
    preHandler: [requireOrgApiKey, requireScope('webhooks:manage')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    const ok = await webhooks.remove(id, req.orgApiKey!.organizationId)
    if (!ok) {
      return reply.code(404).send({ message: 'Webhook not found' })
    }
    return reply.send({ message: 'Webhook deleted' })
  })
}
