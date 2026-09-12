import { query } from '../lib/db'
import { searchTiers, resolutionColumn, MIN_VENDORS_THRESHOLD } from '../lib/h3'
import { logger } from '../lib/logger'
import type { Vendor } from '@locogi/types'
import { rankVendors, type RankableVendor } from '../domain/vendor-ranking'
import { loadRankingWeights, toRankingOptions } from './ranking-config.service'
import { haversineKm } from '../lib/h3'

/**
 * How many candidates SQL returns before ranking.
 *
 * This number is the whole reason the ranker can work. Every tier used to
 * `LIMIT 5` in SQL, ordered by embedding similarity — so a nearer, more
 * reliable vendor ranked sixth by cosine distance was discarded by Postgres
 * before any weighting could see them. Reranking five already-ranked rows
 * would have been theatre.
 *
 * 30 is a deliberate middle: wide enough that the ranking has real choices,
 * narrow enough that the signal-enrichment query stays cheap.
 */
const CANDIDATE_POOL = 30

/** What the caller actually gets back, after ranking. */
const RESULT_LIMIT = 5

/**
 * MatchingService — finds vendors for a request.
 *
 * Matching happens on THREE signals, in order of reliability:
 *
 *   1. Canonical category (vendor_categories ↔ request_categories)
 *      Resolved by CategoryService, so "drone shots" and "aerial
 *      cinematography" land in the same bucket. This is the hard filter.
 *
 *   2. H3 geospatial tier — hexagonal cells, widening automatically
 *      ~2km → ~4km → ~5km → ~12km until enough vendors are found.
 *
 *   3. pgvector cosine similarity — ranks the survivors by how well their
 *      description semantically matches the request.
 *
 * Every path degrades gracefully. Missing location, missing embedding, or an
 * unrecognised category each drop one signal rather than returning nothing.
 */

interface RequestContext {
  id: string
  embedding: string | null
  lat: number | null
  lng: number | null
  categoryIds: string[]
}

export class MatchingService {

  async findVendors(requestId: string, fallbackTags: string[] = []): Promise<Vendor[]> {
    const ctx = await this.loadContext(requestId)
    if (!ctx) return []

    const hasCategories = ctx.categoryIds.length > 0
    const hasLocation = ctx.lat !== null && ctx.lng !== null
    const hasEmbedding = ctx.embedding !== null

    logger.debug(
      {
        requestId,
        signals: {
          categories: hasCategories ? ctx.categoryIds.length : 0,
          location: hasLocation,
          embedding: hasEmbedding,
        },
      },
      'Matching signals available'
    )

    // ── Best case: all three signals ────────────────────────────────────────
    if (hasCategories && hasLocation && hasEmbedding) {
      const found = await this.categoryGeoVector(ctx)
      if (found.length > 0) return found
    }

    // ── Category + embedding (no location) ──────────────────────────────────
    if (hasCategories && hasEmbedding) {
      const found = await this.categoryVector(ctx)
      if (found.length > 0) return found
    }

    // ── Category + geo (embedding still generating) ─────────────────────────
    if (hasCategories && hasLocation) {
      const found = await this.categoryGeo(ctx)
      if (found.length > 0) return found
    }

    // ── Category only ───────────────────────────────────────────────────────
    if (hasCategories) {
      const found = await this.categoryOnly(ctx.categoryIds)
      if (found.length > 0) return found
    }

    // ── No canonical category resolved — pure semantic search ───────────────
    if (hasEmbedding) {
      logger.warn(
        { requestId },
        'No canonical category — falling back to pure semantic search'
      )
      const found = await this.vectorOnly(ctx.embedding!)
      if (found.length > 0) return found
    }

    // ── Last resort: legacy raw tag overlap ─────────────────────────────────
    if (fallbackTags.length > 0) {
      return this.legacyTagMatch(fallbackTags)
    }

    return []
  }

