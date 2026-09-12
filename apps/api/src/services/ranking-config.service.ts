/**
 * Loading ranking weights from the database.
 *
 * Weights are tunable at runtime (see migration 013) because getting the
 * balance right needs real traffic and repeated adjustment, and anything
 * requiring a deploy gets tuned once and then never again.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FAILING TO THE CODE DEFAULTS, NOT TO NOTHING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every failure path here returns `DEFAULT_WEIGHTS`: table missing (migration
 * not yet applied), row missing, database unreachable, or values that fail
 * validation. A ranker that fell back to "no weighting" would return vendors
 * in whatever order Postgres happened to produce, which is worse than a
 * slightly stale set of weights and much harder to notice.
 *
 * Cached for a minute so ranking does not add a query per request, and so an
 * operator changing a weight sees it take effect without a restart.
 */

import { query } from '../lib/db'
import { logger } from '../lib/logger'
import {
  DEFAULT_WEIGHTS,
  isValidWeights,
  type RankingWeights,
  type RankingOptions,
} from '../domain/vendor-ranking'

export interface RankingConfig {
  weights: RankingWeights
  distanceHalfLifeKm: number
  capacityPerWindow: number
}

const FALLBACK: RankingConfig = {
  weights: DEFAULT_WEIGHTS,
  distanceHalfLifeKm: 3,
  capacityPerWindow: 4,
}

const CACHE_TTL_MS = 60_000

let cache: { value: RankingConfig; at: number; profile: string } | null = null

/** Drop the cache so a weight change takes effect immediately. */
export function invalidateRankingConfig(): void {
  cache = null
}

export async function loadRankingWeights(
  profile = 'default'
): Promise<RankingConfig> {
  if (cache && cache.profile === profile && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value
  }

  try {
    const { rows } = await query<{
      semantic: string
      distance: string
      availability: string
      rating: string
      response_rate: string
      completion_rate: string
      price: string
      distance_half_life_km: string
      capacity_per_window: number
    }>(
      `SELECT semantic, distance, availability, rating, response_rate,
              completion_rate, price, distance_half_life_km, capacity_per_window
         FROM ranking_weights
        WHERE profile = $1`,
      [profile]
    )

    const row = rows[0]
    if (!row) {
      // Not an error worth shouting about on every request — the default
      // profile simply has not been inserted yet.
      logger.debug({ profile }, 'No ranking profile row; using code defaults')
      return FALLBACK
    }

    // Postgres numerics arrive as strings. Parsing before validation matters:
    // isValidWeights checks `typeof === 'number'`, so unparsed strings would
    // fail validation and silently drop us to defaults with real weights in
    // the table.
    const weights: RankingWeights = {
      semantic: Number(row.semantic),
      distance: Number(row.distance),
      availability: Number(row.availability),
      rating: Number(row.rating),
      responseRate: Number(row.response_rate),
      completionRate: Number(row.completion_rate),
      price: Number(row.price),
    }

    if (!isValidWeights(weights)) {
      // The CHECK constraints should make this unreachable. If it happens,
      // something wrote around them and the defaults are the safe answer.
      logger.error({ profile, weights }, 'Ranking weights failed validation; using defaults')
      return FALLBACK
    }

    const config: RankingConfig = {
      weights,
      distanceHalfLifeKm: Number(row.distance_half_life_km) || FALLBACK.distanceHalfLifeKm,
      capacityPerWindow: row.capacity_per_window || FALLBACK.capacityPerWindow,
    }

    cache = { value: config, at: Date.now(), profile }
    return config
  } catch (err) {
    // Most likely the migration has not run. Rank with the code defaults
    // rather than refusing to rank.
    logger.warn(
      { err: err instanceof Error ? err.message : 'unknown' },
      'Could not read ranking_weights; using code defaults'
    )
    return FALLBACK
  }
}

/** Shape the config for the pure ranker. */
export function toRankingOptions(config: RankingConfig): RankingOptions {
  return {
    weights: config.weights,
    distanceHalfLifeKm: config.distanceHalfLifeKm,
    capacityPerWindow: config.capacityPerWindow,
  }
}
