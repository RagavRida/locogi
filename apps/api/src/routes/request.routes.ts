import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { query } from '../lib/db'
import { requireAuth } from '../lib/auth'
import { requestRepo, vendorRepo } from '../repositories'
import { checkRateLimit } from '../lib/redis'
import { runTask } from '../ai/contract'
import { extractRequestTask } from '../ai/tasks/extract-request'
import { enqueueEmbedding } from '../lib/queue'
import { MatchingService } from '../services/matching.service'
import { BookingService } from '../services/booking.service'
import { LocationService } from '../services/location.service'
import { NotificationService } from '../services/notification.service'
import { CategoryService } from '../services/category.service'
import { IntentService } from '../services/intent.service'
import { MedicalSafetyService } from '../services/medical-safety.service'
import { TravelService } from '../services/travel.service'
import { logger } from '../lib/logger'

const matching = new MatchingService()
const booking = new BookingService()
const location = new LocationService()
const notifications = new NotificationService()
const categories = new CategoryService()
const intents = new IntentService()
const medicalSafety = new MedicalSafetyService()
const travel = new TravelService()

// ─── Schemas ──────────────────────────────────────────────────────────────────
const ExtractSchema = z.object({
  rawDescription: z.string().min(10, 'Please describe your need in more detail').max(2000),
  lat: z.number().optional(),
  lng: z.number().optional(),
})

const CreateRequestSchema = z.object({
  rawDescription: z.string().min(1).max(2000),
  categoryTags: z.array(z.string()).min(1).max(5),
  attributes: z.record(z.unknown()),
  bookingType: z.enum(['quote', 'appointment', 'hiring', 'order']),
  idempotencyKey: z.string().min(8),
  lat: z.number().optional(),
  lng: z.number().optional(),
})

const QuoteSchema = z.object({
  quotedPrice: z.number().int().positive('Price must be greater than zero'),
  message: z.string().max(500).optional(),
  // Vendor asserting they can make the trip despite our estimate.
  // Logged in travel_rejections so we can tell whether the model is wrong.
  overrideTravelWarning: z.boolean().optional(),
})

const AcceptQuoteSchema = z.object({
  responseId: z.string().uuid(),
  agreedPrice: z.number().int().positive(),
  idempotencyKey: z.string().min(4),
})

const BookSlotSchema = z.object({
  slotId: z.string().uuid(),
  idempotencyKey: z.string().min(4),
})

