/**
 * TravelService — makes physically impossible schedules impossible.
 *
 * THE BUG THIS FIXES
 * ──────────────────
 * A plumber could accept 2:00pm in Kondapur and 2:30pm in LB Nagar. Those are
 * 25km apart in Hyderabad traffic — roughly 100 minutes. The vendor no-shows
 * one of them, both customers blame the platform, and the vendor's reliability
 * score drops for something the system let them do.
 *
 * WHY H3 INSTEAD OF A ROUTING API
 * ───────────────────────────────
 * Every vendor and request is already H3-indexed for matching. `gridDistance`
 * returns the number of hex hops between two cells, which converts to distance
 * with arithmetic — no network call, no API key, no rate limit, no latency.
 *
 * At resolution 7 each hex is ~1.2km across. Kondapur → LB Nagar is ~20 hops
 * → 20 × 1.2 × 1.35 (road winding) ≈ 32km → at 18 km/h ≈ 107 minutes.
 * The real drive is 60–100 minutes depending on traffic. Close enough to catch
 * the failure, and it costs nothing.
 *
 * DELIBERATELY PESSIMISTIC
 * ────────────────────────
 * The speed constants are lower than a routing API would return. That is
 * intentional and asymmetric: an optimistic estimate causes a double-booking
 * (real harm to two customers and a vendor), a pessimistic estimate causes a
 * declined job (recoverable — the vendor can override, and we log it).
 *
 * SELF-CORRECTING
 * ───────────────
 * Speeds and the winding factor live in agent_knowledge, not as constants.
 * When a vendor overrides a rejection and arrives on time, that is evidence the
 * estimate was too conservative, logged in travel_rejections for correction.
 */

import { latLngToCell, gridDistance } from 'h3-js'
import { query } from '../lib/db'
import { KnowledgeService } from './knowledge.service'
import { H3_RES_MID } from '../lib/h3'
import { logger } from '../lib/logger'

const knowledge = new KnowledgeService()

// Hex edge length at resolution 7, in km. Fixed by the H3 spec.
const HEX_EDGE_KM_R7 = 1.22

// Used when we have no location for one side of the comparison. Generous
// enough not to block legitimate bookings, tight enough to catch the
// cross-city case.
const UNKNOWN_LOCATION_BUFFER_MINUTES = 45

export type TravelMode =
  | 'walk' | 'two_wheeler' | 'car' | 'tempo' | 'public_transport'

export interface TravelEstimate {
  minutes: number
  estimatedKm: number
  hexDistance: number | null
  method: 'h3_hex_distance' | 'same_cell' | 'default_unknown_location'
  mode: TravelMode
}

export interface FeasibilityVerdict {
  feasible: boolean
  reason?: string
  /** What the vendor is told, in plain language. */
  vendorMessage?: string
  conflictingCommitment?: {
    id: string
    serviceFrom: string
    areaLabel: string | null
  }
  travelNeededMinutes?: number
  availableGapMinutes?: number
  /** Vendors can override — we are estimating, not measuring. */
  overridable: boolean
}

export class TravelService {

