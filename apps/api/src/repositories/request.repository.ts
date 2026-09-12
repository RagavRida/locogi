/**
 * RequestRepository — the service request aggregate.
 *
 * Centralises the ownership check that was copied to 6 different routes, and
 * owns every status transition. Routes previously wrote `status = 'confirmed'`
 * inline in several places, which is how a state machine decays into a set of
 * unrelated UPDATE statements.
 *
 * Status transitions enforce their guard in the WHERE clause, so an invalid
 * transition is a no-op rather than a silent corruption. As of step 3 that
 * guard is DERIVED from `domain/request-state.ts` rather than hand-written
 * per call site — see `transition()` below. No method in this file should
 * contain a literal `AND status IN (...)` again.
 */

import {
  BaseRepository,
  type Executor,
  num,
  numOrNull,
} from './base'
import type { BookingType } from '@locogi/types'
import {
  type RequestStatus,
  legalPredecessors,
  cancellableStates,
} from '../domain/request-state'

interface RequestRow {
  id: string
  customer_id: string
  idempotency_key: string
  raw_description: string
  category_tags: string[] | null
  attributes: Record<string, unknown> | null
  booking_type: BookingType
  status: RequestStatus
  confirmed_vendor_id: string | null
  agreed_price: number | null
  rematching_attempt: number
  reschedule_count: number
  resource_slot_id: string | null
  organization_id: string | null
  lat: number | null
  lng: number | null
  h3_r7: string | null
  embedding: string | null
  created_at: string
  expires_at: string | null
}

export interface RequestRecord {
  id: string
  customerId: string
  rawDescription: string
  categoryTags: string[]
  attributes: Record<string, unknown>
  bookingType: BookingType
  status: RequestStatus
  confirmedVendorId: string | null
  agreedPrice: number | null
  rematchingAttempt: number
  rescheduleCount: number
  resourceSlotId: string | null
  organizationId: string | null
  lat: number | null
  lng: number | null
  h3r7: string | null
  hasEmbedding: boolean
  createdAt: string
  expiresAt: string | null
}

/** The signals MatchingService needs — deliberately narrower than the full row. */
export interface MatchingContext {
  id: string
  /** Raw pgvector literal, passed straight back into SQL. Never deserialised. */
  embedding: string | null
  lat: number | null
  lng: number | null
  categoryIds: string[]
}

const REQUEST_COLUMNS = `
  id, customer_id, idempotency_key, raw_description, category_tags, attributes,
  booking_type, status, confirmed_vendor_id, agreed_price,
  rematching_attempt, reschedule_count, resource_slot_id, organization_id,
  lat, lng, h3_r7, created_at, expires_at
`


// ─── Conversational booking retrieval ─────────────────────────────────────────

/**
 * States in which a booking is still something the user can ask about.
 *
 * Not derived from the state graph: `legalPredecessors` answers "what can
 * transition here", which is a different question from "is this live enough
 * to talk about". A cancelled booking is terminal but a user may still
 * reasonably ask "what happened to my booking?" — so terminal states are
 * reachable via includeTerminal, just not the default candidate set.
 */
const LIVE_BOOKING_STATES: RequestStatus[] = [
  'open',
  'negotiating',
  'waitlisted',
  'confirmed',
  'in_progress',
  'disrupted',
]

interface BookingCandidateRow {
  id: string
  raw_description: string
  status: RequestStatus
  booking_type: BookingType
  agreed_price: string | number | null
  created_at: string
  confirmed_vendor_id: string | null
  vendor_name: string | null
  vendor_rating: string | number | null
  slot_time: string | null
  categories: string[] | null
}

export interface BookingCandidate {
  id: string
  description: string
  status: RequestStatus
  bookingType: BookingType
  agreedPrice: number | null
  createdAt: string
  vendorId: string | null
  vendorName: string | null
  vendorRating: number | null
  /** When the job is scheduled. Null for quote-style bookings with no slot. */
  slotTime: string | null
  categories: string[]
}

function toBookingCandidate(r: BookingCandidateRow): BookingCandidate {
  return {
    id: r.id,
    description: r.raw_description,
    status: r.status,
    bookingType: r.booking_type,
    agreedPrice: numOrNull(r.agreed_price),
    createdAt: r.created_at,
    vendorId: r.confirmed_vendor_id,
    vendorName: r.vendor_name,
    vendorRating: numOrNull(r.vendor_rating),
    slotTime: r.slot_time,
    categories: r.categories ?? [],
  }
}

