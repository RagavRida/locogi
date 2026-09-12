/**
 * Ranking vendors for a request.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Matching used to order by `is_priority DESC, match_score DESC, rating DESC`
 * — pure embedding similarity with rating as a tie-break. Semantic similarity
 * is a good signal for "can this vendor do the job", and a poor one for
 * "should we send this job to them": it says nothing about whether they are
 * ten minutes away or across the city, whether they answer their requests, or
 * whether they turn up.
 *
 * This module adds those, without discarding the semantic signal. It is a
 * pure function — no database, no clock beyond an injected `now` — so the
 * weighting can be tested exhaustively and compared against the old ordering.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THING THAT MAKES THIS CORRECT: RENORMALISATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Signals go missing constantly. A request with no location has no distance.
 * A brand-new vendor has no reviews. An embedding may still be generating.
 *
 * The naive implementation scores a missing signal as 0 and multiplies by its
 * weight. That does not mean "unknown" — it means "worst possible", and it
 * punishes a vendor for data WE failed to collect. A new vendor with no
 * reviews would sit permanently below a mediocre one with three.
 *
 * So a missing signal is dropped and the remaining weights are renormalised
 * to sum to 1. A vendor is only ever compared on what is actually known about
 * them, and `contributions` records which signals took part so a ranking can
 * be explained after the fact.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SMALL-SAMPLE RATINGS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One 5-star review is not better than fifty averaging 4.8, but a raw mean
 * says it is. Ratings are shrunk toward a prior, so confidence has to be
 * earned before a high average counts for much. Same for completion rate.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the ranker knows about one candidate. `null` means unknown. */
export interface RankableVendor {
  id: string

  /** Paid or otherwise privileged placement. Handled outside the score. */
  isPriority: boolean

  /** Cosine similarity from pgvector, already 0..1. Null if no embedding. */
  semanticScore: number | null

  /** Straight-line km to the job. Null when the request has no location. */
  distanceKm: number | null

  /** How far this vendor says they will travel. */
  serviceRadiusKm: number | null

  /** Mean review score, 0..5. Null when never reviewed. */
  rating: number | null
  /** How many reviews that mean is based on. */
  ratingCount: number

  /**
   * Share of notified requests this vendor actually answered, 0..1.
   *
   * Derived at query time from `request_responses`, NOT read from
   * `vendors.response_rate` — that column exists but nothing in the codebase
   * has ever written to it, so it is permanently 0. Weighting a dead column
   * produces a ranking factor that looks active and contributes nothing.
   */
  responseRate: number | null
  /** How many requests that share is based on. */
  responseCount: number

  completedJobs: number
  noShowCount: number

  /** Overlapping commitments in the requested window. */
  activeCommitments: number

  /** Quoted or listed price in rupees, when the vertical has one. */
  priceRupees: number | null
}

export interface RankingWeights {
  semantic: number
  distance: number
  availability: number
  rating: number
  responseRate: number
  completionRate: number
  price: number
}

/**
 * Starting weights.
 *
 * These are a considered guess, not a measurement — nothing has run against
 * real traffic yet. They live in the `ranking_weights` table so they can be
 * tuned without a deploy, and this constant is only the fallback used before
 * that table is populated (or if it cannot be read).
 *
 * Semantic stays the largest single weight because it is the only signal that
 * speaks to whether the vendor can do the job at all; the rest are about
 * whether they are a good choice among those who can.
 */
export const DEFAULT_WEIGHTS: RankingWeights = {
  semantic: 0.3,
  distance: 0.25,
  availability: 0.15,
  rating: 0.1,
  responseRate: 0.1,
  completionRate: 0.1,
  price: 0.0, // opt-in: most verticals here have no price before the quote
}

export interface RankingOptions {
  weights?: RankingWeights
  /**
   * Distance at which the distance score halves. Smaller values punish travel
   * harder. 3km suits dense Hyderabad neighbourhoods.
   */
  distanceHalfLifeKm?: number
  /** Commitments at which a vendor counts as fully booked. */
  capacityPerWindow?: number
  /** Cheapest and dearest in the candidate set, for relative price scoring. */
  priceRange?: { min: number; max: number }
}