  // ─── Path 1: category + H3 tiers + vector rank (best) ──────────────────────
  private async categoryGeoVector(ctx: RequestContext): Promise<Vendor[]> {
    for (const tier of searchTiers(ctx.lat!, ctx.lng!)) {
      const col = resolutionColumn(tier.resolution)

      const result = await query<Vendor>(
        `SELECT DISTINCT v.*,
                1 - (v.embedding <=> $3::vector) AS match_score
         FROM vendors v
         JOIN vendor_categories vc ON vc.vendor_id = v.id
         WHERE vc.category_id = ANY($1::uuid[])
           AND v.${col} = ANY($2::text[])
           AND v.embedding IS NOT NULL
           AND v.is_kyc_verified = true
           AND NOT EXISTS (
             SELECT 1 FROM users u WHERE u.id = v.user_id AND u.is_banned = true
           )
           ${this.availabilityClause()}
         ORDER BY v.is_priority DESC,
                  match_score DESC,
                  v.rating DESC
         LIMIT ${CANDIDATE_POOL}`,
        [ctx.categoryIds, tier.cells, ctx.embedding]
      )

      logger.info(
        { tier: tier.label, cells: tier.cells.length, found: result.rows.length },
        'Category + geo + vector match'
      )

      if (result.rows.length >= MIN_VENDORS_THRESHOLD) {
        return this.rankAndTrim(result.rows, ctx)
      }

      // Keep the partial result but try one wider tier for a better pool
      if (result.rows.length > 0) continue
    }

    return []
  }

  // ─── Path 2: category + vector (no location) ───────────────────────────────
  private async categoryVector(ctx: RequestContext): Promise<Vendor[]> {
    const result = await query<Vendor>(
      `SELECT DISTINCT v.*,
              1 - (v.embedding <=> $2::vector) AS match_score
       FROM vendors v
       JOIN vendor_categories vc ON vc.vendor_id = v.id
       WHERE vc.category_id = ANY($1::uuid[])
         AND v.embedding IS NOT NULL
         AND v.is_kyc_verified = true
         AND NOT EXISTS (
           SELECT 1 FROM users u WHERE u.id = v.user_id AND u.is_banned = true
         )
         ${this.availabilityClause()}
       ORDER BY v.is_priority DESC, match_score DESC, v.rating DESC
       LIMIT ${CANDIDATE_POOL}`,
      [ctx.categoryIds, ctx.embedding]
    )
    return this.rankAndTrim(result.rows, ctx)
  }

  // ─── Path 3: category + geo (embedding pending) ────────────────────────────
  private async categoryGeo(ctx: RequestContext): Promise<Vendor[]> {
    for (const tier of searchTiers(ctx.lat!, ctx.lng!)) {
      const col = resolutionColumn(tier.resolution)

      const result = await query<Vendor>(
        `SELECT DISTINCT v.*
         FROM vendors v
         JOIN vendor_categories vc ON vc.vendor_id = v.id
         WHERE vc.category_id = ANY($1::uuid[])
           AND v.${col} = ANY($2::text[])
           AND v.is_kyc_verified = true
           AND NOT EXISTS (
             SELECT 1 FROM users u WHERE u.id = v.user_id AND u.is_banned = true
           )
           ${this.availabilityClause()}
         ORDER BY v.is_priority DESC, v.rating DESC, v.completed_jobs DESC
         LIMIT ${CANDIDATE_POOL}`,
        [ctx.categoryIds, tier.cells]
      )

      if (result.rows.length >= MIN_VENDORS_THRESHOLD) {
        return this.rankAndTrim(result.rows, ctx)
      }
      if (result.rows.length > 0) continue
    }
    return []
  }

  // ─── Path 4: category only ─────────────────────────────────────────────────
  private async categoryOnly(categoryIds: string[]): Promise<Vendor[]> {
    const result = await query<Vendor>(
      `SELECT DISTINCT v.*
       FROM vendors v
       JOIN vendor_categories vc ON vc.vendor_id = v.id
       WHERE vc.category_id = ANY($1::uuid[])
         AND v.is_kyc_verified = true
         AND NOT EXISTS (
           SELECT 1 FROM users u WHERE u.id = v.user_id AND u.is_banned = true
         )
       ORDER BY v.is_priority DESC, v.rating DESC, v.completed_jobs DESC
       LIMIT ${CANDIDATE_POOL}`,
      [categoryIds]
    )
    return this.rankAndTrim(result.rows, { lat: null, lng: null })
  }

