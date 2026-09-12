/**
 * The conversational pipeline for questions about existing bookings.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THIS SITS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   message
 *     ↓
 *   pending confirmation?      ← deterministic, before anything else
 *     ↓
 *   context + authorized bookings
 *     ↓
 *   booking-intent detection   ← LLM, returns UNKNOWN for new service needs
 *     ↓
 *   resolution ladder          ← pure, deterministic
 *     ↓
 *   confidence policy
 *     ↓
 *   domain tool                ← ownership enforced in SQL
 *     ↓
 *   UI schema + context update + persisted message
 *
 * When intent detection returns UNKNOWN, this returns `null` and the caller
 * falls through to the EXISTING extract/intent-gate flow, untouched. That is
 * the integration contract: this feature is additive, and a user saying "I
 * need a plumber" never notices it exists.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO DECIDE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Decides: what the user probably meant.
 * Does not decide: which booking that is (the ladder does), whether the user
 * may see it (SQL does), whether it may be cancelled (the state graph does),
 * or which component renders (this file does, from the tool's real result).
 */

import {
  type AgentReply,
  type IntentName,
  type UISchema,
  isMutationIntent,
} from '@locogi/types'
import { conversationRepo, requestRepo, type BookingCandidate } from '../repositories'
import { runTask } from '../ai/contract'
import { detectBookingIntentTask } from '../ai/tasks/detect-booking-intent'
import {
  resolveBooking,
  judgeConfidence,
  type Resolution,
} from '../domain/booking-resolution'
import { readConfirmationReply } from '../domain/confirmation-reply'
import { BookingToolsService } from './booking-tools.service'
import { ConversationalCommerceService, type ChatSession } from './conversational-commerce.service'
import { logger } from '../lib/logger'

const tools = new BookingToolsService()
const commerce = new ConversationalCommerceService()

/** Identifiers only — see UISchema's contract on why no snapshots. */
function ui(type: UISchema['type'], data: Record<string, unknown> = {}): UISchema {
  return { type, data }
}

function describe(b: BookingCandidate): string {
  return b.categories[0] ?? b.description.slice(0, 40)
}

