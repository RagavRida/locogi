/**
 * VendorRepository — every read and write of vendor identity.
 *
 * Replaces 12 duplicated inline queries found across routes, services and
 * workers. The most-copied shape ("find vendor by user_id", 10 sites) is now
 * one method with one definition of what "the caller's vendor" means.
 *
 * Deliberately does NOT include matching. Matching is a domain operation with
 * its own scoring, H3 tiering and fallback ladder — it lives in
 * MatchingService and calls this repository for the data it needs.
 */

import { BaseRepository, type Executor, num, numOrNull } from './base'

// ─── Row shapes (snake_case, as Postgres returns them) ────────────────────────
interface VendorRow {
  id: string
  user_id: string
  raw_description: string
  category_tags: string[] | null
  attributes: Record<string, unknown> | null
  attribute_schema: Record<string, string> | null
  embedding_generated_at: string | null
  service_area_description: string | null
  service_radius_km: number
  lat: number | null
  lng: number | null
  h3_r7: string | null
  h3_r8: string | null
  is_priority: boolean
  is_kyc_verified: boolean
  rating: string | number
  response_rate: string | number
  completed_jobs: number
  no_show_count: number
  reliability_score: string | number
  travel_mode: string
  is_fixed_premises: boolean
  min_gap_minutes: number
}

// ─── Domain shape ─────────────────────────────────────────────────────────────
export interface VendorRecord {
  id: string
  userId: string
  rawDescription: string
  categoryTags: string[]
  attributes: Record<string, unknown>
  serviceAreaDescription: string | null
  serviceRadiusKm: number
  lat: number | null
  lng: number | null
  h3r7: string | null
  h3r8: string | null
  isPriority: boolean
  isKycVerified: boolean
  hasEmbedding: boolean
  rating: number
  responseRate: number
  completedJobs: number
  noShowCount: number
  reliabilityScore: number
  travelMode: string
  isFixedPremises: boolean
  minGapMinutes: number
}

/** The scheduling facts TravelService needs — narrower than a full vendor. */
export interface VendorTravelProfile {
  travelMode: string
  isFixedPremises: boolean
  minGapMinutes: number
}

const VENDOR_COLUMNS = `
  id, user_id, raw_description, category_tags, attributes, attribute_schema,
  embedding_generated_at, service_area_description, service_radius_km,
  lat, lng, h3_r7, h3_r8, is_priority, is_kyc_verified,
  rating, response_rate, completed_jobs,
  no_show_count, reliability_score,
  travel_mode, is_fixed_premises, min_gap_minutes
`

export class VendorRepository extends BaseRepository {

  // ─── Identity ───────────────────────────────────────────────────────────────

  /**
   * The vendor profile belonging to a user account.
   *
   * This is the single most duplicated query in the codebase (was 10 copies).
   * Centralising it also fixes a latent inconsistency: some copies selected
   * only `id`, others selected extra columns, so callers had subtly different
   * views of the same entity.
   */
  async findByUserId(
    userId: string,
    executor?: Executor
  ): Promise<VendorRecord | null> {
    const row = await this.one<VendorRow>(
      'findByUserId',
      `SELECT ${VENDOR_COLUMNS} FROM vendors WHERE user_id = $1`,
      [userId],
      executor
    )
    return row ? toVendor(row) : null
  }

  /** Just the id — for the many call sites that only need to scope a query. */
  async findIdByUserId(
    userId: string,
    executor?: Executor
  ): Promise<string | null> {
    const row = await this.one<{ id: string }>(
      'findIdByUserId',
      'SELECT id FROM vendors WHERE user_id = $1',
      [userId],
      executor
    )
    return row?.id ?? null
  }

  async findById(
    vendorId: string,
    executor?: Executor
  ): Promise<VendorRecord | null> {
    const row = await this.one<VendorRow>(
      'findById',
      `SELECT ${VENDOR_COLUMNS} FROM vendors WHERE id = $1`,
      [vendorId],
      executor
    )
    return row ? toVendor(row) : null
  }