  // ─── Path 5: pure semantic (category unresolved) ───────────────────────────
  private async vectorOnly(embedding: string): Promise<Vendor[]> {
    const result = await query<Vendor>(
      `SELECT v.*, 1 - (v.embedding <=> $1::vector) AS match_score
       FROM vendors v
       WHERE v.embedding IS NOT NULL
         AND v.is_kyc_verified = true
         AND NOT EXISTS (
           SELECT 1 FROM users u WHERE u.id = v.user_id AND u.is_banned = true
         )
       ORDER BY match_score DESC
       LIMIT ${CANDIDATE_POOL}`,
      [embedding]
    )
    // Filter BEFORE ranking: a weak semantic match must not be rescued to the
    // top by being nearby. With no resolved category, similarity is the only
    // evidence the vendor can do the job at all.
    const confident = result.rows.filter(
      (r) => Number((r as unknown as { match_score: number }).match_score) > 0.55
    )
    return this.rankAndTrim(confident, { lat: null, lng: null })
  }

  // ─── Path 6: legacy raw tag overlap ────────────────────────────────────────
  private async legacyTagMatch(tags: string[]): Promise<Vendor[]> {
    const result = await query<Vendor>(
      `SELECT v.* FROM vendors v
       WHERE v.category_tags && $1
         AND v.is_kyc_verified = true
         AND NOT EXISTS (
           SELECT 1 FROM users u WHERE u.id = v.user_id AND u.is_banned = true
         )
       ORDER BY v.rating DESC
       LIMIT ${CANDIDATE_POOL}`,
      [tags]
    )
    return this.rankAndTrim(result.rows, { lat: null, lng: null })
  }

  // ─── Rematch with a wider net, excluding vendors who already passed ────────
  async rematch(requestId: string, attempt: number): Promise<Vendor[]> {
    const ctx = await this.loadContext(requestId)
    if (!ctx) return []

    const excluded = await query<{ vendor_id: string }>(
      `SELECT vendor_id FROM request_responses
       WHERE request_id = $1 AND status IN ('declined','missed')`,
      [requestId]
    )
    const excludeIds = excluded.rows.map((r) => r.vendor_id)

    // Widen: skip to a later H3 tier based on attempt number
    const tiers = [...searchTiers(ctx.lat ?? 17.4, ctx.lng ?? 78.4)]
    const tier = tiers[Math.min(attempt + 1, tiers.length - 1)]
    const col = resolutionColumn(tier.resolution)

    const useGeo = ctx.lat !== null && ctx.lng !== null
    const useCategories = ctx.categoryIds.length > 0

    if (!useCategories) return []

    const params: unknown[] = [ctx.categoryIds]
    let paramIdx = 2
    let geoClause = ''
    let excludeClause = ''
    let orderClause = 'v.rating DESC'

    if (useGeo) {
      geoClause = `AND v.${col} = ANY($${paramIdx}::text[])`
      params.push(tier.cells)
      paramIdx++
    }

    if (ctx.embedding) {
      orderClause = `v.embedding <=> $${paramIdx}::vector`
      params.push(ctx.embedding)
      paramIdx++
    }

    if (excludeIds.length > 0) {
      excludeClause = `AND v.id != ALL($${paramIdx}::uuid[])`
      params.push(excludeIds)
    }

    const result = await query<Vendor>(
      `SELECT DISTINCT v.*
       FROM vendors v
       JOIN vendor_categories vc ON vc.vendor_id = v.id
       WHERE vc.category_id = ANY($1::uuid[])
         ${geoClause}
         ${excludeClause}
         AND v.is_kyc_verified = true
         AND NOT EXISTS (
           SELECT 1 FROM users u WHERE u.id = v.user_id AND u.is_banned = true
         )
       ORDER BY v.is_priority DESC, ${orderClause}
       LIMIT ${CANDIDATE_POOL}`,
      params
    )

    logger.info(
      { requestId, attempt, tier: tier.label, pool: result.rows.length },
      'Rematch with widened radius'
    )

    // MUST rank and trim, exactly like every other path.
    //
    // The candidate pool was widened from 5 to 30 so ranking has real choices.
    // Returning that pool raw here would notify thirty vendors instead of
    // five — the caller (expiry.worker) push-notifies everything it gets
    // back, so an unranked return turns a rematch into spam.
    return this.rankAndTrim(result.rows, ctx)
  }

