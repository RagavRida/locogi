/**
 * Conversational endpoint for questions about existing bookings.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A NEW ROUTE AND NOT A CHANGE TO /requests/extract
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/requests/extract` has one job and does it well: turn a new service need
 * into structured fields. Its response shape is consumed by the mobile app's
 * existing flow, and widening it to sometimes-return-a-booking-card would mean
 * every current caller has to handle a case it never asked for.
 *
 * So `/chat` sits in front. It answers booking questions itself, and when the
 * message is not one — which is most messages — it says so explicitly with
 * `handled: false`, and the client runs exactly the flow it runs today. The
 * old endpoint is untouched and still works standalone.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../lib/auth'
import { checkRateLimit } from '../lib/redis'
import { query } from '../lib/db'
import { conversationRepo, requestRepo } from '../repositories'
import { ChatOrchestratorService } from '../services/chat-orchestrator.service'
import { isUIComponentType, type UISchema } from '@locogi/types'
import { logger } from '../lib/logger'

const orchestrator = new ChatOrchestratorService()

const MessageSchema = z.object({
  text: z.string().min(1).max(2000),
  orgId: z.string().uuid().optional(), // for org-scoped ordering
})

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ─── Send a message ─────────────────────────────────────────────────────────
  //
  // The unified entry point. Everything happens through this endpoint:
  //   - Booking questions ("where's my order?")
  //   - New orders ("I want 2 biryani")
  //   - Discovery ("find a dentist near me")
  //   - Lifecycle actions ("cancel my booking")
  //
  // If orgId is provided, the message is scoped to that business's
  // commerce flow. Otherwise, intent detection routes automatically.

  app.post('/chat', async (req, reply) => {
    const parsed = MessageSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const allowed = await checkRateLimit(`chat:${req.user!.id}`, 60, 3600)
    if (!allowed) {
      return reply.code(429).send({ message: 'Too many messages. Try again shortly.' })
    }

    const result = await orchestrator.handle({
      userId: req.user!.id,
      text: parsed.data.text,
      orgId: parsed.data.orgId,
    })

    if (!result) {
      // Fallback — should rarely happen now since discovery handles unknowns
      return reply.send({
        handled: false,
        message: "I'm not sure what you need. Could you describe it differently?",
      })
    }

    await persistTurn(req.user!.id, parsed.data.text, result.message, result.ui)

    logger.info(
      { stage: 'ui_rendered', type: result.ui?.type, intent: result.intent },
      'chat.ui'
    )

    return reply.send({
      handled: true,
      message: result.message,
      ui: result.ui,
      intent: result.intent,
    })
  })

  // ─── Resolve an ambiguity by tapping a card ─────────────────────────────────
  //
  // The selector renders booking ids the user already owns; this confirms that
  // independently rather than trusting the round-trip. A tampered client
  // posting someone else's id gets a 404, the same answer a bad id gets.
  app.post('/chat/select', async (req, reply) => {
    const Schema = z.object({
      bookingId: z.string().uuid(),
      forIntent: z.string().max(40).optional(),
    })
    const parsed = Schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const booking = await requestRepo.findBookingForCustomer(
      parsed.data.bookingId,
      req.user!.id
    )
    if (!booking) return reply.code(404).send({ message: 'Booking not found' })

    await conversationRepo.update(req.user!.id, {
      activeBookingId: booking.id,
      activeProviderId: booking.vendorId ?? undefined,
      lastReferencedEntity: { type: 'booking', id: booking.id },
    })

    // Selecting a booking answers the question that was asked; re-running the
    // original intent through the orchestrator would mean another model call
    // to reach a conclusion we already have.
    const ui: UISchema = { type: 'booking_detail', data: { bookingId: booking.id } }
    const message = `Here is your ${booking.categories[0] ?? 'booking'}.`

    await persistTurn(req.user!.id, null, message, ui)
    return reply.send({ handled: true, message, ui })
  })

  // ─── Replay the conversation ────────────────────────────────────────────────
  //
  // Returns the UI schema per message, not a snapshot of booking data. The
  // client re-renders components from ids and each one fetches its own current
  // authorized state, so scrolling back never shows a stale price as if it
  // were live.
  app.get('/chat/history', async (req, reply) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 50), 100)

    const result = await query<{
      id: string
      text: string | null
      ui: UISchema | null
      sender_id: string
      created_at: string
    }>(
      `SELECT id, text, ui, sender_id, created_at
         FROM messages
        WHERE sender_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.user!.id, limit]
    )

    const messages = result.rows
      .map((m) => ({
        id: m.id,
        role: m.text !== null && m.ui === null ? 'user' : 'agent',
        text: m.text,
        // Defend the registry: a component type retired since this row was
        // written must not reach the client as an unknown key.
        ui: m.ui && isUIComponentType(m.ui.type) ? m.ui : undefined,
        timestamp: m.created_at,
      }))
      .reverse() // oldest first for rendering

    return reply.send({ messages })
  })

  // ─── Current context, for debugging and client hydration ────────────────────
  app.get('/chat/context', async (req, reply) => {
    const context = await conversationRepo.get(req.user!.id)
    return reply.send({ context: context ?? null })
  })
}

/**
 * Record the turn.
 *
 * `request_id` is null: a conversational turn like "show my bookings" belongs
 * to no single request. The column has always been nullable, which is what
 * makes a general chat log possible without a schema change.
 *
 * Failures here are logged and swallowed. A transcript that did not save is a
 * bad day for debugging; an error thrown after the work already happened would
 * tell the user their cancellation failed when it did not.
 */
async function persistTurn(
  userId: string,
  userText: string | null,
  agentText: string,
  ui?: UISchema
): Promise<void> {
  try {
    if (userText !== null) {
      await query(
        `INSERT INTO messages (request_id, sender_id, text, message_type)
         VALUES (NULL, $1, $2, 'text')`,
        [userId, userText]
      )
    }
    await query(
      `INSERT INTO messages (request_id, sender_id, text, message_type, ui)
       VALUES (NULL, $1, $2, 'system', $3)`,
      [userId, agentText, ui ? JSON.stringify(ui) : null]
    )
  } catch (err) {
    logger.error({ err }, 'Could not persist chat turn — conversation will replay short')
  }
}