  /**
   * The user account behind a vendor — needed whenever we notify them.
   * Returns null for a vendor whose user row was anonymised by DPDP deletion.
   */
  async findUserIdByVendorId(
    vendorId: string,
    executor?: Executor
  ): Promise<string | null> {
    const row = await this.one<{ user_id: string }>(
      'findUserIdByVendorId',
      'SELECT user_id FROM vendors WHERE id = $1',
      [vendorId],
      executor
    )
    return row?.user_id ?? null
  }

  /** Bulk variant — avoids N+1 when fanning out to matched vendors. */
  async findUserIdsByVendorIds(
    vendorIds: string[],
    executor?: Executor
  ): Promise<Map<string, string>> {
    if (vendorIds.length === 0) return new Map()

    const { rows } = await this.run<{ id: string; user_id: string }>(
      'findUserIdsByVendorIds',
      'SELECT id, user_id FROM vendors WHERE id = ANY($1::uuid[])',
      [vendorIds],
      executor
    )
    return new Map(rows.map((r) => [r.id, r.user_id]))
  }

  // ─── Scheduling profile ─────────────────────────────────────────────────────

  async getTravelProfile(
    vendorId: string,
    executor?: Executor
  ): Promise<VendorTravelProfile | null> {
    const row = await this.one<{
      travel_mode: string
      is_fixed_premises: boolean
      min_gap_minutes: number
    }>(
      'getTravelProfile',
      `SELECT travel_mode, is_fixed_premises, min_gap_minutes
       FROM vendors WHERE id = $1`,
      [vendorId],
      executor
    )

    return row
      ? {
          travelMode: row.travel_mode,
          isFixedPremises: row.is_fixed_premises,
          minGapMinutes: row.min_gap_minutes,
        }
      : null
  }

  // ─── Geospatial ─────────────────────────────────────────────────────────────