  // ─── Load all matching signals for a request ───────────────────────────────
  private async loadContext(requestId: string): Promise<RequestContext | null> {
    const result = await query<{
      id: string
      embedding: string | null
      lat: number | null
      lng: number | null
      category_ids: string[] | null
    }>(
      `SELECT r.id, r.embedding, r.lat, r.lng,
              ARRAY_AGG(rc.category_id) FILTER (WHERE rc.category_id IS NOT NULL)
                AS category_ids
       FROM requests r
       LEFT JOIN request_categories rc ON rc.request_id = r.id
       WHERE r.id = $1
       GROUP BY r.id, r.embedding, r.lat, r.lng`,
      [requestId]
    )

    const row = result.rows[0]
    if (!row) return null

    return {
      id: row.id,
      embedding: row.embedding,
      lat: row.lat,
      lng: row.lng,
      categoryIds: row.category_ids ?? [],
    }
  }

  /**
   * Availability filter — only match vendors working right now (IST).
   * Vendors with no availability rows are treated as always available,
   * so this never silently excludes someone who skipped that step.
   */

  // ═══════════════════════════════════════════════════════════════════════════
  // RANKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Enrich the candidate pool with ranking signals and return the best few.
   *
   * Every tier funnels through here, so the ordering rule lives in exactly one
   * place. The tiers decide WHO is eligible; this decides who is best.
   *
   * One query for the whole pool rather than one per vendor — at 30 candidates
   * a per-vendor lookup would be 30 round-trips on the matching hot path.
   */
  private async rankAndTrim(
    rows: Array<Vendor & { match_score?: number }>,
    // Only the coordinates are used, so the tiers that have no request
    // context can pass nulls. Distance then becomes an absent signal and
    // renormalisation redistributes its weight — which is exactly the
    // behaviour we want, rather than scoring everyone 0 for distance.
    ctx: { lat: number | null; lng: number | null }
  ): Promise<Vendor[]> {
    if (rows.length === 0) return []

    // A single candidate cannot be reordered, so skip the work entirely.
    if (rows.length === 1) return rows

    const ids = rows.map((r) => r.id)

    const signals = await this.loadRankingSignals(ids)
    const config = await loadRankingWeights()

    const rankable: RankableVendor[] = rows.map((r) => {
      const s = signals.get(r.id)
      const raw = r as unknown as Record<string, unknown>

      // Vendor rows come straight from `SELECT v.*`, so the geo columns are
      // snake_case and untyped here.
      const vLat = typeof raw.lat === 'number' ? raw.lat : null
      const vLng = typeof raw.lng === 'number' ? raw.lng : null

      const distanceKm =
        ctx.lat !== null && ctx.lng !== null && vLat !== null && vLng !== null
          ? haversineKm(ctx.lat, ctx.lng, vLat, vLng)
          : null

      return {
        id: r.id,
        isPriority: Boolean(raw.is_priority),
        semanticScore:
          typeof r.match_score === 'number' ? r.match_score : null,
        distanceKm,
        serviceRadiusKm:
          typeof raw.service_radius_km === 'number' ? raw.service_radius_km : null,
        rating: s?.rating ?? null,
        ratingCount: s?.ratingCount ?? 0,
        responseRate: s?.responseRate ?? null,
        responseCount: s?.responseCount ?? 0,
        completedJobs: s?.completedJobs ?? 0,
        noShowCount: s?.noShowCount ?? 0,
        activeCommitments: s?.activeCommitments ?? 0,
        priceRupees: null, // no vendor price list exists pre-quote
      }
    })

    const ranked = rankVendors(rankable, toRankingOptions(config))
    const byId = new Map(rows.map((r) => [r.id, r]))

    const top = ranked.slice(0, RESULT_LIMIT)

    logger.info(
      {
        pool: rows.length,
        returned: top.length,
        top: top.map((r) => ({
          id: r.id.slice(0, 8),
          score: r.score,
          // Which signals decided it — makes a surprising ranking explainable
          // without re-running anything.
          via: Object.keys(r.contributions),
          missing: r.missing,
        })),
      },
      'Vendors ranked'
    )

    return top.map((r) => byId.get(r.id)!).filter(Boolean)
  }

