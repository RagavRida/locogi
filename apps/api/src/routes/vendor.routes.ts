import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { query } from '../lib/db'
import { requireAuth } from '../lib/auth'
import { checkRateLimit } from '../lib/redis'
import { runTask } from '../ai/contract'
import { extractRequestTask } from '../ai/tasks/extract-request'
import { enqueueEmbedding } from '../lib/queue'
import { LocationService } from '../services/location.service'
import { CategoryService } from '../services/category.service'
import { vendorRepo, bookingRepo } from '../repositories'
import { logger } from '../lib/logger'
import { QUOTABLE_STATES } from '../domain/request-state'

const location = new LocationService()
const categories = new CategoryService()

const CreateVendorSchema = z.object({
  rawDescription: z.string().min(10).max(2000),
  categoryTags: z.array(z.string()).min(1).max(5),
  attributes: z.record(z.unknown()),
  attributeSchema: z.record(z.string()),
  serviceAreaDescription: z.string().optional(),
  serviceRadiusKm: z.number().int().min(1).max(50).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
})

const AvailabilitySchema = z.object({
  slots: z.array(
    z.object({
      dayOfWeek: z.number().int().min(0).max(6),
      startTime: z.string().regex(/^\d{2}:\d{2}$/),
      endTime: z.string().regex(/^\d{2}:\d{2}$/),
    })
  ),
})