  // ─── Estimate travel time between two points ────────────────────────────────
  async estimate(
    from: { lat: number; lng: number } | null,
    to: { lat: number; lng: number } | null,
    mode: TravelMode = 'two_wheeler'
  ): Promise<TravelEstimate> {

    // Missing location on either side — fall back to a flat buffer rather than
    // pretending we know. Better a conservative guess than a silent zero.
    if (!from || !to) {
      return {
        minutes: UNKNOWN_LOCATION_BUFFER_MINUTES,
        estimatedKm: 0,
        hexDistance: null,
        method: 'default_unknown_location',
        mode,
      }
    }

    const speedKmph = await knowledge.resolveOr<number>(
      'travel_speed',
      mode,
      'kmph',
      18
    )
    const windingFactor = await knowledge.resolveOr<number>(
      'travel_model',
      'global',
      'road_winding_factor',
      1.35
    )

    let hexDistance: number
    try {
      const cellA = latLngToCell(from.lat, from.lng, H3_RES_MID)
      const cellB = latLngToCell(to.lat, to.lng, H3_RES_MID)
      hexDistance = gridDistance(cellA, cellB)
    } catch (err) {
      // gridDistance throws when cells are too far apart for a grid path
      // (crossing an icosahedron edge). At city scale this shouldn't happen,
      // but if it does, treat it as "very far".
      logger.debug({ err }, 'H3 gridDistance failed — treating as distant')
      return {
        minutes: 120,
        estimatedKm: 40,
        hexDistance: null,
        method: 'default_unknown_location',
        mode,
      }
    }

    if (hexDistance === 0) {
      // Same hex cell — under ~1.2km. Assume minimal travel but not zero,
      // because "same area" still means finding parking and a doorway.
      return {
        minutes: mode === 'walk' ? 15 : 10,
        estimatedKm: 0.6,
        hexDistance: 0,
        method: 'same_cell',
        mode,
      }
    }

    const straightKm = hexDistance * HEX_EDGE_KM_R7
    const roadKm = straightKm * Number(windingFactor)
    const minutes = Math.ceil((roadKm / Number(speedKmph)) * 60)

    return {
      minutes,
      estimatedKm: Math.round(roadKm * 10) / 10,
      hexDistance,
      method: 'h3_hex_distance',
      mode,
    }
  }

