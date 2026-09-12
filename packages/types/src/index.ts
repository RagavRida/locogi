// ─── Users ───────────────────────────────────────────────────────────────────
export interface User {
  id: string
  phone: string
  name: string | null
  isVendor: boolean
  isCustomer: boolean
  emergencyContactPhone: string | null
  isBanned: boolean
  consentGivenAt: string
  createdAt: string
}

// ─── Vendors ─────────────────────────────────────────────────────────────────
export interface Vendor {
  id: string
  userId: string
  rawDescription: string
  categoryTags: string[]
  attributes: Record<string, unknown>
  attributeSchema: Record<string, AttributeFieldType>
  embeddingGeneratedAt: string | null
  serviceAreaDescription: string | null
  serviceRadiusKm: number
  isPriority: boolean
  isKycVerified: boolean
  rating: number
  responseRate: number
  completedJobs: number
  createdAt: string
}

export type AttributeFieldType = 'text' | 'number' | 'date' | 'currency' | 'list'

export interface VendorAvailability {
  id: string
  vendorId: string
  dayOfWeek: number  // 0=Sun … 6=Sat
  startTime: string  // "09:00"
  endTime: string    // "20:00"
}

// ─── Requests ────────────────────────────────────────────────────────────────
export type BookingType = 'quote' | 'appointment' | 'hiring' | 'order'

/**
 * Every state a request can hold.
 *
 * Mirrors the `requests_status_check` constraint after migration 006. This
 * list lived here with only the first eight for a while, which meant the
 * mobile client had no way to represent a waitlisted or disrupted booking —
 * those rows exist in the database and were simply unrepresentable in the
 * client's types.
 *
 * The API layers the legal-transition GRAPH on top of this in
 * `apps/api/src/domain/request-state.ts`. The set of states is shared because
 * both sides must agree on what can come back over the wire; the transition
 * rules are not, because only the server enforces them.
 */
export const REQUEST_STATUSES = [
  'open',
  'negotiating',
  'confirmed',
  'in_progress',
  'completed',
  'expired',
  'cancelled',
  'no_match',
  'rescheduled',
  'no_show_customer',
  'no_show_vendor',
  'disrupted',
  'waitlisted',
] as const

export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export interface Request {
  id: string
  customerId: string
  idempotencyKey: string
  rawDescription: string
  categoryTags: string[]
  attributes: Record<string, unknown>
  bookingType: BookingType
  status: RequestStatus
  confirmedVendorId: string | null
  agreedPrice: number | null
  rematchingAttempt: number
  createdAt: string
  expiresAt: string | null
}

// ─── Request Responses ───────────────────────────────────────────────────────
export type ResponseStatus =
  | 'pending' | 'quoted' | 'counter' | 'confirmed' | 'declined' | 'missed'
  | 'applied' | 'shortlisted' | 'selected' | 'rejected' | 'withdrawn'
  | 'delivered' | 'no_show' | 'cancelled_by_vendor'

export interface RequestResponse {
  id: string
  requestId: string
  vendorId: string
  status: ResponseStatus
  quotedPrice: number | null
  message: string | null
  notifiedAt: string
  respondedAt: string | null
}

// ─── Reservation Slots ───────────────────────────────────────────────────────
/**
 * A bookable time slot.
 *
 * Slots belong to a BOOKABLE RESOURCE (a restaurant table, a doctor, a
 * stylist, or a solo vendor's implicit 'person' resource) — never directly
 * to a vendor. A restaurant's 7pm slot exists per table; a hospital's 10am
 * slot exists per doctor. A vendor-level slot cannot express either.
 *
 * The older vendor-keyed `ReservationSlot` was removed in migration 010 after
 * a split-brain bug: bookings wrote the vendor-level table while reminders,
 * no-show detection, reschedule, waitlist and travel checks read this one.
 */
export interface ResourceSlot {
  id: string
  resourceId: string
  slotTime: string
  durationMinutes: number
  capacityTotal: number
  capacityBooked: number
  /** Overrides the resource's base price for this slot (peak pricing). */
  priceOverride: number | null
  isCancelled: boolean
  cancelledAt: string | null
  cancelReason: string | null
}

// ─── Messages ────────────────────────────────────────────────────────────────
export type MessageType =
  | 'text' | 'image' | 'quote_offer' | 'quote_counter'
  | 'quote_accepted' | 'system'

export interface Message {
  id: string
  requestId: string
  senderId: string
  text: string | null
  imageUrl: string | null
  messageType: MessageType
  metadata: Record<string, unknown> | null
  createdAt: string
}

// ─── LLM Extraction ──────────────────────────────────────────────────────────
export interface ExtractionResult {
  categoryTags: string[]
  attributes: Record<string, unknown>
  attributeSchema: Record<string, AttributeFieldType>
  bookingTypeSuggestion: BookingType
  languageDetected: 'en' | 'te' | 'hi' | 'mixed'
  ambiguityFlag: boolean
  ambiguityNote: string | null
  followUpQuestions: string[]
}

