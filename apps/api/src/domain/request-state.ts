/**
 * The request lifecycle, as one explicit graph.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before this, the legal predecessors of a transition were hand-written into
 * each call site's WHERE clause:
 *
 *     UPDATE requests SET status = 'cancelled'
 *      WHERE id = $1 AND status IN ('open','negotiating','confirmed')
 *
 * and, two files away, for the same conceptual act:
 *
 *     UPDATE requests SET status = 'cancelled'
 *      WHERE customer_id = $1
 *        AND status IN ('open','negotiating','confirmed','in_progress')
 *
 * Those two lists disagree. One of them is wrong, and nothing in the codebase
 * could tell you which. That is the failure mode this file removes: the guard
 * is now DERIVED from the graph (see `legalPredecessors`), so a call site
 * cannot hold an opinion about legality that differs from the domain's.
 *
 * The audit that produced this graph also found five transitions written with
 * NO guard at all — no-show reporting, waitlist join, waitlist claim, rental
 * booking, and reschedule. Each could move a completed or cancelled request
 * back into an active state. They are listed in KNOWN_BUGS.md.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It is not a generic state-machine framework, and it does not cover the other
 * eleven tables in this schema that happen to have a `status` column
 * (request_responses, waitlist_entries, recurring_bookings, resource_bookings,
 * agent_knowledge, learned_questions, safety_patterns, vendor_commitments, …).
 *
 * Those are different lifecycles with different rules and different owners.
 * Forcing them through one abstraction would mean a union of thirty-odd states
 * where most transitions are illegal for most entities — a type that permits
 * nonsense is worse than no type. `requests` gets this treatment because it is
 * the aggregate root that money and trust hang off, and because it is the one
 * whose guards had already drifted.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ENFORCEMENT IS STILL THE DATABASE'S JOB
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module decides what is *legal*. It does not make transitions atomic.
 * Atomicity comes from the single-statement conditional UPDATE, exactly as it
 * did before — `RequestRepository.transition()` builds that statement using
 * the predecessors declared here. Two concurrent callers still race on the row
 * lock and exactly one still wins. Nothing about the concurrency story changed;
 * only the source of the WHERE clause did.
 */

// ─────────────────────────────────────────────────────────────────────────────
// States
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The state SET is shared with the mobile client, so it lives in
 * `@locogi/types`. Only the transition GRAPH below is server-side.
 *
 * If you add a state there you MUST also add it to the
 * `requests_status_check` constraint (migration 006) and give it an entry in
 * TRANSITIONS below — the compiler enforces the latter, and the test suite
 * asserts the former.
 */
export { REQUEST_STATUSES } from '@locogi/types'
export type { RequestStatus } from '@locogi/types'

import { REQUEST_STATUSES as STATUSES } from '@locogi/types'
import type { RequestStatus } from '@locogi/types'

// ─────────────────────────────────────────────────────────────────────────────
// The graph
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `TRANSITIONS[from]` is every state reachable from `from` in one step.
 *
 * An empty array means terminal. Terminal is a strong claim, so each one is
 * justified below rather than assumed.
 */