export interface RankedVendor {
  id: string
  score: number
  isPriority: boolean
  /** Which signals took part, and what each contributed. Explains the rank. */
  contributions: Partial<Record<keyof RankingWeights, number>>
  /** Signals that were unknown for this vendor and therefore excluded. */
  missing: Array<keyof RankingWeights>
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal scoring — each returns 0..1, or null when unknown
// ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Distance → 0..1, decaying smoothly.
 *
 * `1 / (1 + d/λ)` rather than a linear cutoff: a cliff at the service radius
 * would make 9.9km and 10.1km wildly different, which is not how anyone
 * thinks about travel. Beyond the vendor's own stated radius the score is
 * halved again — they said they would not go that far, so they are ranked
 * down rather than excluded (the H3 tiers already handle exclusion).
 */
export function scoreDistance(
  distanceKm: number | null,
  serviceRadiusKm: number | null,
  halfLifeKm: number
): number | null {
  if (distanceKm === null) return null
  if (distanceKm < 0) return null

  const base = 1 / (1 + distanceKm / halfLifeKm)

  if (serviceRadiusKm !== null && distanceKm > serviceRadiusKm) {
    return clamp01(base * 0.5)
  }
  return clamp01(base)
}

/**
 * Rating → 0..1, shrunk toward a prior.
 *
 * `(mean·n + prior·m) / (n + m)`. With m = 5, a vendor needs about five
 * reviews before their average mostly speaks for itself. Without this, one
 * enthusiastic friend outranks a year of good work.
 */
export function scoreRating(
  rating: number | null,
  count: number,
  prior = 3.5,
  priorWeight = 5
): number | null {
  if (rating === null || count <= 0) return null
  const shrunk = (rating * count + prior * priorWeight) / (count + priorWeight)
  return clamp01(shrunk / 5)
}

/** Response rate, shrunk the same way — three replies is not a track record. */
export function scoreResponseRate(
  rate: number | null,
  count: number,
  prior = 0.5,
  priorWeight = 3
): number | null {
  if (rate === null || count <= 0) return null
  const shrunk = (rate * count + prior * priorWeight) / (count + priorWeight)
  return clamp01(shrunk)
}

/**
 * Completion rate from jobs done versus no-shows.
 *
 * Unknown for a vendor who has never been booked — deliberately not scored 1
 * (which would flatter them) or 0 (which would bury them). Unknown is
 * unknown, and renormalisation handles it.
 */
export function scoreCompletionRate(
  completedJobs: number,
  noShowCount: number,
  priorWeight = 3
): number | null {
  const total = completedJobs + noShowCount
  if (total <= 0) return null
  const shrunk = (completedJobs + 0.8 * priorWeight) / (total + priorWeight)
  return clamp01(shrunk)
}

/**
 * Availability as a graded load signal.
 *
 * `vendor_availability` already acts as a hard in/out filter in the matching
 * SQL and stays there. This is the softer question that filter cannot answer:
 * among vendors who COULD take the job, who is least buried? A vendor with
 * four overlapping commitments will be slower and likelier to cancel than one
 * with none.
 */
export function scoreAvailability(
  activeCommitments: number,
  capacity: number
): number | null {
  if (capacity <= 0) return null
  return clamp01(1 - activeCommitments / capacity)
}

/**
 * Price, relative to the other candidates.
 *
 * Only meaningful when several candidates have quoted, so it returns null for
 * a single-price set — "cheapest of one" is not information. Cheaper scores
 * higher, but the weight defaults to 0: sorting local services by price alone
 * is how a marketplace fills up with people who cut corners.
 */
export function scorePrice(
  priceRupees: number | null,
  range: { min: number; max: number } | undefined
): number | null {
  if (priceRupees === null || !range) return null
  if (range.max <= range.min) return null
  return clamp01(1 - (priceRupees - range.min) / (range.max - range.min))
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring one vendor
// ─────────────────────────────────────────────────────────────────────────────

export function scoreVendor(
  vendor: RankableVendor,
  options: RankingOptions = {}
): RankedVendor {
  const weights = options.weights ?? DEFAULT_WEIGHTS
  const halfLife = options.distanceHalfLifeKm ?? 3
  const capacity = options.capacityPerWindow ?? 4

  const signals: Record<keyof RankingWeights, number | null> = {
    semantic: vendor.semanticScore === null ? null : clamp01(vendor.semanticScore),
    distance: scoreDistance(vendor.distanceKm, vendor.serviceRadiusKm, halfLife),
    availability: scoreAvailability(vendor.activeCommitments, capacity),
    rating: scoreRating(vendor.rating, vendor.ratingCount),
    responseRate: scoreResponseRate(vendor.responseRate, vendor.responseCount),
    completionRate: scoreCompletionRate(vendor.completedJobs, vendor.noShowCount),
    price: scorePrice(vendor.priceRupees, options.priceRange),
  }

  // ── Renormalise over the signals we actually have ────────────────────────
  const present = (Object.keys(signals) as Array<keyof RankingWeights>).filter(
    (k) => signals[k] !== null && weights[k] > 0
  )
  const missing = (Object.keys(signals) as Array<keyof RankingWeights>).filter(
    (k) => signals[k] === null && weights[k] > 0
  )

  const totalWeight = present.reduce((sum, k) => sum + weights[k], 0)

  // Nothing known at all. Score 0 rather than dividing by zero; every such
  // vendor ties, and `is_priority` plus the stable sort below decide order.
  if (totalWeight === 0) {
    return { id: vendor.id, score: 0, isPriority: vendor.isPriority, contributions: {}, missing }
  }

  const contributions: Partial<Record<keyof RankingWeights, number>> = {}
  let score = 0

  for (const k of present) {
    const contribution = (weights[k] / totalWeight) * signals[k]!
    contributions[k] = Number(contribution.toFixed(4))
    score += contribution
  }

  return {
    id: vendor.id,
    score: Number(clamp01(score).toFixed(4)),
    isPriority: vendor.isPriority,
    contributions,
    missing,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking a set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rank candidates, best first.
 *
 * ── Why is_priority is NOT folded into the score ──────────────────────────
 *
 * The previous ordering put `is_priority DESC` ahead of everything, so a
 * priority vendor always outranked a non-priority one. That is a commercial
 * commitment, not a quality heuristic, and turning it into a weighted term
 * would mean a priority vendor could silently lose their placement because a
 * competitor is nearer. Quietly breaking a paid guarantee is worse than a
 * slightly less optimal ordering, so priority stays a hard partition and the
 * ranking runs *within* each group.
 *
 * The sort is stable on ties (falling back to id), so the same inputs always
 * produce the same order — a ranking that reshuffles between identical calls
 * is impossible to debug or test.
 */
export function rankVendors(
  vendors: RankableVendor[],
  options: RankingOptions = {}
): RankedVendor[] {
  const opts: RankingOptions = { ...options }

  // Derive the price range from the candidate set when not supplied, so
  // relative pricing needs no caller ceremony.
  if (!opts.priceRange) {
    const prices = vendors
      .map((v) => v.priceRupees)
      .filter((p): p is number => p !== null && p > 0)
    if (prices.length >= 2) {
      opts.priceRange = { min: Math.min(...prices), max: Math.max(...prices) }
    }
  }

  return vendors
    .map((v) => scoreVendor(v, opts))
    .sort((a, b) => {
      if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1
      if (b.score !== a.score) return b.score - a.score
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

/** Validate weights loaded from the database before trusting them. */
export function isValidWeights(value: unknown): value is RankingWeights {
  if (typeof value !== 'object' || value === null) return false
  const keys: Array<keyof RankingWeights> = [
    'semantic',
    'distance',
    'availability',
    'rating',
    'responseRate',
    'completionRate',
    'price',
  ]
  return keys.every((k) => {
    const n = (value as Record<string, unknown>)[k]
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  })
}