// ─── Agent ───────────────────────────────────────────────────────────────────
export interface AgentDecision {
  id: string
  vendorId: string
  requestId: string
  decision: 'auto_accepted' | 'auto_quoted' | 'auto_declined' | 'escalated_to_vendor'
  reasoning: string
  rulesSnapshot: Record<string, unknown>
  confidence: number
  createdAt: string
}

export interface VendorAgentRules {
  id: string
  vendorId: string
  rulesPlainText: string | null
  maxAutoAcceptPrice: number | null
  autoAcceptAreas: string[]
  autoAcceptDays: number[]
  genderFilter: string | null
  autoAcceptEnabled: boolean
  updatedAt: string
}

// ─── Reviews ─────────────────────────────────────────────────────────────────
export interface Review {
  id: string
  requestId: string
  reviewerId: string
  vendorId: string
  rating: number
  comment: string | null
  createdAt: string
}

// ─── Telegram Session ────────────────────────────────────────────────────────
export interface TelegramSession {
  step: 'idle' | 'onboarding_role' | 'onboarding_description'
    | 'follow_up' | 'confirming' | 'awaiting_quote' | 'in_booking'
  role: 'customer' | 'vendor' | null
  pendingExtraction: ExtractionResult | null
  activeRequestId: string | null
  pendingFollowUps: string[]
  followUpAnswers: Record<string, string>
  userId: string | null
}

// ═════════════════════════════════════════════════════════════════════════════
// CONVERSATIONAL INTENT + UI PROTOCOL
// ═════════════════════════════════════════════════════════════════════════════
//
// Shared because the client renders what the server decides. Both halves must
// agree on the vocabulary or the registry silently drops components.
//
// ── On the word "booking" ───────────────────────────────────────────────────
// There is no Booking table in this system and deliberately so. A booking IS a
// `request` that reached a committed status (confirmed / in_progress, and the
// terminal states that follow). Introducing a separate Booking entity would
// fork the domain: two ids for one job, two lifecycles, two authorization
// paths. Everything below therefore resolves to a request id, and "bookingId"
// is the user-facing name for it.

/**
 * Operations a user can ask for in conversation.
 *
 * This is a DIFFERENT axis from `Intent` in the API's intent.service, which
 * answers "is this a new service need at all?" (service_request /
 * place_discovery / social_community / ...). This one answers "what operation
 * on things that already exist?" They compose; they do not compete.
 */
export type IntentName =
  | 'GET_BOOKINGS'
  | 'GET_BOOKING'
  | 'GET_BOOKING_STATUS'
  | 'TRACK_BOOKING'
  | 'CANCEL_BOOKING'
  | 'RESCHEDULE_BOOKING'
  | 'CONTACT_PROVIDER'
  | 'GET_QUOTES'
  | 'SEARCH_PROVIDERS'
  | 'CREATE_SERVICE_REQUEST'
  | 'GET_PAYMENT'
  | 'UNKNOWN'

export const READ_INTENTS = [
  'GET_BOOKINGS',
  'GET_BOOKING',
  'GET_BOOKING_STATUS',
  'TRACK_BOOKING',
  'GET_QUOTES',
  'GET_PAYMENT',
  'SEARCH_PROVIDERS',
] as const

/**
 * Intents that change state and therefore require explicit confirmation
 * before they execute. Ambiguous natural language must never destroy a
 * booking on its own.
 */
export const MUTATION_INTENTS = [
  'CANCEL_BOOKING',
  'RESCHEDULE_BOOKING',
  'CONTACT_PROVIDER',
  'CREATE_SERVICE_REQUEST',
] as const

export function isMutationIntent(name: IntentName): boolean {
  return (MUTATION_INTENTS as readonly string[]).includes(name)
}

export interface UserIntent {
  name: IntentName
  bookingId?: string
  providerId?: string
  serviceRequestId?: string
  category?: string
  date?: string
  time?: string
  status?: string
  /** 0-1. Never the sole basis for acting — see the API's confidence policy. */
  confidence: number
}

export type ReferencedEntityType = 'booking' | 'provider' | 'quote' | 'service_request'

export interface ConversationContext {
  activeServiceRequestId?: string
  activeBookingId?: string
  activeProviderId?: string
  lastIntent?: IntentName
  lastReferencedEntity?: { type: ReferencedEntityType; id: string }
  /** Set when a mutation is awaiting the user's yes/no. */
  pendingConfirmation?: { intent: IntentName; bookingId: string; expiresAt: string }
  updatedAt: string
}

// ─── UI protocol ─────────────────────────────────────────────────────────────

/**
 * The complete set of components the server may ask the client to render.
 *
 * The first eleven already existed in the mobile store as `CardType` and are
 * reproduced verbatim — the existing chat flow renders them today and must
 * keep working. The booking_* additions are new.
 *
 * An LLM never produces one of these directly; the orchestrator picks it after
 * the domain tool has returned real data.
 */