  // ─── Can this vendor physically take this job? ───────────────────────────────
  async checkFeasibility(params: {
    vendorId: string
    serviceFrom: string
    durationMinutes: number
    lat?: number | null
    lng?: number | null
    requestId?: string
  }): Promise<FeasibilityVerdict> {

    const vendorResult = await query<{
      travel_mode: TravelMode
      is_fixed_premises: boolean
      min_gap_minutes: number
    }>(
      `SELECT travel_mode, is_fixed_premises, min_gap_minutes
       FROM vendors WHERE id = $1`,
      [params.vendorId]
    )

    const vendor = vendorResult.rows[0]
    if (!vendor) {
      return { feasible: false, reason: 'Vendor not found', overridable: false }
    }

    const serviceFrom = new Date(params.serviceFrom)
    const serviceUntil = new Date(
      serviceFrom.getTime() + params.durationMinutes * 60_000
    )

    // A salon or clinic never travels — the customer comes to them. Only
    // capacity matters, which resource_slots already handles.
    if (vendor.is_fixed_premises) {
      const overlap = await this.findOverlap(
        params.vendorId,
        serviceFrom,
        serviceUntil,
        0
      )
      if (overlap) {
        return {
          feasible: false,
          reason: 'already_booked',
          vendorMessage: `You already have a booking at ${this.formatIST(overlap.service_from)}.`,
          conflictingCommitment: {
            id: overlap.id,
            serviceFrom: overlap.service_from,
            areaLabel: overlap.area_label,
          },
          overridable: false,
        }
      }
      return { feasible: true, overridable: false }
    }

    // ── Mobile vendor: check travel against the nearest commitments ─────────
    const location =
      params.lat != null && params.lng != null
        ? { lat: params.lat, lng: params.lng }
        : null

    // Commitment ending most recently BEFORE this one starts
    const before = await query<CommitmentRow>(
      `SELECT id, service_from, service_until, lat, lng, area_label
       FROM vendor_commitments
       WHERE vendor_id = $1 AND status = 'active' AND service_until <= $2
       ORDER BY service_until DESC LIMIT 1`,
      [params.vendorId, serviceFrom.toISOString()]
    )

    // Commitment starting soonest AFTER this one ends
    const after = await query<CommitmentRow>(
      `SELECT id, service_from, service_until, lat, lng, area_label
       FROM vendor_commitments
       WHERE vendor_id = $1 AND status = 'active' AND service_from >= $2
       ORDER BY service_from ASC LIMIT 1`,
      [params.vendorId, serviceUntil.toISOString()]
    )

    // ── Check the inbound leg ──────────────────────────────────────────────
    const prev = before.rows[0]
    if (prev) {
      const travelIn = await this.estimate(
        prev.lat != null && prev.lng != null
          ? { lat: prev.lat, lng: prev.lng }
          : null,
        location,
        vendor.travel_mode
      )

      const gapMinutes =
        (serviceFrom.getTime() - new Date(prev.service_until).getTime()) / 60_000
      const needed = travelIn.minutes + vendor.min_gap_minutes

      if (gapMinutes < needed) {
        await this.logRejection({
          vendorId: params.vendorId,
          requestId: params.requestId,
          commitmentId: prev.id,
          travelMinutes: travelIn.minutes,
          gapMinutes: Math.floor(gapMinutes),
          estimate: travelIn,
        })

        return {
          feasible: false,
          reason: 'insufficient_travel_time_inbound',
          vendorMessage:
            `You have a job ending ${this.formatIST(prev.service_until)}` +
            (prev.area_label ? ` in ${prev.area_label}` : '') +
            `. Getting from there to this one is about ${travelIn.minutes} minutes` +
            (travelIn.estimatedKm > 1 ? ` (~${travelIn.estimatedKm} km)` : '') +
            `, but there's only a ${Math.floor(gapMinutes)} minute gap.`,
          conflictingCommitment: {
            id: prev.id,
            serviceFrom: prev.service_from,
            areaLabel: prev.area_label,
          },
          travelNeededMinutes: needed,
          availableGapMinutes: Math.floor(gapMinutes),
          overridable: true,
        }
      }
    }

    // ── Check the outbound leg ─────────────────────────────────────────────
    const next = after.rows[0]
    if (next) {
      const travelOut = await this.estimate(
        location,
        next.lat != null && next.lng != null
          ? { lat: next.lat, lng: next.lng }
          : null,
        vendor.travel_mode
      )

      const gapMinutes =
        (new Date(next.service_from).getTime() - serviceUntil.getTime()) / 60_000
      const needed = travelOut.minutes + vendor.min_gap_minutes

      if (gapMinutes < needed) {
        await this.logRejection({
          vendorId: params.vendorId,
          requestId: params.requestId,
          commitmentId: next.id,
          travelMinutes: travelOut.minutes,
          gapMinutes: Math.floor(gapMinutes),
          estimate: travelOut,
        })

        return {
          feasible: false,
          reason: 'insufficient_travel_time_outbound',
          vendorMessage:
            `Taking this would leave you ${Math.floor(gapMinutes)} minutes to reach ` +
            `your ${this.formatIST(next.service_from)} job` +
            (next.area_label ? ` in ${next.area_label}` : '') +
            `, and that trip is about ${travelOut.minutes} minutes.`,
          conflictingCommitment: {
            id: next.id,
            serviceFrom: next.service_from,
            areaLabel: next.area_label,
          },
          travelNeededMinutes: needed,
          availableGapMinutes: Math.floor(gapMinutes),
          overridable: true,
        }
      }
    }

    return { feasible: true, overridable: false }
  }