export async function vendorRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ─── Extract vendor profile from freeform text ──────────────────────────────
  app.post('/vendors/extract', async (req, reply) => {
    const { rawDescription } = (req.body ?? {}) as { rawDescription?: string }
    if (!rawDescription || rawDescription.length < 10) {
      return reply.code(400).send({
        message: 'Tell us a bit more about your services',
      })
    }

    const allowed = await checkRateLimit(`extract:${req.user!.id}`, 20, 3600)
    if (!allowed) {
      return reply.code(429).send({ message: 'Too many requests' })
    }

    // This path previously had no timeout at all — the only one in the system
    // lived in the customer route. A hung NIM call held this connection until
    // the socket died. The task carries its own now.
    const result = await runTask(extractRequestTask, { text: rawDescription })

    if (result.ok) return reply.send(result.data)

    logger.error({ reason: result.reason }, 'Vendor extraction failed')

    if (result.reason === 'timeout' || result.reason === 'unavailable') {
      return reply.code(503).send({
        message: 'Our AI is slow right now — please try again.',
      })
    }
    return reply.code(422).send({ message: 'Could not understand that' })
  })

  // ─── Create / update vendor profile ────────────────────────────────────────
  app.post('/vendors', async (req, reply) => {
    const parsed = CreateVendorSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }
    const d = parsed.data

    const allowed = await checkRateLimit(`create_vendor:${req.user!.id}`, 3, 86400)
    if (!allowed) {
      return reply.code(429).send({ message: 'Profile update limit reached for today' })
    }

    // ── Resolve the vendor's freeform tags into canonical categories ────────
    // This is where the vendor database organizes itself. "drone videography"
    // and "aerial cinematography" both land in the same canonical bucket.
    const resolved = await categories.resolveTags(d.categoryTags, 'vendor')

    if (resolved.length === 0) {
      return reply.code(422).send({
        message: "We couldn't work out what service you offer. Could you describe it differently?",
      })
    }

    // KYC requirement comes from the resolved category, not keyword guessing
    const kycRequired = resolved.some((r) => r.requiresKyc)
    const primary = resolved[0]

    const result = await query<{ id: string }>(
      `INSERT INTO vendors
         (user_id, raw_description, category_tags, attributes, attribute_schema,
          service_area_description, service_radius_km, is_kyc_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         raw_description = EXCLUDED.raw_description,
         category_tags = EXCLUDED.category_tags,
         attributes = EXCLUDED.attributes,
         attribute_schema = EXCLUDED.attribute_schema,
         service_area_description = EXCLUDED.service_area_description,
         service_radius_km = EXCLUDED.service_radius_km
       RETURNING id`,
      [
        req.user!.id,
        d.rawDescription,
        resolved.map((r) => r.canonicalName), // store canonical, not raw
        JSON.stringify(d.attributes),
        JSON.stringify(d.attributeSchema),
        d.serviceAreaDescription ?? null,
        d.serviceRadiusKm ?? 10,
        !kycRequired,
      ]
    )

    const vendor = result.rows[0]
    if (!vendor) return reply.code(500).send({ message: 'Could not save profile' })

    // ── Link vendor → canonical categories ─────────────────────────────────
    await categories.linkVendor(vendor.id, resolved)

    // ── Feed the schema learner ────────────────────────────────────────────
    // Over time this reveals which fields each role actually needs, so future
    // vendors in the same category get prompted for them automatically.
    await categories.observeSchema(
      resolved.map((r) => r.categoryId),
      d.attributeSchema,
      d.attributes,
      'vendor',
      vendor.id
    )

    await query('UPDATE users SET is_vendor = true WHERE id = $1', [req.user!.id])

    // H3 geo index
    if (d.lat && d.lng) {
      await location.indexVendorLocation(vendor.id, d.lat, d.lng)
    } else if (d.serviceAreaDescription) {
      await location.indexFromAreaName('vendor', vendor.id, d.serviceAreaDescription)
    }

    // Embedding
    await enqueueEmbedding({
      type: 'vendor',
      id: vendor.id,
      text: `${d.rawDescription} ${JSON.stringify(d.attributes)}`,
    })

    // ── What else should we ask this vendor? ────────────────────────────────
    // Fields that other vendors in this role commonly have but this one skipped.
    const template = await categories.getFieldTemplate(primary.categoryId)
    const providedFields = new Set(Object.keys(d.attributes).map((k) => k.toLowerCase()))
    const missingFields = template.filter((f) => !providedFields.has(f.fieldName))

    const newCategoryCreated = resolved.some((r) => r.matchedVia === 'created')

    logger.info(
      {
        vendorId: vendor.id,
        categories: resolved.map((r) => `${r.canonicalName} (${r.matchedVia})`),
        kycRequired,
        newCategoryCreated,
      },
      'Vendor profile saved and linked to taxonomy'
    )

    return reply.send({
      id: vendor.id,
      categories: resolved.map((r) => ({
        id: r.categoryId,
        name: r.canonicalName,
        slug: r.slug,
        isPrimary: r === primary,
        matchedVia: r.matchedVia,
      })),
      suggestedBookingType: primary.defaultBookingType,
      kycRequired,
      isLive: !kycRequired,
      missingFields: missingFields.slice(0, 3).map((f) => ({
        fieldName: f.fieldName,
        fieldType: f.fieldType,
        question: f.promptQuestion,
      })),
      message: kycRequired
        ? `You're registered as a ${primary.canonicalName}. Your profile is under review — we'll notify you once verified, usually within 24 hours.`
        : `You're live as a ${primary.canonicalName}! Job requests will start coming in.`,
    })
  })

  // ─── Own profile ───────────────────────────────────────────────────────────
  app.get('/vendors/me', async (req, reply) => {
    const result = await query(
      `SELECT v.*, u.name
       FROM vendors v JOIN users u ON u.id = v.user_id
       WHERE v.user_id = $1`,
      [req.user!.id]
    )
    const vendor = result.rows[0]
    if (!vendor) return reply.code(404).send({ message: 'No vendor profile yet' })
    return reply.send(vendor)
  })

  // ─── Vendor inbox — incoming job requests ──────────────────────────────────
  app.get('/vendors/inbox', async (req, reply) => {
    const vendorId = await vendorRepo.findIdByUserId(req.user!.id)
    if (!vendorId) return reply.send({ requests: [] })

    const result = await query<{
      id: string
      raw_description: string
      booking_type: string
      created_at: string
      attributes: Record<string, unknown>
      response_status: string
    }>(
      `SELECT r.id, r.raw_description, r.booking_type, r.created_at, r.attributes,
              rr.status AS response_status
       FROM request_responses rr
       JOIN requests r ON r.id = rr.request_id
       WHERE rr.vendor_id = $1
         AND rr.status IN ('pending', 'counter')
         AND r.status = ANY($2::text[])
       ORDER BY rr.notified_at DESC
       LIMIT 30`,
      [vendorId, QUOTABLE_STATES]
    )

    return reply.send({
      requests: result.rows.map((r) => ({
        id: r.id,
        rawDescription: r.raw_description,
        bookingType: r.booking_type,
        createdAt: r.created_at,
        attributes: r.attributes,
        isCounterOffer: r.response_status === 'counter',
      })),
    })
  })

  // ─── Decline a request ─────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/vendors/decline/:id', async (req, reply) => {
    const vendorId = await vendorRepo.findIdByUserId(req.user!.id)
    if (!vendorId) return reply.code(400).send({ message: 'No vendor profile' })

    await query(
      `UPDATE request_responses
       SET status = 'declined', responded_at = now()
       WHERE request_id = $1 AND vendor_id = $2`,
      [req.params.id, vendorId]
    )

    return reply.send({ success: true })
  })

  // ─── Apply to a hiring post ────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/requests/:id/apply', async (req, reply) => {
    const { message } = (req.body ?? {}) as { message?: string }

    const vendorId = await vendorRepo.findIdByUserId(req.user!.id)
    if (!vendorId) return reply.code(400).send({ message: 'Create your profile first' })

    await query(
      `INSERT INTO request_responses (request_id, vendor_id, status, message, responded_at)
       VALUES ($1, $2, 'applied', $3, now())
       ON CONFLICT (request_id, vendor_id)
         DO UPDATE SET status = 'applied', message = EXCLUDED.message, responded_at = now()`,
      [req.params.id, vendorId, message?.slice(0, 500) ?? null]
    )

    return reply.send({ success: true })
  })

  // ─── Availability hours ────────────────────────────────────────────────────
  app.put('/vendors/availability', async (req, reply) => {
    const parsed = AvailabilitySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid availability format' })
    }

    const vendorId = await vendorRepo.findIdByUserId(req.user!.id)
    if (!vendorId) return reply.code(400).send({ message: 'No vendor profile' })

    await query('DELETE FROM vendor_availability WHERE vendor_id = $1', [vendorId])

    for (const s of parsed.data.slots) {
      await query(
        `INSERT INTO vendor_availability (vendor_id, day_of_week, start_time, end_time)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (vendor_id, day_of_week) DO UPDATE
           SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
        [vendorId, s.dayOfWeek, s.startTime, s.endTime]
      )
    }

    return reply.send({ success: true })
  })

  // ─── Available appointment slots ───────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>(
    '/vendors/:id/slots',
    async (req, reply) => {
      const date = req.query.date ?? new Date().toISOString().split('T')[0]

      const slots = await bookingRepo.listSlotsForVendor(req.params.id, date)

      return reply.send({
        slots: slots.map((s) => ({
          id: s.id,
          slotTime: s.slotTime,
          capacityBooked: s.capacityBooked,
          capacityTotal: s.capacityTotal,
          isCancelled: s.isCancelled,
          priceOverride: s.priceOverride,
          resourceId: s.resourceId,
          resourceName: s.resourceName,
        })),
      })
    }
  )

  // ─── Create slots (vendor sets their calendar) ─────────────────────────────
  app.post('/vendors/slots', async (req, reply) => {
    const { slots } = (req.body ?? {}) as {
      slots?: Array<{ slotTime: string; durationMinutes?: number; capacityTotal?: number }>
    }
    if (!slots?.length) return reply.code(400).send({ message: 'No slots provided' })

    // Slots attach to a bookable_resource. For a solo vendor that is their
    // implicit 'person' resource; an org with several resources should use
    // POST /organizations/:id/slots to target a specific table or doctor.
    const resource = await vendorRepo.findPrimaryResource(req.user!.id)

    if (!resource) {
      return reply.code(400).send({
        message: 'Create your vendor profile first — no bookable resource exists.',
      })
    }

    if (resource.resourceCount > 1) {
      return reply.code(409).send({
        message:
          'You have multiple bookable resources (tables, doctors, stylists). ' +
          'Use POST /organizations/:id/slots to specify which one these slots ' +
          'belong to.',
      })
    }

    let created = 0
    let skippedPast = 0
    let skippedDuplicate = 0

    for (const s of slots) {
      if (new Date(s.slotTime) <= new Date()) {
        skippedPast++
        continue
      }

      // UNIQUE(resource_id, slot_time) makes re-submitting a calendar safe
      const inserted = await bookingRepo.createSlot({
        resourceId: resource.resourceId,
        slotTime: s.slotTime,
        durationMinutes: s.durationMinutes,
        capacityTotal: s.capacityTotal,
      })

      if (inserted) created++
      else skippedDuplicate++
    }

    // Previously reported slots.length regardless of how many were actually
    // written, so a vendor submitting a stale calendar was told everything
    // succeeded when nothing had.
    return reply.send({
      success: true,
      created,
      skippedPast,
      skippedDuplicate,
      message:
        created === 0
          ? 'No new slots added — they were all in the past or already exist.'
          : `${created} slots added.`,
    })
  })

  // ─── Vendor stats (own performance) ────────────────────────────────────────
  app.get('/vendors/stats', async (req, reply) => {
    const result = await query<{
      completed_jobs: number
      rating: number
      total_quoted: string
      total_accepted: string
      total_earnings: string
    }>(
      `SELECT v.completed_jobs, v.rating,
              COUNT(rr.id) FILTER (WHERE rr.status = 'quoted') AS total_quoted,
              COUNT(rr.id) FILTER (WHERE rr.status = 'confirmed') AS total_accepted,
              COALESCE(SUM(r.agreed_price) FILTER (WHERE r.status = 'completed'), 0) AS total_earnings
       FROM vendors v
       LEFT JOIN request_responses rr ON rr.vendor_id = v.id
       LEFT JOIN requests r ON r.confirmed_vendor_id = v.id
       WHERE v.user_id = $1
       GROUP BY v.id, v.completed_jobs, v.rating`,
      [req.user!.id]
    )

    const s = result.rows[0]
    if (!s) return reply.send({ completedJobs: 0, rating: 0, quoted: 0, accepted: 0, earnings: 0 })

    return reply.send({
      completedJobs: s.completed_jobs,
      rating: Number(s.rating),
      quoted: Number(s.total_quoted),
      accepted: Number(s.total_accepted),
      earnings: Number(s.total_earnings),
      acceptanceRate:
        Number(s.total_quoted) > 0
          ? Math.round((Number(s.total_accepted) / Number(s.total_quoted)) * 100)
          : 0,
    })
  })

  // ─── Reviews for a vendor ──────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/vendors/:id/reviews', async (req, reply) => {
    const result = await query(
      `SELECT rating, comment, created_at
       FROM reviews WHERE vendor_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    )
    return reply.send({ reviews: result.rows })
  })

  // ─── Browse open requests (vendors were previously passive) ──────────────────
  //
  // Deliberately SCOPED. If vendors could browse everything, the fan-out would
  // be meaningless and every request would collect 50 speculative quotes.
  // Constraints:
  //   • only their own canonical categories
  //   • only within their service radius (H3-filtered)
  //   • only requests still open
  //   • excludes ones they already passed on
  //   • quoting is still rate-limited elsewhere
  app.get<{ Querystring: { limit?: string } }>(
    '/vendors/browse',
    async (req, reply) => {
      const vendorResult = await query<{
        id: string
        h3_r7: string | null
        service_radius_km: number
      }>(
        'SELECT id, h3_r7, service_radius_km FROM vendors WHERE user_id = $1',
        [req.user!.id]
      )
      const vendor = vendorResult.rows[0]
      if (!vendor) {
        return reply.code(400).send({ message: 'Create your vendor profile first' })
      }

      const limit = Math.min(parseInt(req.query.limit ?? '20'), 50)

      // Geo filter only applies if we know where the vendor is. Without it,
      // fall back to category-only rather than showing nothing.
      const geoClause = vendor.h3_r7
        ? `AND (r.h3_r7 = $3 OR r.h3_r7 IS NULL)`
        : ''

      const values: unknown[] = [vendor.id, limit]
      if (vendor.h3_r7) values.push(vendor.h3_r7)

      // Appended last so the optional $3 geo parameter keeps its position.
      const quotableIdx = values.push(QUOTABLE_STATES)

      const result = await query<{
        id: string
        raw_description: string
        booking_type: string
        created_at: string
        attributes: Record<string, unknown>
        category_names: string[]
        quote_count: string
        was_notified: boolean
      }>(
        `SELECT DISTINCT r.id, r.raw_description, r.booking_type, r.created_at,
                r.attributes,
                ARRAY_AGG(DISTINCT sc.canonical_name) AS category_names,
                (SELECT COUNT(*) FROM request_responses rr2
                 WHERE rr2.request_id = r.id AND rr2.status = 'quoted') AS quote_count,
                EXISTS (
                  SELECT 1 FROM request_responses rr3
                  WHERE rr3.request_id = r.id AND rr3.vendor_id = $1
                ) AS was_notified
         FROM requests r
         JOIN request_categories rc ON rc.request_id = r.id
         JOIN service_categories sc ON sc.id = rc.category_id
         JOIN vendor_categories vc ON vc.category_id = rc.category_id
         WHERE vc.vendor_id = $1
           AND r.status = ANY($${quotableIdx}::text[])
           AND r.expires_at > now()
           ${geoClause}
           -- Don't show requests this vendor already declined
           AND NOT EXISTS (
             SELECT 1 FROM request_responses rr
             WHERE rr.request_id = r.id AND rr.vendor_id = $1
               AND rr.status IN ('declined', 'missed', 'quoted')
           )
         GROUP BY r.id, r.raw_description, r.booking_type, r.created_at, r.attributes
         ORDER BY r.created_at DESC
         LIMIT $2`,
        values
      )

      return reply.send({
        requests: result.rows.map((r) => ({
          id: r.id,
          rawDescription: r.raw_description,
          bookingType: r.booking_type,
          createdAt: r.created_at,
          attributes: r.attributes,
          categories: r.category_names,
          // Honest signal so vendors can judge their odds
          existingQuotes: Number(r.quote_count),
          // Was this pushed to them, or did they find it by browsing?
          wasNotifiedToYou: r.was_notified,
        })),
        note:
          'Requests in your categories and area that are still open. ' +
          'existingQuotes tells you how many vendors have already quoted.',
      })
    }
  )

}
