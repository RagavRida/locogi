/**
 * Which booking does the user mean?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A PURE FUNCTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Resolution decides which of a user's bookings a sentence like "cancel it"
 * refers to. Get it wrong and you cancel the wrong job. That makes it the
 * single most test-worthy piece of this feature — so it takes candidates as an
 * argument and returns a decision, with no database, no clock beyond an
 * injected `now`, and no LLM. Every rule below is exercised by a test that
 * runs in microseconds.
 *
 * The impure parts — fetching candidates, checking ownership, calling the
 * model — live in the service that calls this.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LADDER IS ORDERED, NOT SCORED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A weighted score would let two weak signals outvote one strong one: a
 * category guess plus a recency nudge could beat an explicitly named booking
 * id. Strict precedence makes "the user said BK10291" unbeatable by anything
 * softer, and makes every outcome explainable — `resolutionSource` names the
 * rung that decided it.
 *
 * When nothing decides, the answer is AMBIGUOUS and the user is asked. Never
 * a coin flip: picking arbitrarily is indistinguishable from picking correctly
 * until the moment it cancels the wrong booking.
 */

import type { BookingCandidate } from '../repositories/request.repository'
import type { UserIntent } from '@locogi/types'

export type ResolutionSource =
  | 'explicit_id'
  | 'provider_reference'
  | 'category_reference'
  | 'date_reference'
  | 'active_context'
  | 'last_referenced'
  | 'sole_candidate'
  | 'sole_upcoming'

export type Resolution =
  | { status: 'RESOLVED'; booking: BookingCandidate; source: ResolutionSource }
  | { status: 'AMBIGUOUS'; candidates: BookingCandidate[]; reason: string }
  | { status: 'NOT_FOUND'; reason: string }

export interface ResolutionContext {
  activeBookingId?: string
  lastReferencedBookingId?: string
}