  /**
   * Ranking signals for a set of vendors, in one query.
   *
   * Reads `vendor_response_stats` (a view added by migration 013) rather than
   * `vendors.response_rate`, which has never been written to by anything and
   * is 0 for every row in the system.
   *
   * Degrades to an empty map on failure. Every signal is optional to the
   * ranker, so losing them means ranking on semantics and distance alone —
   * which is still no worse than the ordering this replaced.
   */
  private async loadRankingSignals(vendorIds: string[]): Promise<
    Map<
      string,
      {
        rating: number | null
        ratingCount: number
        responseRate: number | null
        responseCount: number
        completedJobs: number
        noShowCount: number
        activeCommitments: number
      }
    >
  > {
    const out = new Map<string, ReturnType<typeof Object> & never>() as Map<
      string,
      {
        rating: number | null
        ratingCount: number
        responseRate: number | null
        responseCount: number
        completedJobs: number
        noShowCount: number
        activeCommitments: number
      }
    >

    try {
      const { rows } = await query<{
        id: string
        rating: string | null
        rating_count: string
        response_rate: string | null
        notified_count: string | null
        completed_jobs: number
        no_show_count: number
        active_commitments: string
      }>(
        `SELECT v.id,
                v.rating,
                v.completed_jobs,
                COALESCE(v.no_show_count, 0) AS no_show_count,
                (SELECT COUNT(*) FROM reviews rv WHERE rv.vendor_id = v.id)
                  AS rating_count,
                vrs.response_rate,
                vrs.notified_count,
                (SELECT COUNT(*)
                   FROM vendor_commitments vc
                  WHERE vc.vendor_id = v.id
                    AND vc.status = 'active'
                    AND vc.blocked_period && tstzrange(now(), now() + interval '24 hours'))
                  AS active_commitments
           FROM vendors v
           LEFT JOIN vendor_response_stats vrs ON vrs.vendor_id = v.id
          WHERE v.id = ANY($1::uuid[])`,
        [vendorIds]
      )

      for (const r of rows) {
        out.set(r.id, {
          rating: r.rating === null ? null : Number(r.rating),
          ratingCount: Number(r.rating_count ?? 0),
          responseRate: r.response_rate === null ? null : Number(r.response_rate),
          responseCount: Number(r.notified_count ?? 0),
          completedJobs: Number(r.completed_jobs ?? 0),
          noShowCount: Number(r.no_show_count ?? 0),
          activeCommitments: Number(r.active_commitments ?? 0),
        })
      }
    } catch (err) {
      // Migration 013 not applied yet, most likely.
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'Ranking signals unavailable — ranking on semantics and distance only'
      )
    }

    return out
  }

  private availabilityClause(): string {
    return `AND (
      NOT EXISTS (SELECT 1 FROM vendor_availability va WHERE va.vendor_id = v.id)
      OR EXISTS (
        SELECT 1 FROM vendor_availability va
        WHERE va.vendor_id = v.id
          AND va.day_of_week = EXTRACT(DOW FROM (now() AT TIME ZONE 'Asia/Kolkata'))
          AND (now() AT TIME ZONE 'Asia/Kolkata')::time
              BETWEEN va.start_time AND va.end_time
      )
    )`
  }
}