export const TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  // ── Pre-match ────────────────────────────────────────────────────────────
  /** Just created, fanned out to vendors, nobody has responded yet. */
  open: [
    'negotiating', // a vendor quoted
    'confirmed', // customer accepted a quote, or booked a slot directly
    'waitlisted', // nothing free; queued for a cancellation
    'no_match', // fan-out found nobody
    'expired', // nobody responded before expires_at
    'cancelled', // customer changed their mind
  ],

  /** At least one quote is in; the bargaining is live. */
  negotiating: [
    'confirmed',
    'waitlisted',
    'expired',
    'cancelled',
    // Deliberately NOT no_match: by definition a vendor already engaged.
  ],

  /** Queued behind a full calendar, waiting for a slot to free up. */
  waitlisted: [
    'confirmed', // claimed an offered slot
    'disrupted', // the resource they were queued for went away
    'expired', // the offer window closed, or the date passed
    'cancelled',
  ],

  // ── Committed ────────────────────────────────────────────────────────────
  /** A vendor and a price (and often a slot) are locked in. */
  confirmed: [
    'in_progress', // work started
    'completed', // short jobs skip in_progress
    'rescheduled', // moved to a different slot
    'no_show_customer',
    'no_show_vendor',
    'disrupted', // vendor pulled out; awaiting customer decision
    'cancelled',
  ],

  /** Work is underway. */
  in_progress: [
    'completed',
    'cancelled', // abandoned mid-job; rare, but it happens
    // NOT no_show_*: somebody clearly turned up.
  ],

  /** Vendor cancelled on a committed booking; the customer must decide. */
  disrupted: [
    'confirmed', // rebooked with someone else
    'waitlisted', // chose to queue instead
    'expired', // never decided
    'cancelled', // gave up
  ],

  // ── Terminal ─────────────────────────────────────────────────────────────
  /**
   * Terminal because a *successor request* carries the new slot. The old row
   * is kept as history, so reviving it would mean two live rows for one job.
   */
  rescheduled: [],

  /** Money and trust are settled. Reviews attach here. Nothing reopens it. */
  completed: [],

  /** Explicitly abandoned. A new intent means a new request. */
  cancelled: [],

  /** Timed out. Rematching creates a new request rather than reviving this. */
  expired: [],

  /** Fan-out found nobody. Recorded as unmet demand; not revived in place. */
  no_match: [],

  /**
   * No-shows are terminal by design. Disputes live in the `no_shows` table and
   * adjust reliability scores; they do not move the request back to confirmed,
   * because the appointment itself is over either way.
   */
  no_show_customer: [],
  no_show_vendor: [],
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries over the graph
// ─────────────────────────────────────────────────────────────────────────────

export function isTerminal(status: RequestStatus): boolean {
  return TRANSITIONS[status].length === 0
}

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * Every state from which `to` is reachable in one step.
 *
 * This is the inverse of the graph, and it is the whole point of the module:
 * repository guards are built from THIS rather than from a list somebody typed
 * into a WHERE clause. Add an edge to TRANSITIONS and every guard that should
 * widen, widens — in one place, with no call site to remember.
 */
export function legalPredecessors(to: RequestStatus): RequestStatus[] {
  return STATUSES.filter((from) => TRANSITIONS[from].includes(to))
}

/**
 * States a customer may still walk away from.
 *
 * Derived, not hand-listed — this is precisely the list the two cancel sites
 * disagreed about.
 */
export function cancellableStates(): RequestStatus[] {
  return legalPredecessors('cancelled')
}

/** True while the request is still doing something. */
export function isActive(status: RequestStatus): boolean {
  return !isTerminal(status)
}

export function isRequestStatus(value: unknown): value is RequestStatus {
  return (
    typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
  )
}

/**
 * Explains a refused transition in words a log reader can act on.
 *
 * Deliberately returns a message rather than throwing: most callers of a
 * conditional UPDATE want to report "that booking has already moved on" to a
 * user, not crash. Throwing is the caller's choice.
 */
export function explainRefusal(from: RequestStatus, to: RequestStatus): string {
  if (canTransition(from, to)) return ''
  if (isTerminal(from)) {
    return `Cannot move a ${from} request to ${to} — ${from} is a final state.`
  }
  return (
    `Cannot move a request from ${from} to ${to}. ` +
    `From ${from} the legal next states are: ${TRANSITIONS[from].join(', ')}.`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Named state sets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * States in which a vendor may still submit or revise a quote.
 *
 * Not derivable from the graph: `waitlisted` and `disrupted` can also reach
 * `confirmed`, but they are not open for bidding — they are waiting on a slot
 * or on a customer decision. So this is a genuine domain statement rather than
 * an inference, and it is written down once instead of in the three query
 * filters that each had their own copy.
 */
export const QUOTABLE_STATES: readonly RequestStatus[] = ['open', 'negotiating']

export function isQuotable(status: RequestStatus): boolean {
  return QUOTABLE_STATES.includes(status)
}