  // ─── Record the commitment (called on booking confirmation) ─────────────────
  //
  // The EXCLUDE constraint is the real enforcement. checkFeasibility is a
  // courtesy that produces a good error message; this is what makes it true.
  async commit(params: {
    vendorId: string
    requestId: string
    serviceFrom: string
    durationMinutes: number
    lat?: number | null
    lng?: number | null
    areaLabel?: string | null
  }): Promise<{ success: boolean; commitmentId?: string; reason?: string }> {

    const vendorResult = await query<{
      travel_mode: TravelMode
      is_fixed_premises: boolean
      min_gap_minutes: number
    }>(
      `SELECT travel_mode, is_fixed_premises, min_gap_minutes
       FROM vendors WHERE id = $1`,
      [params.vendorId]
    )
    const vendor = vendorResult.rows[0]
    if (!vendor) return { success: false, reason: 'vendor_not_found' }

    const serviceFrom = new Date(params.serviceFrom)
    const serviceUntil = new Date(
      serviceFrom.getTime() + params.durationMinutes * 60_000
    )

    // Fixed premises need no travel buffer, just the minimum gap
    const bufferMinutes = vendor.is_fixed_premises
      ? vendor.min_gap_minutes
      : (
          await this.estimate(
            null, // unknown previous location at commit time
            params.lat != null && params.lng != null
              ? { lat: params.lat, lng: params.lng }
              : null,
            vendor.travel_mode
          )
        ).minutes + vendor.min_gap_minutes

    const blockedFrom = new Date(serviceFrom.getTime() - bufferMinutes * 60_000)
    const blockedUntil = new Date(serviceUntil.getTime() + bufferMinutes * 60_000)

    const h3 =
      params.lat != null && params.lng != null
        ? latLngToCell(params.lat, params.lng, H3_RES_MID)
        : null

    try {
      const result = await query<{ id: string }>(
        `INSERT INTO vendor_commitments
           (vendor_id, request_id, service_from, service_until, blocked_period,
            lat, lng, h3_r7, area_label, travel_in_minutes, travel_out_minutes,
            estimate_method)
         VALUES ($1,$2,$3,$4,tstzrange($5,$6),$7,$8,$9,$10,$11,$11,$12)
         RETURNING id`,
        [
          params.vendorId,
          params.requestId,
          serviceFrom.toISOString(),
          serviceUntil.toISOString(),
          blockedFrom.toISOString(),
          blockedUntil.toISOString(),
          params.lat ?? null,
          params.lng ?? null,
          h3,
          params.areaLabel ?? null,
          bufferMinutes,
          vendor.is_fixed_premises ? 'vendor_declared' : 'h3_hex_distance',
        ]
      )

      logger.info(
        {
          vendorId: params.vendorId,
          bufferMinutes,
          blocked: `${this.formatIST(blockedFrom.toISOString())} – ${this.formatIST(blockedUntil.toISOString())}`,
        },
        'Vendor commitment recorded'
      )

      return { success: true, commitmentId: result.rows[0].id }
    } catch (err) {
      // 23P01 = exclusion_violation. The DB caught an overlap our pre-check
      // missed — a concurrent booking slipped in. This is the constraint doing
      // exactly its job.
      if ((err as { code?: string }).code === '23P01') {
        logger.info(
          { vendorId: params.vendorId },
          'Exclusion constraint blocked an overlapping vendor commitment'
        )
        return { success: false, reason: 'schedule_conflict' }
      }
      throw err
    }
  }

  /** Free the window when a booking is cancelled. */
  async release(requestId: string): Promise<void> {
    await query(
      `UPDATE vendor_commitments SET status = 'cancelled' WHERE request_id = $1`,
      [requestId]
    )
  }