  async updateLocation(
    vendorId: string,
    lat: number,
    lng: number,
    h3: { h3_r8: string; h3_r7: string; h3_r6: string },
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'updateLocation',
      `UPDATE vendors
       SET lat = $1, lng = $2, h3_r8 = $3, h3_r7 = $4, h3_r6 = $5
       WHERE id = $6`,
      [lat, lng, h3.h3_r8, h3.h3_r7, h3.h3_r6, vendorId],
      executor
    )
  }

  async updateEmbedding(
    vendorId: string,
    vectorLiteral: string,
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'updateEmbedding',
      `UPDATE vendors
       SET embedding = $1::vector, embedding_generated_at = now()
       WHERE id = $2`,
      [vectorLiteral, vendorId],
      executor
    )
  }

  // ─── Reputation ─────────────────────────────────────────────────────────────
  //
  // rating and reliability_score are deliberately separate: a vendor can do
  // excellent work (5 stars) and still be unreliable about turning up.
  // Conflating them would hide the more operationally important signal.

  async recalculateRating(
    vendorId: string,
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'recalculateRating',
      `UPDATE vendors
       SET rating = COALESCE(
         (SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE vendor_id = $1),
         0
       )
       WHERE id = $1`,
      [vendorId],
      executor
    )
  }

  async incrementCompletedJobs(
    vendorId: string,
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'incrementCompletedJobs',
      'UPDATE vendors SET completed_jobs = completed_jobs + 1 WHERE id = $1',
      [vendorId],
      executor
    )
  }

  async penaliseNoShow(
    vendorId: string,
    points = 15,
    executor?: Executor
  ): Promise<boolean> {
    return this.didWrite(
      'penaliseNoShow',
      `UPDATE vendors
       SET no_show_count = no_show_count + 1,
           reliability_score = GREATEST(0, reliability_score - $2)
       WHERE id = $1`,
      [vendorId, points],
      executor
    )
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  async getPerformanceStats(
    userId: string,
    executor?: Executor
  ): Promise<{
    completedJobs: number
    rating: number
    reliabilityScore: number
    quoted: number
    accepted: number
    earnings: number
    acceptanceRate: number
  } | null> {
    const row = await this.one<{
      completed_jobs: number
      rating: string
      reliability_score: string
      total_quoted: string
      total_accepted: string
      total_earnings: string
    }>(
      'getPerformanceStats',
      `SELECT v.completed_jobs, v.rating, v.reliability_score,
              COUNT(rr.id) FILTER (WHERE rr.status = 'quoted')    AS total_quoted,
              COUNT(rr.id) FILTER (WHERE rr.status = 'confirmed') AS total_accepted,
              COALESCE(SUM(r.agreed_price) FILTER (WHERE r.status = 'completed'), 0)
                AS total_earnings
       FROM vendors v
       LEFT JOIN request_responses rr ON rr.vendor_id = v.id
       LEFT JOIN requests r ON r.confirmed_vendor_id = v.id
       WHERE v.user_id = $1
       GROUP BY v.id, v.completed_jobs, v.rating, v.reliability_score`,
      [userId],
      executor
    )

    if (!row) return null

    const quoted = num(row.total_quoted)
    const accepted = num(row.total_accepted)

    return {
      completedJobs: row.completed_jobs,
      rating: num(row.rating),
      reliabilityScore: num(row.reliability_score),
      quoted,
      accepted,
      earnings: num(row.total_earnings),
      acceptanceRate: quoted > 0 ? Math.round((accepted / quoted) * 100) : 0,
    }
  }

  // ─── Bookable resource resolution ───────────────────────────────────────────
  //
  // Slots belong to a bookable_resource, not a vendor. A solo vendor has one
  // implicit 'person' resource. This resolves it — and reports when there are
  // several, so the caller can refuse rather than guess which table or doctor
  // the slots were meant for.

  async findPrimaryResource(
    userId: string,
    executor?: Executor
  ): Promise<{ resourceId: string; resourceCount: number } | null> {
    const row = await this.one<{ id: string; resource_count: string }>(
      'findPrimaryResource',
      `SELECT br.id,
              COUNT(*) OVER (PARTITION BY br.organization_id) AS resource_count
       FROM bookable_resources br
       JOIN organizations o ON o.id = br.organization_id
       JOIN vendors v ON v.id = o.vendor_id
       WHERE v.user_id = $1 AND br.is_active = true
       ORDER BY br.display_order, br.created_at
       LIMIT 1`,
      [userId],
      executor
    )

    return row
      ? { resourceId: row.id, resourceCount: num(row.resource_count) }
      : null
  }
}

// ─── Mapper ───────────────────────────────────────────────────────────────────
function toVendor(r: VendorRow): VendorRecord {
  return {
    id: r.id,
    userId: r.user_id,
    rawDescription: r.raw_description,
    categoryTags: r.category_tags ?? [],
    attributes: r.attributes ?? {},
    serviceAreaDescription: r.service_area_description,
    serviceRadiusKm: r.service_radius_km,
    lat: numOrNull(r.lat),
    lng: numOrNull(r.lng),
    h3r7: r.h3_r7,
    h3r8: r.h3_r8,
    isPriority: r.is_priority,
    isKycVerified: r.is_kyc_verified,
    // embedding itself is never loaded into app memory — it is a 1536-dim
    // vector used only inside SQL. Callers just need to know it exists.
    hasEmbedding: r.embedding_generated_at !== null,
    rating: num(r.rating),
    responseRate: num(r.response_rate),
    completedJobs: r.completed_jobs,
    noShowCount: r.no_show_count ?? 0,
    reliabilityScore: num(r.reliability_score ?? 100),
    travelMode: r.travel_mode ?? 'two_wheeler',
    isFixedPremises: r.is_fixed_premises ?? false,
    minGapMinutes: r.min_gap_minutes ?? 15,
  }
}
