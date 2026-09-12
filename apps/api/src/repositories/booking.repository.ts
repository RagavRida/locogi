/**
 * BookingRepository — slots, quotes and vendor commitments.
 *
 * THE STRUCTURAL POINT
 * ────────────────────
 * This repository is the reason step 1's bug cannot recur. There is now
 * exactly one place in the codebase that knows how a slot is persisted. A
 * future developer wiring up a new feature calls `claimSlot()`; they cannot
 * accidentally target a different table, because no other code path to a slot
 * exists.
 *
 * That is the whole argument for this layer. Not tidiness — the split-brain
 * was possible precisely because two code paths owned the same concept.
 *
 * TRANSACTION DISCIPLINE
 * ──────────────────────
 * Every atomic operation here takes an Executor. Callers running inside
 * withTransaction() MUST pass the transaction client, or the write lands on a
 * different connection and the atomicity guarantee is lost silently. The
 * methods that must never be called without one are marked.
 */

import { BaseRepository, type Executor, num, numOrNull } from './base'
import type { ResourceSlot } from '@locogi/types'

interface SlotRow {
  id: string
  resource_id: string
  slot_time: string
  duration_minutes: number
  capacity_total: number
  capacity_booked: number
  price_override: number | null
  is_cancelled: boolean
  cancelled_at: string | null
  cancel_reason: string | null
}

export interface QuoteRecord {
  responseId: string
  vendorId: string
  vendorName: string
  vendorRating: number
  vendorJobs: number
  quotedPrice: number
  message: string | null
}

export interface CommitmentRecord {
  id: string
  serviceFrom: string
  serviceUntil: string
  lat: number | null
  lng: number | null
  areaLabel: string | null
}

const SLOT_COLUMNS = `
  id, resource_id, slot_time, duration_minutes,
  capacity_total, capacity_booked, price_override,
  is_cancelled, cancelled_at, cancel_reason
`

export class BookingRepository extends BaseRepository {

  // ═══════════════════════════════════════════════════════════════════════════
  // SLOTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ATOMIC slot claim. The WHERE clause IS the validation — a separate
   * SELECT-then-UPDATE would leave a window where the slot fills between the
   * two statements.
   *
   * Returns null when the slot is full, cancelled, past, or absent.
   * Deliberately does not distinguish: the caller's response is identical, and
   * probing which reason applied would leak another customer's booking state.
   *
   * ⚠️ Call inside a transaction and pass the executor — the caller normally
   * also links the request, and both writes must commit together.
   */
  async claimSlot(
    slotId: string,
    executor?: Executor
  ): Promise<ResourceSlot | null> {
    const row = await this.one<SlotRow>(
      'claimSlot',
      `UPDATE resource_slots
       SET capacity_booked = capacity_booked + 1
       WHERE id = $1
         AND capacity_booked < capacity_total
         AND is_cancelled = false
         AND slot_time > now()
       RETURNING ${SLOT_COLUMNS}`,
      [slotId],
      executor
    )
    return row ? toSlot(row) : null
  }

  /** Give a slot back — cancellation, reschedule, no-show. */
  async releaseSlot(slotId: string, executor?: Executor): Promise<boolean> {
    return this.didWrite(
      'releaseSlot',
      `UPDATE resource_slots
       SET capacity_booked = GREATEST(0, capacity_booked - 1)
       WHERE id = $1`,
      [slotId],
      executor
    )
  }

  async findSlotById(
    slotId: string,
    executor?: Executor
  ): Promise<ResourceSlot | null> {
    const row = await this.one<SlotRow>(
      'findSlotById',
      `SELECT ${SLOT_COLUMNS} FROM resource_slots WHERE id = $1`,
      [slotId],
      executor
    )
    return row ? toSlot(row) : null
  }

  /** Bookable slots for a resource on a date. Past and cancelled excluded. */
  async listAvailableSlots(
    resourceId: string,
    date: string,
    executor?: Executor
  ): Promise<ResourceSlot[]> {
    const { rows } = await this.run<SlotRow>(
      'listAvailableSlots',
      `SELECT ${SLOT_COLUMNS}
       FROM resource_slots
       WHERE resource_id = $1
         AND slot_time::date = $2::date
         AND is_cancelled = false
         AND slot_time > now()
       ORDER BY slot_time ASC`,
      [resourceId, date],
      executor
    )
    return rows.map(toSlot)
  }