export class RequestRepository extends BaseRepository {

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async findById(
    requestId: string,
    executor?: Executor
  ): Promise<RequestRecord | null> {
    const row = await this.one<RequestRow>(
      'findById',
      `SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = $1`,
      [requestId],
      executor
    )
    return row ? toRequest(row) : null
  }

  /**
   * Ownership check — was copied inline to 6 routes.
   *
   * Returns a boolean rather than throwing, because the correct HTTP response
   * differs by caller (403 vs 404 vs a silent skip in a worker).
   */
  async isOwnedByCustomer(
    requestId: string,
    customerId: string,
    executor?: Executor
  ): Promise<boolean> {
    const row = await this.one<{ exists: boolean }>(
      'isOwnedByCustomer',
      'SELECT true AS exists FROM requests WHERE id = $1 AND customer_id = $2',
      [requestId, customerId],
      executor
    )
    return row !== null
  }

  /**
   * Which side of this booking is the caller on?
   * Used wherever an action is allowed for either party but behaves
   * differently depending on who initiated it (reschedule, no-show report).
   */
  async resolveParty(
    requestId: string,
    userId: string,
    executor?: Executor
  ): Promise<'customer' | 'vendor' | null> {
    const row = await this.one<{ is_customer: boolean; is_vendor: boolean }>(
      'resolveParty',
      `SELECT (r.customer_id = $2) AS is_customer,
              EXISTS (
                SELECT 1 FROM vendors v
                WHERE v.id = r.confirmed_vendor_id AND v.user_id = $2
              ) AS is_vendor
       FROM requests r WHERE r.id = $1`,
      [requestId, userId],
      executor
    )

    if (!row) return null
    if (row.is_customer) return 'customer'
    if (row.is_vendor) return 'vendor'
    return null
  }

  /** Everything MatchingService needs, in one query instead of three. */
  async getMatchingContext(
    requestId: string,
    executor?: Executor
  ): Promise<MatchingContext | null> {
    const row = await this.one<{
      id: string
      embedding: string | null
      lat: number | null
      lng: number | null
      category_ids: string[] | null
    }>(
      'getMatchingContext',
      `SELECT r.id, r.embedding, r.lat, r.lng,
              ARRAY_AGG(rc.category_id) FILTER (WHERE rc.category_id IS NOT NULL)
                AS category_ids
       FROM requests r
       LEFT JOIN request_categories rc ON rc.request_id = r.id
       WHERE r.id = $1
       GROUP BY r.id, r.embedding, r.lat, r.lng`,
      [requestId],
      executor
    )

    if (!row) return null
    return {
      id: row.id,
      embedding: row.embedding,
      lat: numOrNull(row.lat),
      lng: numOrNull(row.lng),
      categoryIds: row.category_ids ?? [],
    }
  }