  /** A vendor insists they can make it. Record the override as evidence. */
  async recordOverride(
    rejectionId: string,
    vendorId: string,
    reason: string
  ): Promise<boolean> {
    const result = await query(
      `UPDATE travel_rejections
       SET vendor_overrode = true, override_reason = $3
       WHERE id = $1 AND vendor_id = $2`,
      [rejectionId, vendorId, reason.slice(0, 500)]
    )
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Was the estimate right? Called when a job completes or a no-show is
   * reported on a booking the vendor overrode. This is the correction signal.
   */
  async recordOverrideOutcome(
    requestId: string,
    outcome: 'vendor_arrived_on_time' | 'vendor_was_late' | 'vendor_no_showed'
  ): Promise<void> {
    await query(
      `UPDATE travel_rejections
       SET outcome = $2
       WHERE request_id = $1 AND vendor_overrode = true AND outcome IS NULL`,
      [requestId, outcome]
    )

    // If vendors consistently override and arrive fine, our speeds are too
    // pessimistic. Feed that back as evidence.
    if (outcome === 'vendor_arrived_on_time') {
      await knowledge.recordOutcome({
        domain: 'travel_model',
        subject: 'global',
        key: 'road_winding_factor',
        outcome: 'failure', // the model was wrong (too conservative)
        requestId,
        note: 'Vendor overrode a travel rejection and arrived on time',
      })
    }
  }

  // ─── Model accuracy report ─────────────────────────────────────────────────
  async getModelAccuracy(): Promise<{
    totalRejections: number
    overrideRate: number
    overrideOutcomes: Record<string, number>
    verdict: string
  }> {
    const result = await query<{
      total: string
      overridden: string
      on_time: string
      late: string
      no_show: string
    }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE vendor_overrode) AS overridden,
              COUNT(*) FILTER (WHERE outcome = 'vendor_arrived_on_time') AS on_time,
              COUNT(*) FILTER (WHERE outcome = 'vendor_was_late') AS late,
              COUNT(*) FILTER (WHERE outcome = 'vendor_no_showed') AS no_show
       FROM travel_rejections`
    )

    const r = result.rows[0]
    const total = Number(r?.total ?? 0)
    const overridden = Number(r?.overridden ?? 0)
    const onTime = Number(r?.on_time ?? 0)
    const late = Number(r?.late ?? 0)
    const noShow = Number(r?.no_show ?? 0)
    const resolved = onTime + late + noShow

    let verdict = 'Not enough data yet.'
    if (resolved >= 10) {
      const onTimeRate = onTime / resolved
      if (onTimeRate > 0.7) {
        verdict =
          'Estimates look TOO PESSIMISTIC — vendors override and arrive fine ' +
          `${Math.round(onTimeRate * 100)}% of the time. Consider raising the ` +
          'speed constants or lowering the winding factor.'
      } else if (onTimeRate < 0.3) {
        verdict =
          'Estimates look correct or too optimistic — most overrides resulted ' +
          'in lateness or no-shows. Do not loosen the model.'
      } else {
        verdict = 'Estimates look roughly calibrated.'
      }
    }

    return {
      totalRejections: total,
      overrideRate: total > 0 ? Math.round((overridden / total) * 100) / 100 : 0,
      overrideOutcomes: { onTime, late, noShow },
      verdict,
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  private async findOverlap(
    vendorId: string,
    from: Date,
    until: Date,
    bufferMinutes: number
  ): Promise<CommitmentRow | null> {
    const result = await query<CommitmentRow>(
      `SELECT id, service_from, service_until, lat, lng, area_label
       FROM vendor_commitments
       WHERE vendor_id = $1 AND status = 'active'
         AND blocked_period && tstzrange($2, $3)
       LIMIT 1`,
      [
        vendorId,
        new Date(from.getTime() - bufferMinutes * 60_000).toISOString(),
        new Date(until.getTime() + bufferMinutes * 60_000).toISOString(),
      ]
    )
    return result.rows[0] ?? null
  }

  private async logRejection(params: {
    vendorId: string
    requestId?: string
    commitmentId: string
    travelMinutes: number
    gapMinutes: number
    estimate: TravelEstimate
  }): Promise<void> {
    try {
      await query(
        `INSERT INTO travel_rejections
           (vendor_id, request_id, conflicting_commitment_id,
            estimated_travel_minutes, available_gap_minutes,
            hex_distance, estimated_km)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          params.vendorId,
          params.requestId ?? null,
          params.commitmentId,
          params.travelMinutes,
          params.gapMinutes,
          params.estimate.hexDistance,
          params.estimate.estimatedKm,
        ]
      )
    } catch (err) {
      logger.warn({ err }, 'Could not log travel rejection')
    }
  }

  private formatIST(iso: string): string {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      day: 'numeric',
      month: 'short',
    })
  }
}

interface CommitmentRow {
  id: string
  service_from: string
  service_until: string
  lat: number | null
  lng: number | null
  area_label: string | null
}