  /**
   * Slots across every resource a vendor owns.
   * A solo vendor has one resource; a restaurant has many tables. The caller
   * gets resource identity back so it can group by table or doctor.
   */
  async listSlotsForVendor(
    vendorId: string,
    date: string,
    executor?: Executor
  ): Promise<Array<ResourceSlot & { resourceName: string }>> {
    const { rows } = await this.run<SlotRow & { resource_name: string }>(
      'listSlotsForVendor',
      `SELECT rs.id, rs.resource_id, rs.slot_time, rs.duration_minutes,
              rs.capacity_total, rs.capacity_booked, rs.price_override,
              rs.is_cancelled, rs.cancelled_at, rs.cancel_reason,
              br.name AS resource_name
       FROM resource_slots rs
       JOIN bookable_resources br ON br.id = rs.resource_id
       JOIN organizations o ON o.id = br.organization_id
       WHERE o.vendor_id = $1
         AND rs.slot_time::date = $2::date
         AND rs.is_cancelled = false
         AND br.is_active = true
         AND rs.slot_time > now()
       ORDER BY rs.slot_time ASC, br.display_order`,
      [vendorId, date],
      executor
    )
    return rows.map((r) => ({ ...toSlot(r), resourceName: r.resource_name }))
  }

  /** Idempotent slot creation — resubmitting a calendar is safe. */
  async createSlot(
    params: {
      resourceId: string
      slotTime: string
      durationMinutes?: number
      capacityTotal?: number
    },
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'createSlot',
      `INSERT INTO resource_slots
         (resource_id, slot_time, duration_minutes, capacity_total)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (resource_id, slot_time) DO NOTHING`,
      [
        params.resourceId,
        params.slotTime,
        params.durationMinutes ?? 30,
        params.capacityTotal ?? 1,
      ],
      executor
    )
  }

  /** Vendor disruption — returns cancelled slot ids so bookings can cascade. */
  async cancelSlotsInWindow(
    params: {
      organizationId: string
      resourceId?: string
      from: string
      until: string
      reason: string
    },
    executor?: Executor
  ): Promise<string[]> {
    const { rows } = await this.run<{ id: string }>(
      'cancelSlotsInWindow',
      `UPDATE resource_slots rs
       SET is_cancelled = true, cancelled_at = now(), cancel_reason = $1
       WHERE rs.slot_time BETWEEN $2 AND $3
         AND rs.is_cancelled = false
         AND rs.resource_id IN (
           SELECT id FROM bookable_resources
           WHERE organization_id = $4
             AND ($5::uuid IS NULL OR id = $5::uuid)
         )
       RETURNING rs.id`,
      [
        params.reason,
        params.from,
        params.until,
        params.organizationId,
        params.resourceId ?? null,
      ],
      executor
    )
    return rows.map((r) => r.id)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // QUOTES
  // ═══════════════════════════════════════════════════════════════════════════

  async listQuotesForRequest(
    requestId: string,
    executor?: Executor
  ): Promise<QuoteRecord[]> {
    const { rows } = await this.run<{
      id: string
      vendor_id: string
      quoted_price: number
      message: string | null
      name: string | null
      rating: string
      completed_jobs: number
      category_tags: string[] | null
    }>(
      'listQuotesForRequest',
      `SELECT rr.id, rr.vendor_id, rr.quoted_price, rr.message,
              u.name, v.rating, v.completed_jobs, v.category_tags
       FROM request_responses rr
       JOIN vendors v ON v.id = rr.vendor_id
       JOIN users u ON u.id = v.user_id
       WHERE rr.request_id = $1 AND rr.status = 'quoted'
       ORDER BY rr.responded_at ASC`,
      [requestId],
      executor
    )

    return rows.map((r) => ({
      responseId: r.id,
      vendorId: r.vendor_id,
      vendorName: r.name ?? r.category_tags?.[0] ?? 'Vendor',
      vendorRating: num(r.rating),
      vendorJobs: r.completed_jobs,
      quotedPrice: r.quoted_price,
      message: r.message,
    }))
  }

  async submitQuote(
    params: {
      requestId: string
      vendorId: string
      price: number
      message?: string
    },
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'submitQuote',
      `UPDATE request_responses
       SET status = 'quoted', quoted_price = $1, message = $2, responded_at = now()
       WHERE request_id = $3 AND vendor_id = $4
         AND status IN ('pending', 'counter')`,
      [params.price, params.message ?? null, params.requestId, params.vendorId],
      executor
    )
  }

  async findVendorIdForResponse(
    responseId: string,
    executor?: Executor
  ): Promise<string | null> {
    const row = await this.one<{ vendor_id: string }>(
      'findVendorIdForResponse',
      'SELECT vendor_id FROM request_responses WHERE id = $1',
      [responseId],
      executor
    )
    return row?.vendor_id ?? null
  }

  /** Mark the winner. Pair with markOthersMissed in the same transaction. */
  async markResponseConfirmed(
    responseId: string,
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'markResponseConfirmed',
      `UPDATE request_responses
       SET status = 'confirmed', responded_at = now()
       WHERE id = $1`,
      [responseId],
      executor
    )
  }

  /** Everyone who didn't win. Declined vendors keep their own status. */
  async markOthersMissed(
    requestId: string,
    winningResponseId: string,
    executor?: Executor
  ): Promise<number> {
    const { rowCount } = await this.run(
      'markOthersMissed',
      `UPDATE request_responses
       SET status = 'missed'
       WHERE request_id = $1
         AND id != $2
         AND status NOT IN ('declined', 'missed')`,
      [requestId, winningResponseId],
      executor
    )
    return rowCount
  }

  async createPendingResponses(
    requestId: string,
    vendorIds: string[],
    executor?: Executor
  ): Promise<number> {
    if (vendorIds.length === 0) return 0

    const { rowCount } = await this.run(
      'createPendingResponses',
      `INSERT INTO request_responses (request_id, vendor_id, status)
       SELECT $1, unnest($2::uuid[]), 'pending'
       ON CONFLICT (request_id, vendor_id) DO NOTHING`,
      [requestId, vendorIds],
      executor
    )
    return rowCount
  }

  async listUserIdsWhoMissed(
    requestId: string,
    executor?: Executor
  ): Promise<string[]> {
    const { rows } = await this.run<{ user_id: string }>(
      'listUserIdsWhoMissed',
      `SELECT v.user_id
       FROM request_responses rr
       JOIN vendors v ON v.id = rr.vendor_id
       WHERE rr.request_id = $1 AND rr.status = 'missed'`,
      [requestId],
      executor
    )
    return rows.map((r) => r.user_id)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VENDOR COMMITMENTS (travel-aware scheduling)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // A commitment's blocked_period includes travel buffer either side, and a
  // Postgres EXCLUDE constraint makes two overlapping active commitments for
  // one vendor impossible. Insert throws SQLSTATE 23P01 on conflict — that is
  // the constraint working, not a bug.

  /** Commitment ending most recently before a given time. */
  async findCommitmentBefore(
    vendorId: string,
    before: string,
    executor?: Executor
  ): Promise<CommitmentRecord | null> {
    const row = await this.one<{
      id: string
      service_from: string
      service_until: string
      lat: number | null
      lng: number | null
      area_label: string | null
    }>(
      'findCommitmentBefore',
      `SELECT id, service_from, service_until, lat, lng, area_label
       FROM vendor_commitments
       WHERE vendor_id = $1 AND status = 'active' AND service_until <= $2
       ORDER BY service_until DESC LIMIT 1`,
      [vendorId, before],
      executor
    )
    return row ? toCommitment(row) : null
  }

  /** Commitment starting soonest after a given time. */
  async findCommitmentAfter(
    vendorId: string,
    after: string,
    executor?: Executor
  ): Promise<CommitmentRecord | null> {
    const row = await this.one<{
      id: string
      service_from: string
      service_until: string
      lat: number | null
      lng: number | null
      area_label: string | null
    }>(
      'findCommitmentAfter',
      `SELECT id, service_from, service_until, lat, lng, area_label
       FROM vendor_commitments
       WHERE vendor_id = $1 AND status = 'active' AND service_from >= $2
       ORDER BY service_from ASC LIMIT 1`,
      [vendorId, after],
      executor
    )
    return row ? toCommitment(row) : null
  }

  /**
   * Record a commitment.
   *
   * Throws SQLSTATE 23P01 if it would overlap an existing active commitment.
   * Callers should catch that specific code and treat it as a schedule
   * conflict — it is the EXCLUDE constraint doing its job, and is the last
   * line of defence when the pre-check missed a concurrent insert.
   */
  async createCommitment(
    params: {
      vendorId: string
      requestId: string
      serviceFrom: string
      serviceUntil: string
      blockedFrom: string
      blockedUntil: string
      lat?: number | null
      lng?: number | null
      h3r7?: string | null
      areaLabel?: string | null
      bufferMinutes: number
      estimateMethod: string
    },
    executor?: Executor
  ): Promise<string> {
    const row = await this.one<{ id: string }>(
      'createCommitment',
      `INSERT INTO vendor_commitments
         (vendor_id, request_id, service_from, service_until, blocked_period,
          lat, lng, h3_r7, area_label,
          travel_in_minutes, travel_out_minutes, estimate_method)
       VALUES ($1,$2,$3,$4,tstzrange($5,$6),$7,$8,$9,$10,$11,$11,$12)
       RETURNING id`,
      [
        params.vendorId,
        params.requestId,
        params.serviceFrom,
        params.serviceUntil,
        params.blockedFrom,
        params.blockedUntil,
        params.lat ?? null,
        params.lng ?? null,
        params.h3r7 ?? null,
        params.areaLabel ?? null,
        params.bufferMinutes,
        params.estimateMethod,
      ],
      executor
    )

    if (!row) throw new Error('Commitment insert returned no row')
    return row.id
  }

  async releaseCommitment(
    requestId: string,
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'releaseCommitment',
      `UPDATE vendor_commitments SET status = 'cancelled' WHERE request_id = $1`,
      [requestId],
      executor
    )
  }

  /** Any active commitment overlapping a window — for fixed-premises vendors. */
  async findOverlappingCommitment(
    vendorId: string,
    from: string,
    until: string,
    executor?: Executor
  ): Promise<CommitmentRecord | null> {
    const row = await this.one<{
      id: string
      service_from: string
      service_until: string
      lat: number | null
      lng: number | null
      area_label: string | null
    }>(
      'findOverlappingCommitment',
      `SELECT id, service_from, service_until, lat, lng, area_label
       FROM vendor_commitments
       WHERE vendor_id = $1 AND status = 'active'
         AND blocked_period && tstzrange($2, $3)
       LIMIT 1`,
      [vendorId, from, until],
      executor
    )
    return row ? toCommitment(row) : null
  }
}

/** SQLSTATE for exclusion_violation — an overlap the constraint rejected. */
export const EXCLUSION_VIOLATION = '23P01'

export function isScheduleConflict(err: unknown): boolean {
  return (err as { code?: string })?.code === EXCLUSION_VIOLATION
}

// ─── Mappers ──────────────────────────────────────────────────────────────────
function toSlot(r: SlotRow): ResourceSlot {
  return {
    id: r.id,
    resourceId: r.resource_id,
    slotTime: r.slot_time,
    durationMinutes: r.duration_minutes,
    capacityTotal: r.capacity_total,
    capacityBooked: r.capacity_booked,
    priceOverride: numOrNull(r.price_override),
    isCancelled: r.is_cancelled,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
  }
}

function toCommitment(r: {
  id: string
  service_from: string
  service_until: string
  lat: number | null
  lng: number | null
  area_label: string | null
}): CommitmentRecord {
  return {
    id: r.id,
    serviceFrom: r.service_from,
    serviceUntil: r.service_until,
    lat: numOrNull(r.lat),
    lng: numOrNull(r.lng),
    areaLabel: r.area_label,
  }
}