  async listForCustomer(
    customerId: string,
    limit = 50,
    executor?: Executor
  ): Promise<
    Array<{
      id: string
      rawDescription: string
      status: RequestStatus
      createdAt: string
      vendorName: string | null
      rating: number | null
    }>
  > {
    const { rows } = await this.run<{
      id: string
      raw_description: string
      status: RequestStatus
      created_at: string
      vendor_name: string | null
      rating: number | null
    }>(
      'listForCustomer',
      `SELECT r.id, r.raw_description, r.status, r.created_at,
              u.name AS vendor_name, rev.rating
       FROM requests r
       LEFT JOIN vendors v ON v.id = r.confirmed_vendor_id
       LEFT JOIN users u ON u.id = v.user_id
       LEFT JOIN reviews rev ON rev.request_id = r.id
       WHERE r.customer_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [customerId, limit],
      executor
    )

    return rows.map((r) => ({
      id: r.id,
      rawDescription: r.raw_description,
      status: r.status,
      createdAt: r.created_at,
      vendorName: r.vendor_name,
      rating: numOrNull(r.rating),
    }))
  }

  // ─── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Idempotent create. A duplicate idempotency_key returns the existing row
   * rather than erroring, so a client retry after a dropped response does not
   * create a second request.
   */
  async create(
    params: {
      customerId: string
      idempotencyKey: string
      rawDescription: string
      categoryTags: string[]
      attributes: Record<string, unknown>
      bookingType: BookingType
      expiresInHours?: number
    },
    executor?: Executor
  ): Promise<{ id: string; status: RequestStatus; wasExisting: boolean }> {
    const row = await this.one<{ id: string; status: RequestStatus; inserted: boolean }>(
      'create',
      `INSERT INTO requests
         (customer_id, idempotency_key, raw_description, category_tags,
          attributes, booking_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' hours')::interval)
       ON CONFLICT (idempotency_key)
         DO UPDATE SET raw_description = requests.raw_description
       RETURNING id, status, (xmax = 0) AS inserted`,
      [
        params.customerId,
        params.idempotencyKey,
        params.rawDescription,
        params.categoryTags,
        JSON.stringify(params.attributes),
        params.bookingType,
        params.expiresInHours ?? 2,
      ],
      executor
    )

    if (!row) throw new Error('Request create returned no row')

    // xmax = 0 distinguishes a genuine INSERT from a conflict-triggered UPDATE
    return { id: row.id, status: row.status, wasExisting: !row.inserted }
  }

  async updateLocation(
    requestId: string,
    lat: number,
    lng: number,
    h3: { h3_r8: string; h3_r7: string; h3_r6: string },
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'updateLocation',
      `UPDATE requests
       SET lat = $1, lng = $2, h3_r8 = $3, h3_r7 = $4, h3_r6 = $5
       WHERE id = $6`,
      [lat, lng, h3.h3_r8, h3.h3_r7, h3.h3_r6, requestId],
      executor
    )
  }

  async updateEmbedding(
    requestId: string,
    vectorLiteral: string,
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'updateEmbedding',
      'UPDATE requests SET embedding = $1::vector WHERE id = $2',
      [vectorLiteral, requestId],
      executor
    )
  }

  /** Health-adjacent requests have symptom detail stripped before fan-out. */
  async sanitizeDescription(
    requestId: string,
    sanitizedText: string,
    sanitizedAttributes: Record<string, unknown>,
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'sanitizeDescription',
      'UPDATE requests SET raw_description = $1, attributes = $2 WHERE id = $3',
      [sanitizedText, JSON.stringify(sanitizedAttributes), requestId],
      executor
    )
  }

  // ─── Status transitions ─────────────────────────────────────────────────────
  //
  // Each transition names its legal predecessors in the WHERE clause, so an
  // illegal transition affects zero rows instead of corrupting state. Callers
  // check the boolean. Step 3 lifts these guards into a declarative state
  // machine — until then, this is the only place they live.


  // ═══════════════════════════════════════════════════════════════════════════
  // THE TRANSITION PRIMITIVE
  // ═══════════════════════════════════════════════════════════════════════════
  /**
   * Move a request to `to`, but only from a state the domain graph permits.
   *
   * The guard is not passed in and not written here — it is computed from
   * `legalPredecessors(to)`. That is the entire point: a caller cannot hold a
   * narrower or wider opinion about legality than the domain does, because it
   * never gets to express one.
   *
   * Atomicity is unchanged from the hand-written version. This is still ONE
   * conditional UPDATE, so concurrent callers serialise on the row lock and
   * `rowCount` names the winner. Returning false means "somebody else moved
   * this first, or it was never in a legal state" — the caller decides whether
   * that is a 409, a no-op, or a retry.
   *
   * `extraSet` / `extraWhere` exist for the columns and conditions that ride
   * along with specific transitions (agreed_price, resource_slot_id, an
   * ownership check). They deliberately cannot touch `status`.
   */
  protected async transition(
    label: string,
    params: {
      requestId: string
      to: RequestStatus
      /** Additional SET fragments, e.g. `confirmed_vendor_id = $2`. */
      extraSet?: string[]
      /** Additional WHERE fragments, e.g. `customer_id = $3`. */
      extraWhere?: string[]
      /** Bind values for the fragments above, starting at $2. */
      values?: unknown[]
    },
    executor?: Executor
  ): Promise<boolean> {
    const from = legalPredecessors(params.to)

    if (from.length === 0) {
      // A transition into an unreachable state is a programming error, not a
      // race. Failing loudly beats a silent no-op that looks like contention.
      throw new Error(
        `No legal predecessor for status '${params.to}' — ` +
          'the domain graph makes this transition impossible. ' +
          'Add the edge to TRANSITIONS or fix the caller.'
      )
    }

    const extra = params.values ?? []
    // $1 = requestId, $2..$n = caller fragments, $last = the predecessor array
    const guardIdx = extra.length + 2

    const setClauses = ['status = $' + (guardIdx + 1), ...(params.extraSet ?? [])]
    const whereClauses = [
      'id = $1',
      `status = ANY($${guardIdx}::text[])`,
      ...(params.extraWhere ?? []),
    ]

    return this.didWrite(
      label,
      `UPDATE requests
          SET ${setClauses.join(', ')}
        WHERE ${whereClauses.join('\n          AND ')}`,
      [params.requestId, ...extra, from, params.to],
      executor
    )
  }

  /**
   * THE RACE-LOCK. Highest-risk statement in the system.
   *
   * Exactly one caller can win. rowCount 0 means another vendor was confirmed
   * in the microseconds since this caller read the request.
   */
  async confirmWithVendor(
    params: {
      requestId: string
      vendorId: string
      agreedPrice: number
      idempotencyKey: string
    },
    executor?: Executor
  ): Promise<boolean> {
    return this.transition(
      'confirmWithVendor',
      {
        requestId: params.requestId,
        to: 'confirmed',
        extraSet: [
          'confirmed_vendor_id = $2',
          'agreed_price = $3',
          'idempotency_key = $4',
        ],
        values: [
          params.vendorId,
          params.agreedPrice,
          `confirm_${params.idempotencyKey}`,
        ],
      },
      executor
    )
  }

  /** Has this idempotency key already produced a confirmation? */
  async wasAlreadyConfirmed(
    idempotencyKey: string,
    executor?: Executor
  ): Promise<boolean> {
    const row = await this.one(
      'wasAlreadyConfirmed',
      `SELECT 1 FROM requests
       WHERE idempotency_key = $1 AND status = 'confirmed'`,
      [`confirm_${idempotencyKey}`],
      executor
    )
    return row !== null
  }

  /** Confirm against a booked slot, linking the FK downstream jobs depend on. */
  async confirmWithSlot(
    requestId: string,
    slotId: string,
    executor?: Executor
  ): Promise<boolean> {
    return this.transition(
      'confirmWithSlot',
      {
        requestId,
        to: 'confirmed',
        extraSet: ['resource_slot_id = $2'],
        values: [slotId],
      },
      executor
    )
  }

  async markNegotiating(
    requestId: string,
    executor?: Executor
  ): Promise<boolean> {
    return this.transition(
      'markNegotiating',
      { requestId, to: 'negotiating' },
      executor
    )
  }

  /**
   * Advance a job through the working stages.
   *
   * This method used to carry its own predecessor map, in which `completed`
   * was reachable only from `in_progress`. Meanwhile the confirm-attended
   * route allowed `('confirmed','in_progress') -> completed`. Short jobs that
   * never pass through in_progress are real — a haircut, a delivery — so the
   * route was right and this map was quietly rejecting valid completions.
   * Deriving from the graph settled the disagreement in one place.
   */
  async advanceStage(
    requestId: string,
    stage: 'in_progress' | 'completed',
    executor?: Executor
  ): Promise<boolean> {
    return this.transition('advanceStage', { requestId, to: stage }, executor)
  }

  async markNoMatch(requestId: string, executor?: Executor): Promise<boolean> {
    return this.transition('markNoMatch', { requestId, to: 'no_match' }, executor)
  }

  /** Time-limited self-service cancellation. */
  async cancelWithinWindow(
    requestId: string,
    customerId: string,
    windowMinutes = 5,
    executor?: Executor
  ): Promise<boolean> {
    return this.transition(
      'cancelWithinWindow',
      {
        requestId,
        to: 'cancelled',
        extraWhere: [
          'customer_id = $2',
          "created_at > now() - ($3 || ' minutes')::interval",
        ],
        values: [customerId, windowMinutes],
      },
      executor
    )
  }

  // ─── Category linkage ───────────────────────────────────────────────────────

  async linkCategories(
    requestId: string,
    categories: Array<{ categoryId: string; confidence: number; sourceTag: string }>,
    executor?: Executor
  ): Promise<void> {
    for (const c of categories) {
      await this.run(
        'linkCategories',
        `INSERT INTO request_categories
           (request_id, category_id, confidence, source_tag)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [requestId, c.categoryId, c.confidence, c.sourceTag],
        executor
      )
    }
  }

  /** Do any of this request's categories require the health-data guard? */
  async isHealthAdjacent(
    requestId: string,
    executor?: Executor
  ): Promise<boolean> {
    const row = await this.one<{ is_health_adjacent: boolean | null }>(
      'isHealthAdjacent',
      `SELECT bool_or(sc.is_health_adjacent) AS is_health_adjacent
       FROM request_categories rc
       JOIN service_categories sc ON sc.id = rc.category_id
       WHERE rc.request_id = $1`,
      [requestId],
      executor
    )
    return row?.is_health_adjacent === true
  }

  /**
   * Ownership + completion + vendor, in one read.
   *
   * The review flow needs all three facts and must not be able to write a
   * review for someone else's request, an unfinished job, or a job with no
   * vendor. Fetching them together means the caller cannot check two and
   * forget the third.
   */
  async findForReview(
    requestId: string,
    customerId: string,
    executor?: Executor
  ): Promise<{ status: string; confirmedVendorId: string | null } | null> {
    const row = await this.one<{ status: string; confirmed_vendor_id: string | null }>(
      'request.findForReview',
      'SELECT status, confirmed_vendor_id FROM requests WHERE id = $1 AND customer_id = $2',
      [requestId, customerId],
      executor
    )
    if (!row) return null
    return { status: row.status, confirmedVendorId: row.confirmed_vendor_id }
  }


  // ─── Transitions previously written inline in services and workers ──────────

  /**
   * Cancel everything still active for a customer (account deletion, GDPR).
   *
   * The old inline version guarded on
   * `('open','negotiating','confirmed','in_progress')` while the per-request
   * cancel guarded on `('open','negotiating','confirmed')`. Both now derive
   * from `cancellableStates()`, so deleting an account cancels exactly the
   * requests a customer could have cancelled by hand — no more, no less.
   */
  async cancelAllActiveForCustomer(
    customerId: string,
    executor?: Executor
  ): Promise<Array<{ id: string; confirmedVendorId: string | null }>> {
    const from = cancellableStates()
    const result = await this.run<{ id: string; confirmed_vendor_id: string | null }>(
      'cancelAllActiveForCustomer',
      `UPDATE requests SET status = 'cancelled'
        WHERE customer_id = $1 AND status = ANY($2::text[])
      RETURNING id, confirmed_vendor_id`,
      [customerId, from],
      executor
    )
    return result.rows.map((r) => ({
      id: r.id,
      confirmedVendorId: r.confirmed_vendor_id,
    }))
  }

  /** Queue behind a full calendar. */
  async markWaitlisted(requestId: string, executor?: Executor): Promise<boolean> {
    return this.transition('markWaitlisted', { requestId, to: 'waitlisted' }, executor)
  }

  /**
   * Claim an offered slot from the waitlist.
   *
   * Previously an unguarded `SET status = 'confirmed'`, which would happily
   * resurrect a request the customer had already cancelled while queued.
   */
  async confirmFromWaitlist(
    requestId: string,
    slotId: string,
    executor?: Executor
  ): Promise<boolean> {
    return this.transition(
      'confirmFromWaitlist',
      {
        requestId,
        to: 'confirmed',
        extraSet: ['resource_slot_id = $2'],
        values: [slotId],
      },
      executor
    )
  }

  /**
   * Move a live booking to a different slot.
   *
   * Deliberately NOT routed through `transition()`, because rescheduling is
   * not a state change: the booking is `confirmed` before and `confirmed`
   * after — only the slot moves. Forcing it through the primitive would have
   * meant asking for a `confirmed -> confirmed` edge, and a state is not its
   * own predecessor, so the update would have matched zero rows every time
   * while looking perfectly correct.
   *
   * The guard is still derived, not hand-written. `legalPredecessors of
   * 'rescheduled'` is the graph's answer to "which states may be rescheduled
   * at all", and that is exactly the guard this needs. Add a state that can
   * be rescheduled and this widens with it.
   *
   * (`status = 'rescheduled'` itself is for the *superseded* row in the
   * split-request flow — a different operation, handled by `supersede()`.)
   */
  async rescheduleToSlot(
    requestId: string,
    newSlotId: string,
    executor?: Executor
  ): Promise<boolean> {
    const reschedulable = legalPredecessors('rescheduled')
    return this.didWrite(
      'rescheduleToSlot',
      `UPDATE requests
          SET resource_slot_id = $2,
              reschedule_count = reschedule_count + 1
        WHERE id = $1
          AND status = ANY($3::text[])`,
      [requestId, newSlotId, reschedulable],
      executor
    )
  }

  /**
   * Retire a request because a successor row now carries the booking.
   *
   * The terminal counterpart to `rescheduleToSlot`, used by the flow that
   * splits a move into two rows instead of mutating one.
   */
  async supersede(requestId: string, executor?: Executor): Promise<boolean> {
    return this.transition('supersede', { requestId, to: 'rescheduled' }, executor)
  }

  /** Record a no-show. Previously unguarded — could fire on a completed job. */
  async markNoShow(
    requestId: string,
    party: 'customer' | 'vendor',
    executor?: Executor
  ): Promise<boolean> {
    return this.transition(
      'markNoShow',
      {
        requestId,
        to: party === 'customer' ? 'no_show_customer' : 'no_show_vendor',
      },
      executor
    )
  }

  /** Confirm a rental booking against its request. Previously unguarded. */
  async confirmRental(requestId: string, executor?: Executor): Promise<boolean> {
    return this.transition('confirmRental', { requestId, to: 'confirmed' }, executor)
  }

  /** Vendor pulled out of committed bookings on these slots. */
  async markDisruptedBySlots(
    slotIds: string[],
    executor?: Executor
  ): Promise<Array<{ id: string; customerId: string; slotTime: string }>> {
    if (slotIds.length === 0) return []
    const from = legalPredecessors('disrupted')
    const result = await this.run<{
      id: string
      customer_id: string
      slot_time: string
    }>(
      'markDisruptedBySlots',
      `UPDATE requests
          SET status = 'disrupted'
        WHERE resource_slot_id = ANY($1::uuid[])
          AND status = ANY($2::text[])
      RETURNING id, customer_id,
                (SELECT slot_time FROM resource_slots WHERE id = resource_slot_id)
                  AS slot_time`,
      [slotIds, from],
      executor
    )
    return result.rows.map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      slotTime: r.slot_time,
    }))
  }

  /**
   * Expire requests that timed out AND have exhausted rematching.
   *
   * The `rematching_attempt` floor matters: without it this would expire
   * requests the expiry worker is still actively widening the radius for.
   * Returns customer ids too, because the caller notifies them.
   */
  async expireExhausted(
    minRematchingAttempts: number,
    executor?: Executor
  ): Promise<Array<{ id: string; customerId: string }>> {
    const from = legalPredecessors('expired')
    const result = await this.run<{ id: string; customer_id: string }>(
      'expireExhausted',
      `UPDATE requests SET status = 'expired'
        WHERE status = ANY($1::text[])
          AND expires_at < now()
          AND rematching_attempt >= $2
      RETURNING id, customer_id`,
      [from, minRematchingAttempts],
      executor
    )
    return result.rows.map((r) => ({ id: r.id, customerId: r.customer_id }))
  }

  /** Expire one waitlist entry whose date has passed. */
  async expireRequest(requestId: string, executor?: Executor): Promise<boolean> {
    return this.transition('expireRequest', { requestId, to: 'expired' }, executor)
  }

  /**
   * Auto-complete bookings whose slot is long past and which nobody closed out.
   *
   * A safety net, not the happy path — the happy path is an explicit
   * confirm-attended. Returns the count so the worker can log something real.
   */
  async autoCompletePastSlots(
    olderThanHours: number,
    executor?: Executor
  ): Promise<string[]> {
    const from = legalPredecessors('completed')
    const result = await this.run<{ id: string }>(
      'autoCompletePastSlots',
      `UPDATE requests r
          SET status = 'completed'
        WHERE r.status = ANY($1::text[])
          AND r.resource_slot_id IN (
            SELECT id FROM resource_slots
             WHERE slot_time < now() - ($2 || ' hours')::interval
          )
      RETURNING r.id`,
      [from, olderThanHours],
      executor
    )
    return result.rows.map((r) => r.id)
  }

  /**
   * Complete a booking on the caller's authority (customer or assigned vendor).
   *
   * The ownership predicate stays in SQL so the check and the write remain one
   * atomic statement — splitting them would open a window where authorisation
   * passes and the write lands on a request that changed underneath.
   */
  async completeAsParty(
    requestId: string,
    userId: string,
    executor?: Executor
  ): Promise<boolean> {
    return this.transition(
      'completeAsParty',
      {
        requestId,
        to: 'completed',
        extraWhere: [
          `(customer_id = $2 OR confirmed_vendor_id IN (
              SELECT id FROM vendors WHERE user_id = $2
            ))`,
        ],
        values: [userId],
      },
      executor
    )
  }

  /**
   * Cancel one occurrence of a recurring series, on the customer's authority.
   *
   * Returns the series id so the caller can decide whether to offer "cancel
   * the rest too", or null when nothing was cancelled.
   */
  async cancelRecurringOccurrence(
    requestId: string,
    customerId: string,
    executor?: Executor
  ): Promise<{ cancelled: boolean; recurringBookingId: string | null }> {
    const from = cancellableStates()
    const result = await this.run<{ recurring_booking_id: string | null }>(
      'cancelRecurringOccurrence',
      `UPDATE requests SET status = 'cancelled'
        WHERE id = $1
          AND customer_id = $2
          AND status = ANY($3::text[])
          AND recurring_booking_id IS NOT NULL
      RETURNING recurring_booking_id`,
      [requestId, customerId, from],
      executor
    )
    const row = result.rows[0]
    return {
      cancelled: result.rowCount > 0,
      recurringBookingId: row?.recurring_booking_id ?? null,
    }
  }

  /**
   * Cancel occurrences of a recurring series.
   *
   * Two call sites did this with different guards: pausing a series skipped
   * only `confirmed` occurrences, while cancelling it killed `confirmed` and
   * `open`. Same act, two answers. Both now derive from `cancellableStates()`.
   *
   * `window` scopes it to a date range (pause); omitting it means every future
   * occurrence (cancel).
   */
  async cancelRecurringOccurrences(
    recurringBookingId: string,
    window?: { from: string; until: string },
    executor?: Executor
  ): Promise<number> {
    const states = cancellableStates()

    const sql = window
      ? `UPDATE requests SET status = 'cancelled'
          WHERE recurring_booking_id = $1
            AND status = ANY($2::text[])
            AND expires_at::date BETWEEN $3::date AND $4::date`
      : `UPDATE requests SET status = 'cancelled'
          WHERE recurring_booking_id = $1
            AND status = ANY($2::text[])
            AND expires_at > now()`

    const values = window
      ? [recurringBookingId, states, window.from, window.until]
      : [recurringBookingId, states]

    const result = await this.run('cancelRecurringOccurrences', sql, values, executor)
    return result.rowCount ?? 0
  }


  // ─── Conversational booking retrieval ───────────────────────────────────────

  /**
   * The candidate set the conversational resolver reasons over.
   *
   * Returns enough for the resolver to rank and for a card to render a
   * summary, in ONE query — the resolver runs on the chat hot path and must
   * not fan out per candidate.
   *
   * Scoped to the caller's own rows in the WHERE clause, so authorization is
   * not a separate step a future caller could forget. There is no variant of
   * this method that reads another user's bookings.
   */
  async listBookingsForResolution(
    customerId: string,
    opts: { includeTerminal?: boolean; limit?: number } = {},
    executor?: Executor
  ): Promise<BookingCandidate[]> {
    const { rows } = await this.run<BookingCandidateRow>(
      'listBookingsForResolution',
      `SELECT r.id,
              r.raw_description,
              r.status,
              r.booking_type,
              r.agreed_price,
              r.created_at,
              r.confirmed_vendor_id,
              u.name          AS vendor_name,
              v.rating        AS vendor_rating,
              rs.slot_time    AS slot_time,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT sc.canonical_name), NULL) AS categories
         FROM requests r
         LEFT JOIN vendors v            ON v.id = r.confirmed_vendor_id
         LEFT JOIN users u              ON u.id = v.user_id
         LEFT JOIN resource_slots rs    ON rs.id = r.resource_slot_id
         LEFT JOIN request_categories rc ON rc.request_id = r.id
         LEFT JOIN service_categories sc ON sc.id = rc.category_id
        WHERE r.customer_id = $1
          AND ($2::boolean OR r.status = ANY($3::text[]))
        GROUP BY r.id, u.name, v.rating, rs.slot_time
        ORDER BY
          -- Soonest scheduled first; unscheduled fall back to newest.
          rs.slot_time ASC NULLS LAST,
          r.created_at DESC
        LIMIT $4`,
      [
        customerId,
        opts.includeTerminal ?? false,
        LIVE_BOOKING_STATES,
        opts.limit ?? 20,
      ],
      executor
    )

    return rows.map(toBookingCandidate)
  }

  /**
   * One booking, by id, for this customer.
   *
   * The customer_id predicate is IN the query rather than checked afterwards.
   * A caller cannot fetch first and forget to compare — the row simply does
   * not come back. Guessing another user's id returns null, indistinguishable
   * from a booking that does not exist, which is what it should look like.
   */
  async findBookingForCustomer(
    bookingId: string,
    customerId: string,
    executor?: Executor
  ): Promise<BookingCandidate | null> {
    const row = await this.one<BookingCandidateRow>(
      'findBookingForCustomer',
      `SELECT r.id, r.raw_description, r.status, r.booking_type, r.agreed_price,
              r.created_at, r.confirmed_vendor_id,
              u.name AS vendor_name, v.rating AS vendor_rating,
              rs.slot_time AS slot_time,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT sc.canonical_name), NULL) AS categories
         FROM requests r
         LEFT JOIN vendors v             ON v.id = r.confirmed_vendor_id
         LEFT JOIN users u               ON u.id = v.user_id
         LEFT JOIN resource_slots rs     ON rs.id = r.resource_slot_id
         LEFT JOIN request_categories rc ON rc.request_id = r.id
         LEFT JOIN service_categories sc ON sc.id = rc.category_id
        WHERE r.id = $1 AND r.customer_id = $2
        GROUP BY r.id, u.name, v.rating, rs.slot_time`,
      [bookingId, customerId],
      executor
    )
    return row ? toBookingCandidate(row) : null
  }



  /**
   * The confirmed vendor's last shared position for this booking.
   *
   * Returns null when the vendor is not sharing, which the caller must render
   * honestly rather than as "on the way". Stale positions are also null: a
   * fix from forty minutes ago is not a location, and showing it would have
   * the customer watching a marker that will never move.
   */
  async findLiveLocation(
    requestId: string,
    maxAgeMinutes = 10,
    executor?: Executor
  ): Promise<{ lat: number; lng: number; updatedAt: string } | null> {
    const row = await this.one<{ lat: number; lng: number; updated_at: string }>(
      'findLiveLocation',
      `SELECT ll.lat, ll.lng, ll.updated_at
         FROM live_locations ll
         JOIN requests r  ON r.id = $1
         JOIN vendors v   ON v.id = r.confirmed_vendor_id
        WHERE ll.user_id = v.user_id
          AND ll.request_id = r.id
          AND ll.updated_at > now() - ($2 || ' minutes')::interval`,
      [requestId, maxAgeMinutes],
      executor
    )
    if (!row) return null
    return { lat: num(row.lat), lng: num(row.lng), updatedAt: row.updated_at }
  }

}

// ─── Mapper ───────────────────────────────────────────────────────────────────
function toRequest(r: RequestRow): RequestRecord {
  return {
    id: r.id,
    customerId: r.customer_id,
    rawDescription: r.raw_description,
    categoryTags: r.category_tags ?? [],
    attributes: r.attributes ?? {},
    bookingType: r.booking_type,
    status: r.status,
    confirmedVendorId: r.confirmed_vendor_id,
    agreedPrice: numOrNull(r.agreed_price),
    rematchingAttempt: r.rematching_attempt ?? 0,
    rescheduleCount: r.reschedule_count ?? 0,
    resourceSlotId: r.resource_slot_id,
    organizationId: r.organization_id,
    lat: numOrNull(r.lat),
    lng: numOrNull(r.lng),
    h3r7: r.h3_r7,
    hasEmbedding: r.embedding !== null && r.embedding !== undefined,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }

}