export async function requestRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ─── Extract structured data from freeform text ─────────────────────────────
  app.post('/requests/extract', async (req, reply) => {
    const parsed = ExtractSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    // ══════════════════════════════════════════════════════════════════════
    // SAFETY GATE — runs before EVERYTHING, including rate limiting.
    //
    // Deterministic keyword check, no LLM. Someone having a heart attack must
    // never wait on an API call, a rate limit, or a token budget.
    // ══════════════════════════════════════════════════════════════════════
    const emergency = medicalSafety.check(parsed.data.rawDescription)
    if (emergency.isEmergency) {
      // Fire-and-forget the log — never let it delay the response
      medicalSafety
        .logInterception(req.user!.id, emergency.severity, emergency.matchedPattern!)
        .catch(() => {})

      return reply.send({
        intent: 'emergency',
        handled: true,
        emergencySeverity: emergency.severity,
        agentMessage: emergency.forcedResponse,
        categoryTags: null,
        attributes: null,
        attributeSchema: null,
      })
    }

    // Medical advice requests get a clear refusal, not an answer
    if (medicalSafety.isSeekingAdvice(parsed.data.rawDescription)) {
      medicalSafety
        .logInterception(req.user!.id, 'none', 'advice_request', true)
        .catch(() => {})

      return reply.send({
        intent: 'unsupported',
        handled: true,
        agentMessage: medicalSafety.getAdviceRefusal(),
        categoryTags: null,
        attributes: null,
        attributeSchema: null,
      })
    }

    const allowed = await checkRateLimit(`extract:${req.user!.id}`, 20, 3600)
    if (!allowed) {
      return reply.code(429).send({ message: 'Too many requests. Try again in an hour.' })
    }

    // ── INTENT GATE — runs before anything touches the taxonomy ─────────────
    // Without this, "find me a library and make friends" would auto-create
    // two junk categories with zero vendors and dead-end the user.
    const routing = await intents.classify(
      parsed.data.rawDescription,
      req.user!.id,
      { lat: parsed.data.lat, lng: parsed.data.lng }
    )

    if (!routing.proceedToMatching) {
      // Handled outside the service pipeline. No extraction, no category
      // creation, no vendor matching — just an honest, useful answer.
      return reply.send({
        intent: routing.classification.intent,
        handled: true,
        agentMessage: routing.agentMessage,
        places: routing.places ?? [],
        // Null so the client knows there is nothing to confirm
        categoryTags: null,
        attributes: null,
        attributeSchema: null,
      })
    }

    // The 15s Promise.race that used to live here is gone. The task owns its
    // own timeout now, and two racing 15s deadlines meant the route could
    // abandon a call the task was still retrying — returning 503 while the
    // request kept burning quota in the background.
    const extraction = await runTask(extractRequestTask, {
      text: parsed.data.rawDescription,
    })

    if (extraction.ok) {
      return reply.send({
        ...extraction.data,
        intent: 'service_request',
        handled: false,
      })
    }

    // The contract already logged the detail. Distinguish the cases the user
    // can act on differently: "try again" versus "say it another way".
    logger.error(
      { reason: extraction.reason, userId: req.user!.id },
      'Extraction failed'
    )

    if (extraction.reason === 'timeout' || extraction.reason === 'unavailable') {
      return reply.code(503).send({
        message: 'Our AI is slow right now — please try again.',
      })
    }
    return reply.code(422).send({
      message: "Couldn't understand that. Could you rephrase?",
    })
  })

  // ─── Create a request + fan out to vendors ─────────────────────────────────
  app.post('/requests', async (req, reply) => {
    const parsed = CreateRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }
    const d = parsed.data

    const allowed = await checkRateLimit(`create_req:${req.user!.id}`, 5, 3600)
    if (!allowed) {
      return reply.code(429).send({ message: 'Too many requests this hour.' })
    }

    // Idempotent insert
    const result = await query<{ id: string; status: string }>(
      `INSERT INTO requests
         (customer_id, idempotency_key, raw_description, category_tags,
          attributes, booking_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '2 hours')
       ON CONFLICT (idempotency_key)
         DO UPDATE SET raw_description = requests.raw_description
       RETURNING id, status`,
      [
        req.user!.id,
        d.idempotencyKey,
        d.rawDescription,
        d.categoryTags,
        JSON.stringify(d.attributes),
        d.bookingType,
      ]
    )

    const request = result.rows[0]
    if (!request) return reply.code(500).send({ message: 'Could not create request' })

    // ── Resolve request tags into the SAME canonical taxonomy as vendors ────
    // This is what makes matching work: the customer saying "someone to shoot
    // my wedding" and the vendor who wrote "wedding photography" both resolve
    // to the canonical Photography category.
    const resolved = await categories.resolveTags(d.categoryTags, 'request')
    await categories.linkRequest(request.id, resolved)

    // ── Health data guard ───────────────────────────────────────────────────
    // If this resolved to a health-adjacent category, strip symptom detail
    // before the request text reaches any vendor. Sharing symptoms with a
    // third party is a DPDP special-category disclosure we have no basis for.
    const healthCheck = await query<{ is_health_adjacent: boolean }>(
      `SELECT bool_or(is_health_adjacent) AS is_health_adjacent
       FROM service_categories WHERE id = ANY($1::uuid[])`,
      [resolved.map((r) => r.categoryId)]
    )

    let fanOutDescription = d.rawDescription
    if (healthCheck.rows[0]?.is_health_adjacent) {
      const mutableAttrs = { ...d.attributes }
      const { sanitizedText, strippedFields } = medicalSafety.sanitizeHealthRequest(
        d.rawDescription,
        mutableAttrs
      )
      fanOutDescription = sanitizedText

      // Overwrite the stored row with the sanitized version
      await query(
        `UPDATE requests
         SET raw_description = $1, attributes = $2
         WHERE id = $3`,
        [sanitizedText, JSON.stringify(mutableAttrs), request.id]
      )

      logger.info(
        { requestId: request.id, strippedFields },
        'Health request sanitized before vendor fan-out'
      )
    }

    // Feed the schema learner from the demand side too
    if (resolved.length > 0) {
      await categories.observeSchema(
        resolved.map((r) => r.categoryId),
        {}, // requests don't carry a schema, only attributes
        d.attributes,
        'request',
        request.id
      )
    }

    // ── H3 geo indexing ──────────────────────────────────────────────────────
    // Priority: explicit location in the user's text > phone GPS > nothing.
    //
    // Why text wins: "book a plumber for my mom in Kondapur" means Kondapur,
    // even if the phone GPS says Banjara Hills. The user deliberately named a
    // different place — they're booking for someone/somewhere else.
    const explicitArea = (d.attributes.area ?? d.attributes.location) as string | undefined

    if (explicitArea) {
      const indexed = await location.indexFromAreaName('request', request.id, explicitArea)
      if (!indexed && d.lat && d.lng) {
        // Geocoding failed (typo, unknown area) — fall back to phone GPS
        await location.indexRequestLocation(request.id, d.lat, d.lng)
        logger.debug(
          { requestId: request.id, explicitArea },
          'Explicit area geocoding failed — fell back to phone GPS'
        )
      }
    } else if (d.lat && d.lng) {
      // No location mentioned in text — use phone GPS
      await location.indexRequestLocation(request.id, d.lat, d.lng)
    }

    // Embedding (async)
    await enqueueEmbedding({
      type: 'request',
      id: request.id,
      text: `${d.rawDescription} ${JSON.stringify(d.attributes)}`,
    })

    // Match + fan out (raw tags passed as a last-resort fallback)
    const vendors = await matching.findVendors(request.id, d.categoryTags)

    if (vendors.length === 0) {
      await requestRepo.markNoMatch(request.id)
      return reply.send({ id: request.id, matchedCount: 0 })
    }

    for (const v of vendors) {
      await query(
        `INSERT INTO request_responses (request_id, vendor_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (request_id, vendor_id) DO NOTHING`,
        [request.id, v.id]
      )
    }

    // Notify vendors via push (async — don't block the HTTP response)
    notifications
      .notifyVendorsOfRequest(vendors, request.id, fanOutDescription, d.bookingType)
      .catch((err) => logger.error({ err }, 'Vendor notification fan-out failed'))

    logger.info(
      { requestId: request.id, matched: vendors.length },
      'Request created and fanned out'
    )

    return reply.send({ id: request.id, matchedCount: vendors.length })
  })

  // ─── Get request detail + job stages ───────────────────────────────────────
  app.get<{ Params: { id: string } }>('/requests/:id', async (req, reply) => {
    const result = await query<{
      id: string
      status: string
      booking_type: string
      agreed_price: number | null
      confirmed_vendor_id: string | null
      created_at: string
      customer_id: string
    }>(
      `SELECT id, status, booking_type, agreed_price, confirmed_vendor_id,
              created_at, customer_id
       FROM requests WHERE id = $1`,
      [req.params.id]
    )

    const r = result.rows[0]
    if (!r) return reply.code(404).send({ message: 'Request not found' })
    if (r.customer_id !== req.user!.id) {
      return reply.code(403).send({ message: 'Not your request' })
    }

    let confirmedVendor = null
    if (r.confirmed_vendor_id) {
      const v = await query(
        `SELECT v.id, v.category_tags, v.rating, v.completed_jobs,
                v.attributes, u.name
         FROM vendors v JOIN users u ON u.id = v.user_id
         WHERE v.id = $1`,
        [r.confirmed_vendor_id]
      )
      confirmedVendor = v.rows[0] ?? null
    }

    const stageOrder = ['open', 'confirmed', 'in_progress', 'completed']
    const currentIdx = stageOrder.indexOf(r.status)
    const labels =
      r.booking_type === 'order'
        ? ['Placed', 'Confirmed', 'Out for delivery', 'Delivered']
        : r.booking_type === 'appointment'
        ? ['Booked', 'Reminder sent', 'In progress', 'Completed']
        : ['Request sent', 'Vendor confirmed', 'In progress', 'Completed']

    return reply.send({
      status: r.status,
      bookingType: r.booking_type,
      agreedPrice: r.agreed_price,
      confirmedVendor,
      stages: labels.map((label, i) => ({
        label,
        completedAt: i <= currentIdx ? r.created_at : null,
      })),
    })
  })

  // ─── Get incoming quotes for a request ─────────────────────────────────────
  app.get<{ Params: { id: string } }>('/requests/:id/quotes', async (req, reply) => {
    const owns = await requestRepo.isOwnedByCustomer(req.params.id, req.user!.id)
    if (!owns) {
      return reply.code(403).send({ message: 'Not your request' })
    }

    const result = await query<{
      id: string
      vendor_id: string
      quoted_price: number
      message: string | null
      name: string | null
      rating: number
      completed_jobs: number
      category_tags: string[]
    }>(
      `SELECT rr.id, rr.vendor_id, rr.quoted_price, rr.message,
              u.name, v.rating, v.completed_jobs, v.category_tags
       FROM request_responses rr
       JOIN vendors v ON v.id = rr.vendor_id
       JOIN users u ON u.id = v.user_id
       WHERE rr.request_id = $1 AND rr.status = 'quoted'
       ORDER BY rr.responded_at ASC`,
      [req.params.id]
    )

    return reply.send({
      quotes: result.rows.map((r) => ({
        responseId: r.id,
        vendorId: r.vendor_id,
        vendorName: r.name ?? r.category_tags?.[0] ?? 'Vendor',
        vendorRating: Number(r.rating),
        vendorJobs: r.completed_jobs,
        quotedPrice: r.quoted_price,
        message: r.message ?? undefined,
      })),
    })
  })

  // ─── Vendor sends a quote ──────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/requests/:id/quote', async (req, reply) => {
    const parsed = QuoteSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const vendorId = await vendorRepo.findIdByUserId(req.user!.id)
    if (!vendorId) {
      return reply.code(400).send({ message: 'Create your vendor profile first' })
    }

    // ── TRAVEL FEASIBILITY ──────────────────────────────────────────────────
    // Prevents a vendor committing to 2pm in Kondapur and 2:30pm in LB Nagar.
    // Advisory here (they can override), but enforced by an EXCLUDE constraint
    // at confirmation time.
    const reqGeo = await query<{
      lat: number | null
      lng: number | null
      slot_time: string | null
      duration: number | null
      area: string | null
    }>(
      `SELECT r.lat, r.lng, rs.slot_time,
              rs.duration_minutes AS duration,
              r.attributes->>'area' AS area
       FROM requests r
       LEFT JOIN resource_slots rs ON rs.id = r.resource_slot_id
       WHERE r.id = $1`,
      [req.params.id]
    )
    const geo = reqGeo.rows[0]

    if (geo?.slot_time && !parsed.data.overrideTravelWarning) {
      const verdict = await travel.checkFeasibility({
        vendorId,
        serviceFrom: geo.slot_time,
        durationMinutes: geo.duration ?? 60,
        lat: geo.lat,
        lng: geo.lng,
        requestId: req.params.id,
      })

      if (!verdict.feasible) {
        return reply.code(409).send({
          message: verdict.vendorMessage ?? 'This clashes with another booking.',
          reason: verdict.reason,
          travelNeededMinutes: verdict.travelNeededMinutes,
          availableGapMinutes: verdict.availableGapMinutes,
          conflictingBooking: verdict.conflictingCommitment,
          // Estimates can be wrong — let the vendor insist, and log it
          canOverride: verdict.overridable,
          overrideHint: verdict.overridable
            ? 'Send again with overrideTravelWarning: true if you can make it.'
            : undefined,
        })
      }
    }

    const result = await query(
      `UPDATE request_responses
       SET status = 'quoted', quoted_price = $1, message = $2, responded_at = now()
       WHERE request_id = $3 AND vendor_id = $4
         AND status IN ('pending', 'counter')`,
      [parsed.data.quotedPrice, parsed.data.message ?? null, req.params.id, vendorId]
    )

    if (result.rowCount === 0) {
      return reply.code(409).send({
        message: 'This request is no longer accepting quotes',
      })
    }

    // Mark request as negotiating. A no-op if it already is — the second
    // vendor to quote does not need to move a state that has already moved.
    await requestRepo.markNegotiating(req.params.id)

    // Notify the customer
    notifications
      .notifyCustomerOfQuote(req.params.id, vendorId, parsed.data.quotedPrice)
      .catch((err) => logger.error({ err }, 'Quote notification failed'))

    return reply.send({ success: true })
  })

  // ─── Accept a quote (ATOMIC RACE-LOCK) ─────────────────────────────────────
  app.post<{ Params: { id: string } }>('/requests/:id/quote/accept', async (req, reply) => {
    const parsed = AcceptQuoteSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid request' })
    }

    const owns = await requestRepo.isOwnedByCustomer(req.params.id, req.user!.id)
    if (!owns) {
      return reply.code(403).send({ message: 'Not your request' })
    }

    const result = await booking.confirmQuote(
      req.params.id,
      parsed.data.responseId,
      parsed.data.agreedPrice,
      parsed.data.idempotencyKey
    )

    if (!result.success) {
      return reply.code(409).send({
        success: false,
        message: 'This quote is no longer available',
      })
    }

    notifications
      .notifyBookingConfirmed(req.params.id)
      .catch((err) => logger.error({ err }, 'Confirmation notification failed'))

    return reply.send({ success: true })
  })

  // ─── Counter-offer ─────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/requests/:id/quote/counter', async (req, reply) => {
    const { responseId, counterPrice } = (req.body ?? {}) as {
      responseId?: string
      counterPrice?: number
    }
    if (!responseId || !counterPrice || counterPrice <= 0) {
      return reply.code(400).send({ message: 'Invalid counter offer' })
    }

    await query(
      `UPDATE request_responses SET status = 'counter'
       WHERE id = $1 AND request_id = $2`,
      [responseId, req.params.id]
    )

    await query(
      `INSERT INTO messages (request_id, sender_id, text, message_type, metadata)
       VALUES ($1, $2, $3, 'quote_counter', $4)`,
      [
        req.params.id,
        req.user!.id,
        `Counter offer: ₹${counterPrice}`,
        JSON.stringify({ price: counterPrice }),
      ]
    )

    notifications
      .notifyVendorOfCounter(responseId, counterPrice)
      .catch((err) => logger.error({ err }, 'Counter notification failed'))

    return reply.send({ success: true })
  })

  // ─── Book an appointment slot (ATOMIC) ─────────────────────────────────────
  app.post<{ Params: { id: string } }>('/requests/:id/book-slot', async (req, reply) => {
    const parsed = BookSlotSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid slot' })
    }

    const result = await booking.bookSlot(
      parsed.data.slotId,
      req.params.id,
      parsed.data.idempotencyKey
    )

    if (!result.success) {
      return reply.code(409).send({
        success: false,
        message: 'That slot was just taken',
      })
    }

    // Schedule a reminder 1 hour before
    if (result.slot) {
      notifications
        .scheduleAppointmentReminder(req.params.id, req.user!.id, result.slot.slotTime)
        .catch((err) => logger.error({ err }, 'Reminder scheduling failed'))
    }

    return reply.send({ success: true, slot: result.slot })
  })

  // ─── Advance job stage ─────────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/requests/:id/status', async (req, reply) => {
    const { stage } = (req.body ?? {}) as { stage?: 'in_progress' | 'completed' }
    if (stage !== 'in_progress' && stage !== 'completed') {
      return reply.code(400).send({ message: 'Invalid stage' })
    }

    const ok = await booking.advanceStage(req.params.id, stage, req.user!.id)
    if (!ok) {
      return reply.code(409).send({ message: 'Cannot advance to that stage yet' })
    }

    // On completion, bump the vendor's completed_jobs counter
    if (stage === 'completed') {
      await query(
        `UPDATE vendors SET completed_jobs = completed_jobs + 1
         WHERE id = (SELECT confirmed_vendor_id FROM requests WHERE id = $1)`,
        [req.params.id]
      )
    }

    return reply.send({ success: true })
  })

  // ─── Cancel (within 5 minutes of confirmation) ─────────────────────────────
  app.post<{ Params: { id: string } }>('/requests/:id/cancel', async (req, reply) => {
    const { reason } = (req.body ?? {}) as { reason?: string }

    const cancelled = await requestRepo.cancelWithinWindow(
      req.params.id,
      req.user!.id,
      5
    )

    if (!cancelled) {
      return reply.code(409).send({
        message: 'Cancellation window has passed. Please contact support.',
      })
    }

    await query(
      `UPDATE request_responses SET status = 'missed' WHERE request_id = $1`,
      [req.params.id]
    )

    logger.info({ requestId: req.params.id, reason }, 'Request cancelled')
    return reply.send({ success: true })
  })

  // ─── History ───────────────────────────────────────────────────────────────
  app.get('/requests/history', async (req, reply) => {
    const result = await query<{
      id: string
      raw_description: string
      status: string
      created_at: string
      vendor_name: string | null
      rating: number | null
    }>(
      `SELECT r.id, r.raw_description, r.status, r.created_at,
              u.name AS vendor_name, rev.rating
       FROM requests r
       LEFT JOIN vendors v ON v.id = r.confirmed_vendor_id
       LEFT JOIN users u ON u.id = v.user_id
       LEFT JOIN reviews rev ON rev.request_id = r.id
       WHERE r.customer_id = $1
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [req.user!.id]
    )

    return reply.send({
      requests: result.rows.map((r) => ({
        id: r.id,
        rawDescription: r.raw_description,
        status: r.status,
        createdAt: r.created_at,
        vendorName: r.vendor_name ?? undefined,
        rating: r.rating ?? undefined,
      })),
    })
  })

  // ─── Messages ──────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/requests/:id/messages',
    async (req, reply) => {
      const cursor = req.query.cursor
      const result = await query(
        `SELECT id, sender_id, text, image_url, message_type, metadata, created_at
         FROM messages
         WHERE request_id = $1
           ${cursor ? 'AND created_at < $2' : ''}
         ORDER BY created_at DESC
         LIMIT 50`,
        cursor ? [req.params.id, cursor] : [req.params.id]
      )
      return reply.send({ messages: result.rows.reverse() })
    }
  )

  app.post<{ Params: { id: string } }>('/requests/:id/messages', async (req, reply) => {
    const { text, imageUrl } = (req.body ?? {}) as { text?: string; imageUrl?: string }
    if (!text && !imageUrl) {
      return reply.code(400).send({ message: 'Message cannot be empty' })
    }

    // Basic sanitization
    const clean = text?.replace(/<[^>]*>/g, '').slice(0, 2000)

    const result = await query<{ id: string }>(
      `INSERT INTO messages (request_id, sender_id, text, image_url, message_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.params.id, req.user!.id, clean ?? null, imageUrl ?? null, imageUrl ? 'image' : 'text']
    )

    return reply.send({ messageId: result.rows[0]?.id })
  })
}