export const UI_COMPONENT_TYPES = [
  // Pre-existing — do not rename, the current flow depends on these
  'confirmation',
  'category',
  'vendor_list',
  'quote',
  'slot_picker',
  'job_tracker',
  'review',
  'rebook',
  'follow_up',
  'ambiguity',
  'searching',
  // Added for conversational booking retrieval
  'booking_list',
  'booking_detail',
  'booking_status',
  'booking_tracking',
  'booking_selector',
  'quote_list',
  'payment',
  'empty_state',
  'confirm_action',
] as const

export type UIComponentType = (typeof UI_COMPONENT_TYPES)[number]

export function isUIComponentType(v: unknown): v is UIComponentType {
  return typeof v === 'string' && (UI_COMPONENT_TYPES as readonly string[]).includes(v)
}

/**
 * What the server sends the client to render.
 *
 * `data` carries IDENTIFIERS, not snapshots. A persisted `{ price: 4500,
 * status: "CONFIRMED" }` becomes a lie the moment the booking changes, and
 * scrolling back through a conversation would show stale state as if it were
 * current. The component re-fetches through the authorized API instead.
 */
export interface UISchema {
  type: UIComponentType
  data: Record<string, unknown>
}

export interface AgentReply {
  message: string
  ui?: UISchema
  /** Echoed for observability and client-side telemetry. */
  intent?: IntentName
}

// ═════════════════════════════════════════════════════════════════════════════
// REAL-TIME PROTOCOL
// ═════════════════════════════════════════════════════════════════════════════
//
// ── The one rule that shapes everything below ───────────────────────────────
//
// A realtime message is a NUDGE, never a source of truth.
//
// It says "booking X changed" and the client refetches through the normal
// authorized API. It does not carry the new status, the new price, or the new
// vendor. Three reasons, and each has bitten real systems:
//
//   1. WebSocket delivery is not guaranteed. A client that missed a frame
//      while backgrounded would hold state that silently disagrees with the
//      database, forever.
//   2. A payload sent at 12:00:01 describes the world at 12:00:01. By the
//      time it renders, it may be wrong.
//   3. Authorization is enforced on the REST read. If state travelled over
//      the socket, every field would need its own permission check on a code
//      path where nobody remembers to do that.
//
// So the socket is an invalidation channel. Postgres stays the source of
// truth, and a reconnecting client simply refetches — no replay buffer, no
// missed-event cursor, no divergence.

export const WS_SERVER_EVENTS = [
  /** A booking's state changed. Refetch it. */
  'booking.changed',
  /** The assigned provider moved, or their tracking phase changed. */
  'tracking.updated',
  /** A new quote arrived on a request. */
  'quote.received',
  /** Server acknowledging a subscribe/unsubscribe. */
  'subscribed',
  'unsubscribed',
  /** Something the client asked for was refused. */
  'error',
  /** Liveness. */
  'pong',
] as const

export type WsServerEventType = (typeof WS_SERVER_EVENTS)[number]

export const WS_CLIENT_ACTIONS = ['subscribe', 'unsubscribe', 'ping'] as const
export type WsClientAction = (typeof WS_CLIENT_ACTIONS)[number]

/**
 * What a client may watch.
 *
 * Deliberately coarse. A finer-grained topic space would mean more
 * authorization checks on the subscribe path, and every one is a chance to
 * forget one.
 */
export type WsTopic =
  | { kind: 'booking'; id: string }
  | { kind: 'tracking'; id: string }

export interface WsClientMessage {
  action: WsClientAction
  topic?: WsTopic
}

/**
 * Where a provider is in their journey to the job.
 *
 * ── Why these are NOT booking states ────────────────────────────────────────
 *
 * The request state machine has 13 states, a generated migration and a
 * database trigger enforcing 27 transitions. Adding EN_ROUTE and ARRIVED to
 * it would mean new legal edges through the most safety-critical part of the
 * schema, for information that is neither durable nor authoritative: a
 * provider is "en route" because their phone said so ninety seconds ago.
 *
 * A booking is `confirmed` the whole time this is changing. So these live on
 * `live_locations`, alongside the coordinates they belong with, and expire
 * the same way — a phase from forty minutes ago is not a phase.
 */
export const TRACKING_PHASES = [
  'not_started',
  'en_route',
  'arrived',
  'in_progress',
  'finished',
] as const

export type TrackingPhase = (typeof TRACKING_PHASES)[number]

export function isTrackingPhase(v: unknown): v is TrackingPhase {
  return typeof v === 'string' && (TRACKING_PHASES as readonly string[]).includes(v)
}

export interface WsServerMessage {
  type: WsServerEventType
  /** Which entity this concerns. Absent on pong. */
  topic?: WsTopic
  /**
   * Identifiers and hints ONLY — never authoritative state.
   * e.g. { bookingId, phase } so the client knows what to refetch and can
   * show a phase label without waiting for the round trip.
   */
  data?: Record<string, unknown>
  /** Server clock, so a client can discard out-of-order frames. */
  ts: string
}