export class ChatOrchestratorService {
  /**
   * Handle a message — either about existing bookings, new orders, or
   * general discovery. Nothing falls through unhandled anymore.
   *
   * If the user has an active commerce session (ordering from a specific
   * org), ALL messages route through the conversational commerce flow.
   * Otherwise, intent detection decides.
   */
  async handle(params: {
    userId: string
    text: string
    orgId?: string   // set when chatting with a specific business
    now?: Date
  }): Promise<AgentReply | null> {
    const { userId, text, orgId } = params
    const now = params.now ?? new Date()

    // ── 0. Active commerce session? Route everything there ──────────────
    //    When a user is mid-order ("add a kebab"), every message goes to
    //    the commerce flow until they complete or cancel.
    const activeOrg = orgId ?? await this.getActiveCommerceOrg(userId)
    if (activeOrg) {
      return this.handleCommerce(userId, text, activeOrg)
    }

    // ── 1. Is this the answer to a question we asked? ───────────────────
    const pendingReply = await this.resolvePending(userId, text)
    if (pendingReply) return pendingReply

    // ── 2. Context and the authorized candidate set ─────────────────────
    const context = await conversationRepo.get(userId)
    const candidates = await requestRepo.listBookingsForResolution(userId)

    // ── 3. Intent detection ─────────────────────────────────────────────
    const detection = await runTask(detectBookingIntentTask, {
      text,
      bookings: candidates.slice(0, 10).map((b) => ({
        id: b.id,
        category: describe(b),
        vendorName: b.vendorName,
        when: b.slotTime,
        status: b.status,
      })),
      lastIntent: context?.lastIntent ?? null,
      activeBookingId: context?.activeBookingId ?? null,
    })

    if (!detection.ok) {
      logger.warn({ reason: detection.reason }, 'Booking intent detection unavailable')
      // Fallback: try commerce discovery if possible
      return this.handleDiscovery(userId, text)
    }

    const intent = detection.data

    logger.info(
      { stage: 'intent_detected', intent: intent.name, confidence: intent.confidence },
      'chat.intent'
    )

    // ── 4. Route by intent ──────────────────────────────────────────────

    // New service need → discover businesses + start ordering
    if (intent.name === 'CREATE_SERVICE_REQUEST' || intent.name === 'SEARCH_PROVIDERS') {
      return this.handleDiscovery(userId, text)
    }

    // Unknown → try discovery as a last resort
    if (intent.name === 'UNKNOWN') {
      return this.handleDiscovery(userId, text)
    }

    // ── 3. List intents need no resolution ──────────────────────────────────
    if (intent.name === 'GET_BOOKINGS') {
      return this.replyWithList(userId, candidates)
    }

    // ── 4. Resolve which booking ────────────────────────────────────────────
    const resolution = resolveBooking({
      intent,
      candidates,
      context: {
        activeBookingId: context?.activeBookingId,
        lastReferencedBookingId:
          context?.lastReferencedEntity?.type === 'booking'
            ? context.lastReferencedEntity.id
            : undefined,
      },
      now,
    })

    logger.info(
      {
        stage: 'context_resolved',
        status: resolution.status,
        source: resolution.status === 'RESOLVED' ? resolution.source : undefined,
        candidateCount:
          resolution.status === 'AMBIGUOUS' ? resolution.candidates.length : undefined,
      },
      'chat.resolution'
    )

    if (resolution.status === 'NOT_FOUND') {
      return this.replyNotFound(resolution.reason, candidates.length)
    }

    if (resolution.status === 'AMBIGUOUS') {
      return this.replyAmbiguous(userId, intent.name, resolution.candidates)
    }

    // ── 5. Confidence ───────────────────────────────────────────────────────
    const verdict = judgeConfidence({
      confidence: intent.confidence,
      isMutation: isMutationIntent(intent.name),
      resolution,
    })

    if (verdict === 'reject') return null
    if (verdict === 'clarify' && isMutationIntent(intent.name)) {
      // Low confidence on a destructive verb: ask rather than assume.
      return this.replyConfirmMutation(userId, intent.name, resolution.booking)
    }

    // ── 6. Execute ──────────────────────────────────────────────────────────
    return this.execute(userId, intent.name, resolution.booking)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pending confirmations
  // ═══════════════════════════════════════════════════════════════════════════

  private async resolvePending(
    userId: string,
    text: string
  ): Promise<AgentReply | null> {
    const context = await conversationRepo.get(userId)
    const pending = context?.pendingConfirmation
    if (!pending) return null

    const reply = readConfirmationReply(text)

    if (reply === 'unrelated') {
      // They moved on. Disarm so a stray "yes" three turns later cannot
      // execute an action they have forgotten about.
      await conversationRepo.clearPending(userId)
      return null
    }

    if (reply === 'negative') {
      await conversationRepo.clearPending(userId)
      logger.info({ stage: 'confirmation_declined', intent: pending.intent }, 'chat.confirm')
      return {
        message: 'No problem — I have left it as it is.',
        ui: ui('booking_detail', { bookingId: pending.bookingId }),
        intent: pending.intent,
      }
    }

    // Consume atomically: a double-tapped "yes" must not cancel twice.
    const armed = await conversationRepo.consumePending(userId)
    if (!armed) {
      return {
        message:
          "That confirmation expired, so I did not act on it. Tell me again what you'd like to do.",
      }
    }

    logger.info({ stage: 'confirmation_accepted', intent: armed.intent }, 'chat.confirm')
    return this.executeConfirmed(userId, armed.intent, armed.bookingId)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Execution
  // ═══════════════════════════════════════════════════════════════════════════

  private async execute(
    userId: string,
    name: IntentName,
    booking: BookingCandidate
  ): Promise<AgentReply> {
    // Remember what we are talking about, whatever happens next.
    await conversationRepo.update(userId, {
      activeBookingId: booking.id,
      activeProviderId: booking.vendorId ?? undefined,
      lastIntent: name,
      lastReferencedEntity: { type: 'booking', id: booking.id },
    })

    switch (name) {
      case 'GET_BOOKING':
        return this.replyDetail(userId, booking.id)

      case 'GET_BOOKING_STATUS': {
        const r = await tools.getBooking(booking.id, userId)
        if (!r.ok) return this.replyNotFound('booking_not_found', 1)
        return {
          message: this.statusSentence(r.booking),
          ui: ui('booking_status', { bookingId: booking.id }),
          intent: name,
        }
      }

      case 'TRACK_BOOKING':
        return this.replyTracking(userId, booking.id)

      case 'GET_QUOTES': {
        const r = await tools.getQuotes(booking.id, userId)
        if (!r.ok) return this.replyNotFound('booking_not_found', 1)
        return {
          message: 'Here are the quotes on that request.',
          ui: ui('quote_list', { requestId: booking.id }),
          intent: name,
        }
      }

      case 'GET_PAYMENT':
        return {
          message:
            booking.agreedPrice !== null
              ? `The agreed price for your ${describe(booking)} booking is ₹${booking.agreedPrice.toLocaleString('en-IN')}.`
              : 'No price has been agreed on that booking yet.',
          ui: ui('payment', { bookingId: booking.id }),
          intent: name,
        }

      case 'CONTACT_PROVIDER':
        if (!booking.vendorId) {
          return {
            message: 'No provider has been assigned to that booking yet, so there is nobody to message.',
            ui: ui('booking_detail', { bookingId: booking.id }),
            intent: name,
          }
        }
        return {
          message: `Opening your chat with ${booking.vendorName ?? 'the provider'}.`,
          ui: ui('booking_detail', { bookingId: booking.id, focus: 'messages' }),
          intent: name,
        }

      // ── Destructive: never executed here, only proposed ──────────────────
      case 'CANCEL_BOOKING':
      case 'RESCHEDULE_BOOKING':
        return this.replyConfirmMutation(userId, name, booking)

      default:
        return this.replyDetail(userId, booking.id)
    }
  }

  /** Runs only after an explicit, in-window "yes". */
  private async executeConfirmed(
    userId: string,
    name: IntentName,
    bookingId: string
  ): Promise<AgentReply> {
    if (name === 'CANCEL_BOOKING') {
      const result = await tools.cancelBooking(bookingId, userId)

      logger.info(
        { stage: 'tool_executed', tool: 'cancelBooking', ok: result.ok },
        'chat.tool'
      )

      if (!result.ok) {
        return {
          message:
            result.reason === 'not_found'
              ? "I could not find that booking."
              : result.detail,
          ui: ui('booking_detail', { bookingId }),
          intent: name,
        }
      }

      return {
        message: 'Your booking is cancelled.',
        ui: ui('booking_detail', { bookingId }),
        intent: name,
      }
    }

    if (name === 'RESCHEDULE_BOOKING') {
      // Rescheduling needs a target slot, which a yes/no cannot supply. Hand
      // the user the existing slot picker rather than inventing a time.
      return {
        message: 'Pick a new time that suits you.',
        ui: ui('slot_picker', { requestId: bookingId }),
        intent: name,
      }
    }

    return { message: 'Done.', intent: name }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Replies
  // ═══════════════════════════════════════════════════════════════════════════

  private async replyWithList(
    userId: string,
    candidates: BookingCandidate[]
  ): Promise<AgentReply> {
    await conversationRepo.update(userId, { lastIntent: 'GET_BOOKINGS' })

    if (candidates.length === 0) {
      return {
        message: "You don't have any upcoming bookings.",
        ui: ui('empty_state', { subject: 'bookings', action: 'find_service' }),
        intent: 'GET_BOOKINGS',
      }
    }

    return {
      message:
        candidates.length === 1
          ? 'Here is your booking.'
          : `Here are your ${candidates.length} bookings.`,
      ui: ui('booking_list', { bookingIds: candidates.map((b) => b.id) }),
      intent: 'GET_BOOKINGS',
    }
  }

  private async replyDetail(userId: string, bookingId: string): Promise<AgentReply> {
    const r = await tools.getBooking(bookingId, userId)
    logger.info({ stage: 'tool_executed', tool: 'getBooking', ok: r.ok }, 'chat.tool')

    if (!r.ok) return this.replyNotFound('booking_not_found', 1)

    return {
      message: `Here is your ${describe(r.booking)} booking.`,
      ui: ui('booking_detail', { bookingId }),
      intent: 'GET_BOOKING',
    }
  }

  private async replyTracking(userId: string, bookingId: string): Promise<AgentReply> {
    const r = await tools.trackBooking(bookingId, userId)
    logger.info({ stage: 'tool_executed', tool: 'trackBooking', ok: r.ok }, 'chat.tool')

    if (!r.ok) return this.replyNotFound('booking_not_found', 1)

    if (!r.tracking.available) {
      // Say what is actually true. Implying live tracking that isn't running
      // makes the customer wait instead of calling.
      const why = {
        no_vendor: 'No provider has been assigned yet, so there is nothing to track.',
        not_started:
          'That booking is not active yet, so live location is not being shared.',
        not_sharing:
          `${r.booking.vendorName ?? 'The provider'} is not sharing their location right now. ` +
          'You can message them to ask where they are.',
      }[r.tracking.why]

      return {
        message: why,
        ui: ui('booking_detail', { bookingId }),
        intent: 'TRACK_BOOKING',
      }
    }

    return {
      message: `${r.booking.vendorName ?? 'Your provider'} is on the way.`,
      ui: ui('booking_tracking', { bookingId }),
      intent: 'TRACK_BOOKING',
    }
  }

  private async replyAmbiguous(
    userId: string,
    name: IntentName,
    candidates: BookingCandidate[]
  ): Promise<AgentReply> {
    await conversationRepo.update(userId, { lastIntent: name })

    return {
      message: `You have ${candidates.length} bookings. Which one do you mean?`,
      ui: ui('booking_selector', {
        bookingIds: candidates.map((b) => b.id),
        // Carried so the selection can complete the original request without
        // the user retyping it.
        forIntent: name,
      }),
      intent: name,
    }
  }

  private async replyConfirmMutation(
    userId: string,
    name: IntentName,
    booking: BookingCandidate
  ): Promise<AgentReply> {
    await conversationRepo.setPending(userId, name, booking.id)

    const verb = name === 'CANCEL_BOOKING' ? 'cancel' : 'reschedule'
    return {
      message: `Are you sure you want to ${verb} your ${describe(booking)} booking?`,
      ui: ui('confirm_action', {
        bookingId: booking.id,
        intent: name,
        confirmLabel: name === 'CANCEL_BOOKING' ? 'Cancel booking' : 'Reschedule',
        cancelLabel: 'Keep booking',
      }),
      intent: name,
    }
  }

  private replyNotFound(reason: string, totalBookings: number): AgentReply {
    if (reason === 'no_bookings' || totalBookings === 0) {
      return {
        message: "You don't have any upcoming bookings.",
        ui: ui('empty_state', { subject: 'bookings', action: 'find_service' }),
      }
    }

    const message =
      {
        no_booking_in_category: "I couldn't find a booking matching that service.",
        no_booking_on_date: "I couldn't find a booking on that date.",
        booking_not_found: "I couldn't find that booking.",
      }[reason] ?? "I couldn't find that booking."

    return { message, ui: ui('empty_state', { subject: 'bookings', action: 'view_all' }) }
  }

  private statusSentence(b: BookingCandidate): string {
    const what = describe(b)
    switch (b.status) {
      case 'confirmed':
        return `Yes — your ${what} booking is confirmed.`
      case 'in_progress':
        return `Your ${what} booking is under way right now.`
      case 'open':
      case 'negotiating':
        return `Not yet — your ${what} request is still waiting on a provider to confirm.`
      case 'waitlisted':
        return `You are on the waitlist for ${what}; nothing is confirmed yet.`
      case 'cancelled':
        return `That ${what} booking was cancelled.`
      case 'completed':
        return `Your ${what} booking is complete.`
      case 'disrupted':
        return `The provider pulled out of your ${what} booking — you'll need to pick someone else.`
      default:
        return `Your ${what} booking is currently ${b.status.replace(/_/g, ' ')}.`
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Conversational Commerce — ordering/booking through chat
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Route a message to the conversational commerce flow for a specific org.
   * This handles the ENTIRE ordering/booking experience:
   *   "2 chicken biryani" → adds to cart
   *   "9876543210" → captures phone
   *   "yes" → places order
   */
  private async handleCommerce(
    userId: string,
    text: string,
    orgId: string,
  ): Promise<AgentReply> {
    const result = await commerce.handle({ userId, orgId, text })

    logger.info(
      {
        stage: 'commerce',
        orgId,
        phase: result.session.phase,
        cartSize: result.session.cart.length,
      },
      'chat.commerce'
    )

    // Store active org in context so next message auto-routes here
    if (result.session.phase !== 'completed') {
      await conversationRepo.update(userId, {
        lastIntent: 'CREATE_SERVICE_REQUEST',
        activeBookingId: undefined,
        lastReferencedEntity: { type: 'service_request' as any, id: orgId },
      })
    }

    return {
      message: result.message,
      ui: result.ui,
      intent: 'CREATE_SERVICE_REQUEST',
    }
  }

  /**
   * Handle discovery: find businesses matching the user's need.
   *
   * Uses the extract-request AI to understand what they want, then
   * searches for matching businesses. If exactly one match, starts
   * ordering immediately. If multiple, shows a choice.
   */
  private async handleDiscovery(
    userId: string,
    text: string,
  ): Promise<AgentReply> {
    // Use the existing extract-request task to understand intent
    const { extractRequestTask } = await import('../ai/tasks/extract-request')
    const extraction = await runTask(extractRequestTask, { text })

    if (!extraction.ok) {
      return {
        message: "I'm not sure what you're looking for. Could you describe it differently?",
        ui: ui('empty_state', { subject: 'search', action: 'try_again' }),
      }
    }

    const data = extraction.data

    // Search for matching organizations
    const searchQuery = data.categoryTags.join(' ') + ' ' + text
    const orgs = await this.searchOrganizations(searchQuery, data.categoryTags)

    if (orgs.length === 0) {
      // No org found — fall back to the vendor matching flow
      // (individual vendors, not orgs)
      return {
        message: `I found some providers for ${data.categoryTags[0]}. Let me match you with the best ones nearby.`,
        ui: ui('searching', { categoryTags: data.categoryTags }),
        intent: 'CREATE_SERVICE_REQUEST',
      }
    }

    if (orgs.length === 1) {
      // Exactly one match — start ordering directly
      const org = orgs[0]
      return this.handleCommerce(userId, text, org.id)
    }

    // Multiple matches — show rich listings
    // Fetch extra details for each org (description, contact, catalog preview)
    const { query: dbQuery } = await import('../lib/db')
    const { enrichBusiness } = await import('../lib/exa')
    const enrichedOrgs = await Promise.all(
      orgs.map(async (o) => {
        // Fetch org details + top 3 catalog items + vendor info + Exa web data
        const [orgDetail, catalogPreview, vendorInfo, exaData] = await Promise.all([
          dbQuery<{
            contact_phone: string | null
            website: string | null
            logo_url: string | null
          }>(`SELECT contact_phone, website, logo_url FROM organizations WHERE id = $1`, [o.id])
            .then(r => r.rows[0] ?? {}),
          dbQuery<{
            name: string
            price: number
            section: string | null
          }>(`SELECT name, price, section FROM catalog_items
              WHERE organization_id = $1 AND is_available = true
              ORDER BY display_order LIMIT 3`, [o.id])
            .then(r => r.rows),
          dbQuery<{
            raw_description: string | null
          }>(`SELECT v.raw_description FROM vendors v
              JOIN organizations org ON org.vendor_id = v.id
              WHERE org.id = $1`, [o.id])
            .then(r => r.rows[0]?.raw_description ?? null),
          // Exa: pull portfolio/review links from the web
          enrichBusiness(o.displayName, o.area ?? 'Hyderabad').catch(() => null),
        ])

        return {
          id: o.id,
          name: o.displayName,
          type: o.orgType,
          area: o.area,
          rating: o.rating,
          phone: orgDetail.contact_phone,
          website: orgDetail.website,
          logoUrl: orgDetail.logo_url,
          description: vendorInfo,
          topItems: catalogPreview.map(ci => ({
            name: ci.name,
            price: ci.price,
            section: ci.section,
          })),
          // Exa-powered web data
          portfolio: exaData?.portfolio ?? [],
          reviews: exaData?.reviews ?? [],
        }
      })
    )

    return {
      message: `I found ${orgs.length} studios for you! Here's what they offer:`,
      ui: ui('vendor_list' as any, {
        items: enrichedOrgs,
        selectable: true,
      }),
      intent: 'SEARCH_PROVIDERS',
    }
  }

  /**
   * Check if the user has an active commerce session in Redis.
   * Returns the orgId if a session exists, null otherwise.
   */
  private async getActiveCommerceOrg(userId: string): Promise<string | null> {
    try {
      const { redis } = await import('../lib/redis')

      // Scan for any active commerce session for this user
      // Session keys are: chat_session:{userId}:{orgId}
      const keys = await redis.keys(`chat_session:${userId}:*`)
      if (keys.length === 0) return null

      // Return the most recent session's org
      const raw = await redis.get(keys[0])
      if (!raw) return null

      const session = JSON.parse(raw)
      // Only return if the session is still active (not completed)
      if (session.phase === 'completed') return null

      return session.orgId
    } catch {
      return null
    }
  }

  /**
   * Search for organizations matching a query.
   * Uses the organizations table with text search.
   */
  private async searchOrganizations(
    searchQuery: string,
    categoryTags: string[],
  ): Promise<Array<{
    id: string
    displayName: string
    orgType: string
    area: string | null
    rating: number
  }>> {
    try {
      // Try Moss first — sub-10ms semantic search
      const { mossSearch, MOSS_INDEX } = await import('../lib/moss')
      const mossResults = await mossSearch(MOSS_INDEX.CATALOG, searchQuery, { limit: 10 })

      if (mossResults.length > 0) {
        // Group by org_id, pick unique orgs
        const orgMap = new Map<string, { orgId: string; orgName: string; area: string }>()
        for (const r of mossResults) {
          const orgId = String(r.metadata.organization_id ?? '')
          if (orgId && !orgMap.has(orgId)) {
            orgMap.set(orgId, {
              orgId,
              orgName: String(r.metadata.org_name ?? ''),
              area: String(r.metadata.org_area ?? ''),
            })
          }
        }
        return Array.from(orgMap.values()).slice(0, 5).map(o => ({
          id: o.orgId,
          displayName: o.orgName,
          orgType: 'business',
          area: o.area || null,
          rating: 4.5,
        }))
      }

      // Fallback: SQL ILIKE (slower but works without Moss)
      const { query: dbQuery } = await import('../lib/db')
      const result = await dbQuery<{
        id: string
        display_name: string
        org_type: string
        area: string | null
      }>(`
        SELECT DISTINCT o.id, o.display_name, o.org_type, o.area
        FROM organizations o
        LEFT JOIN catalog_items ci ON ci.organization_id = o.id
        WHERE o.verification_status != 'rejected'
          AND (
            o.display_name ILIKE '%' || $1 || '%'
            OR o.area ILIKE '%' || $1 || '%'
            OR ci.name ILIKE '%' || $1 || '%'
          )
        LIMIT 5
      `, [categoryTags[0] ?? searchQuery.split(' ')[0]])

      return result.rows.map(r => ({
        id: r.id,
        displayName: r.display_name,
        orgType: r.org_type,
        area: r.area,
        rating: 4.5,
      }))
    } catch {
      return []
    }
  }
}