/** Everything the ladder needs, all of it already authorized by the caller. */
export interface ResolutionInput {
  intent: UserIntent
  /** MUST already be filtered to the authenticated user's own bookings. */
  candidates: BookingCandidate[]
  context: ResolutionContext
  now: Date
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Punctuation and spacing removed entirely.
 *
 * Needed because `normalise` turns "A/C" into "a c", which does not contain
 * "ac" — so a user typing the perfectly ordinary "A/C" would fail to match
 * their own "AC Repair" booking. Comparing compacted forms as well catches
 * that without loosening the spaced comparison.
 */
function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Does this booking match a spoken category like "photography"?
 *
 * Checks the resolved taxonomy names first, because those are canonical, then
 * falls back to the user's original wording — someone who typed "need a
 * photographer for my sister's wedding" and later says "my photography
 * booking" should match even if the taxonomy landed on "Event Photography".
 */
export function matchesCategory(booking: BookingCandidate, category: string): boolean {
  const needle = normalise(category)
  if (!needle) return false

  const stem = needle.replace(/(er|ers|ing|s)$/, '')

  const haystacks = [...booking.categories.map(normalise), normalise(booking.description)]

  if (haystacks.some((h) => h.includes(needle))) return true

  // The stem guard keeps short fragments from matching half the catalogue:
  // without it, "as" would stem to "a" and match everything.
  if (stem.length >= 4 && haystacks.some((h) => h.includes(stem))) return true

  const tight = compact(category)
  if (tight.length >= 2) {
    const compacted = [
      ...booking.categories.map(compact),
      compact(booking.description),
    ]
    if (compacted.some((h) => h.includes(tight))) return true
  }

  return false
}

/** Same calendar day in the server's timezone. */
export function isSameDay(iso: string, day: Date): boolean {
  const d = new Date(iso)
  return (
    d.getFullYear() === day.getFullYear() &&
    d.getMonth() === day.getMonth() &&
    d.getDate() === day.getDate()
  )
}

function isUpcoming(b: BookingCandidate, now: Date): boolean {
  return b.slotTime !== null && new Date(b.slotTime).getTime() >= now.getTime()
}

/** Soonest scheduled first; unscheduled last, newest of those first. */
function bySoonest(a: BookingCandidate, b: BookingCandidate): number {
  if (a.slotTime && b.slotTime) {
    return new Date(a.slotTime).getTime() - new Date(b.slotTime).getTime()
  }
  if (a.slotTime) return -1
  if (b.slotTime) return 1
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
}

// ─────────────────────────────────────────────────────────────────────────────
// The ladder
// ─────────────────────────────────────────────────────────────────────────────

export function resolveBooking(input: ResolutionInput): Resolution {
  const { intent, candidates, context, now } = input

  if (candidates.length === 0) {
    return { status: 'NOT_FOUND', reason: 'no_bookings' }
  }

  // ── 1. Explicit booking id ────────────────────────────────────────────────
  //
  // The id here came from an LLM reading the user's message, so it is a
  // *claim*, not a fact. It is only ever used to select from `candidates`,
  // which the caller already scoped to this user — an id belonging to someone
  // else matches nothing and falls through. It is never passed to a lookup.
  if (intent.bookingId) {
    const hit = candidates.find((c) => c.id === intent.bookingId)
    if (hit) return { status: 'RESOLVED', booking: hit, source: 'explicit_id' }
    // Named something specific that isn't theirs: say not found, and do NOT
    // silently resolve to a different booking.
    return { status: 'NOT_FOUND', reason: 'booking_not_found' }
  }

  // ── 2. Explicit provider reference ────────────────────────────────────────
  if (intent.providerId) {
    const hits = candidates.filter((c) => c.vendorId === intent.providerId)
    if (hits.length === 1) {
      return { status: 'RESOLVED', booking: hits[0], source: 'provider_reference' }
    }
    if (hits.length > 1) {
      return {
        status: 'AMBIGUOUS',
        candidates: [...hits].sort(bySoonest),
        reason: 'multiple_with_provider',
      }
    }
  }

  // ── 3. Category reference ("my photography booking") ──────────────────────
  if (intent.category) {
    const hits = candidates.filter((c) => matchesCategory(c, intent.category!))
    if (hits.length === 1) {
      return { status: 'RESOLVED', booking: hits[0], source: 'category_reference' }
    }
    if (hits.length > 1) {
      // Narrow further by date if the user gave one, before giving up.
      const byDate = intent.date
        ? hits.filter((c) => c.slotTime && isSameDay(c.slotTime, new Date(intent.date!)))
        : []
      if (byDate.length === 1) {
        return { status: 'RESOLVED', booking: byDate[0], source: 'category_reference' }
      }
      return {
        status: 'AMBIGUOUS',
        candidates: [...hits].sort(bySoonest),
        reason: 'multiple_in_category',
      }
    }
    // Named a category they have no booking in. Do not fall through to
    // "active booking" — answering about a cleaning job when they asked about
    // photography is worse than admitting we found nothing.
    return { status: 'NOT_FOUND', reason: 'no_booking_in_category' }
  }

  // ── 4. Date reference ("my Saturday booking") ─────────────────────────────
  if (intent.date) {
    const target = new Date(intent.date)
    if (!Number.isNaN(target.getTime())) {
      const hits = candidates.filter((c) => c.slotTime && isSameDay(c.slotTime, target))
      if (hits.length === 1) {
        return { status: 'RESOLVED', booking: hits[0], source: 'date_reference' }
      }
      if (hits.length > 1) {
        return {
          status: 'AMBIGUOUS',
          candidates: [...hits].sort(bySoonest),
          reason: 'multiple_on_date',
        }
      }
      return { status: 'NOT_FOUND', reason: 'no_booking_on_date' }
    }
  }

  // ── 5. Active booking from conversation context ───────────────────────────
  if (context.activeBookingId) {
    const hit = candidates.find((c) => c.id === context.activeBookingId)
    if (hit) return { status: 'RESOLVED', booking: hit, source: 'active_context' }
  }

  // ── 6. Last referenced booking ────────────────────────────────────────────
  if (context.lastReferencedBookingId) {
    const hit = candidates.find((c) => c.id === context.lastReferencedBookingId)
    if (hit) return { status: 'RESOLVED', booking: hit, source: 'last_referenced' }
  }

  // ── 7. Sole candidate ─────────────────────────────────────────────────────
  if (candidates.length === 1) {
    return { status: 'RESOLVED', booking: candidates[0], source: 'sole_candidate' }
  }

  // ── 8. Exactly one still ahead of them ────────────────────────────────────
  //
  // Deliberately NOT "the soonest of several". With three upcoming bookings,
  // "where is my booking?" genuinely does not name one, and guessing the
  // nearest is a guess wearing a heuristic's clothes.
  const upcoming = candidates.filter((c) => isUpcoming(c, now))
  if (upcoming.length === 1) {
    return { status: 'RESOLVED', booking: upcoming[0], source: 'sole_upcoming' }
  }

  // ── 9. Ask ────────────────────────────────────────────────────────────────
  const offer = (upcoming.length > 0 ? upcoming : candidates).sort(bySoonest)
  return {
    status: 'AMBIGUOUS',
    candidates: offer.slice(0, 5),
    reason: 'multiple_candidates',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence policy
// ─────────────────────────────────────────────────────────────────────────────

export type ConfidenceVerdict = 'execute' | 'clarify' | 'reject'

/**
 * Whether an intent is trustworthy enough to act on.
 *
 * A model's self-reported confidence is not evidence — it is a number the
 * model produced alongside the answer, from the same forward pass, and it is
 * cheerfully high when the model is wrong. So it is one input of several:
 *
 *  - a resolution that is AMBIGUOUS can never execute, at any confidence
 *  - a mutation demands more confidence than a read, because a wrong read
 *    shows the wrong card and a wrong mutation destroys a booking
 *  - a strong resolution source (the user literally named the booking)
 *    compensates for a middling score, because the entity is not in doubt
 */
export function judgeConfidence(params: {
  confidence: number
  isMutation: boolean
  resolution: Resolution
}): ConfidenceVerdict {
  const { confidence, isMutation, resolution } = params

  if (resolution.status !== 'RESOLVED') return 'clarify'

  // The user named it explicitly; the language model's job was easy.
  const strongSource =
    resolution.source === 'explicit_id' ||
    resolution.source === 'provider_reference' ||
    resolution.source === 'category_reference'

  const threshold = isMutation ? 0.85 : 0.6
  const relaxed = strongSource ? threshold - 0.15 : threshold

  if (confidence >= relaxed) return 'execute'
  if (confidence >= 0.4) return 'clarify'
  return 'reject'
}
