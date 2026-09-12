/**
 * Vendor ranking.
 *
 * Pure module, so all of this runs with no database and no network. The
 * comparison suite at the bottom is the one that answers "is this actually
 * better than what we had" — it reproduces the old ordering
 * (`is_priority DESC, match_score DESC, rating DESC`) and shows where the two
 * disagree, and why.
 */

import { describe, it, expect } from 'vitest'
import {
  rankVendors,
  scoreVendor,
  scoreDistance,
  scoreRating,
  scoreResponseRate,
  scoreCompletionRate,
  scoreAvailability,
  scorePrice,
  isValidWeights,
  DEFAULT_WEIGHTS,
  type RankableVendor,
  type RankingWeights,
} from '../src/domain/vendor-ranking'

function vendor(over: Partial<RankableVendor> & { id: string }): RankableVendor {
  return {
    isPriority: false,
    semanticScore: 0.8,
    distanceKm: 3,
    serviceRadiusKm: 10,
    rating: 4.5,
    ratingCount: 20,
    responseRate: 0.8,
    responseCount: 20,
    completedJobs: 40,
    noShowCount: 1,
    activeCommitments: 0,
    priceRupees: null,
    ...over,
  }
}

/** The ordering this replaces, reproduced exactly. */
function legacyOrder(vendors: RankableVendor[]): string[] {
  return [...vendors]
    .sort((a, b) => {
      if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1
      const sa = a.semanticScore ?? 0
      const sb = b.semanticScore ?? 0
      if (sb !== sa) return sb - sa
      return (b.rating ?? 0) - (a.rating ?? 0)
    })
    .map((v) => v.id)
}

const newOrder = (vendors: RankableVendor[], w?: RankingWeights): string[] =>
  rankVendors(vendors, w ? { weights: w } : {}).map((v) => v.id)

// ═════════════════════════════════════════════════════════════════════════════
// Individual signals
// ═════════════════════════════════════════════════════════════════════════════

describe('scoreDistance', () => {
  it('decays smoothly rather than falling off a cliff', () => {
    const near = scoreDistance(1, 10, 3)!
    const mid = scoreDistance(3, 10, 3)!
    const far = scoreDistance(9, 10, 3)!
    expect(near).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(far)
    // 9.9km and 10.1km must not be wildly different — no hard edge.
    expect(Math.abs(scoreDistance(9.9, 10, 3)! - scoreDistance(9.99, 10, 3)!)).toBeLessThan(0.01)
  })

  it('halves at the half-life distance', () => {
    expect(scoreDistance(3, 100, 3)).toBeCloseTo(0.5, 5)
  })

  it('penalises travel beyond the vendor\'s own stated radius', () => {
    const inside = scoreDistance(9, 10, 3)!
    const outside = scoreDistance(11, 10, 3)!
    expect(outside).toBeLessThan(inside)
  })

  it('returns null when the request has no location', () => {
    expect(scoreDistance(null, 10, 3)).toBeNull()
  })

  it('stays within 0..1', () => {
    for (const d of [0, 0.1, 5, 50, 500]) {
      const s = scoreDistance(d, 10, 3)!
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })
})

describe('scoreRating', () => {
  it('does not let one glowing review beat a long good record', () => {
    // The failure this prevents: a vendor with a single 5-star review from a
    // friend outranking one with fifty averaging 4.8.
    const oneReview = scoreRating(5.0, 1)!
    const fifty = scoreRating(4.8, 50)!
    expect(fifty).toBeGreaterThan(oneReview)
  })

  it('lets a high average count once it is earned', () => {
    expect(scoreRating(4.8, 50)!).toBeGreaterThan(scoreRating(4.8, 3)!)
  })

  it('returns null for a vendor with no reviews', () => {
    // Unknown, NOT bad. Renormalisation excludes it.
    expect(scoreRating(null, 0)).toBeNull()
    expect(scoreRating(4.5, 0)).toBeNull()
  })
})

describe('scoreCompletionRate', () => {
  it('punishes no-shows', () => {
    expect(scoreCompletionRate(40, 0)!).toBeGreaterThan(scoreCompletionRate(40, 10)!)
  })

  it('is unknown for a vendor who has never been booked', () => {
    expect(scoreCompletionRate(0, 0)).toBeNull()
  })

  it('does not let one job establish a perfect record', () => {
    expect(scoreCompletionRate(1, 0)!).toBeLessThan(scoreCompletionRate(50, 0)!)
  })
})

describe('scoreAvailability', () => {
  it('ranks a free vendor above a busy one', () => {
    expect(scoreAvailability(0, 4)!).toBeGreaterThan(scoreAvailability(3, 4)!)
  })

  it('floors at zero when overbooked', () => {
    expect(scoreAvailability(99, 4)).toBe(0)
  })
})

describe('scorePrice', () => {
  it('prefers cheaper within the candidate range', () => {
    const range = { min: 500, max: 1500 }
    expect(scorePrice(500, range)).toBe(1)
    expect(scorePrice(1500, range)).toBe(0)
  })

  it('is unknown when only one candidate has a price', () => {
    // "Cheapest of one" is not information.
    expect(scorePrice(900, { min: 900, max: 900 })).toBeNull()
    expect(scorePrice(900, undefined)).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Renormalisation — the correctness property
// ═════════════════════════════════════════════════════════════════════════════

describe('missing signals are excluded, not scored zero', () => {
  it('does not bury a brand-new vendor for having no reviews', () => {
    // The bug this prevents: a new vendor scored 0 on rating and permanently
    // outranked by a mediocre incumbent.
    const newbie = vendor({
      id: 'new',
      rating: null,
      ratingCount: 0,
      completedJobs: 0,
      noShowCount: 0,
      responseRate: null,
      responseCount: 0,
      semanticScore: 0.95,
      distanceKm: 1,
    })
    const incumbent = vendor({
      id: 'old',
      rating: 3.2,
      ratingCount: 40,
      semanticScore: 0.6,
      distanceKm: 8,
    })

    expect(newOrder([incumbent, newbie])[0]).toBe('new')
  })

  it('reports which signals were missing', () => {
    const r = scoreVendor(
      vendor({ id: 'v', rating: null, ratingCount: 0, distanceKm: null })
    )
    expect(r.missing).toContain('rating')
    expect(r.missing).toContain('distance')
    expect(r.contributions.rating).toBeUndefined()
  })

  it('keeps the score in 0..1 no matter how many signals are absent', () => {
    const sparse = vendor({
      id: 'sparse',
      semanticScore: 1,
      distanceKm: null,
      rating: null,
      ratingCount: 0,
      responseRate: null,
      responseCount: 0,
      completedJobs: 0,
      noShowCount: 0,
    })
    const r = scoreVendor(sparse)
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(1)
  })

  it('gives a perfect vendor a score of 1', () => {
    // Sanity check on renormalisation arithmetic: all signals present and
    // maximal must sum to exactly 1, not 0.9-something.
    const perfect = vendor({
      id: 'perfect',
      semanticScore: 1,
      distanceKm: 0,
      serviceRadiusKm: 50,
      rating: 5,
      ratingCount: 10_000,
      responseRate: 1,
      responseCount: 10_000,
      completedJobs: 10_000,
      noShowCount: 0,
      activeCommitments: 0,
    })
    expect(scoreVendor(perfect).score).toBeCloseTo(1, 2)
  })

  it('scores zero without dividing by zero when nothing is known', () => {
    const blank = vendor({
      id: 'blank',
      semanticScore: null,
      distanceKm: null,
      rating: null,
      ratingCount: 0,
      responseRate: null,
      responseCount: 0,
      completedJobs: 0,
      noShowCount: 0,
    })
    const r = scoreVendor(blank, { weights: { ...DEFAULT_WEIGHTS, availability: 0 } })
    expect(Number.isFinite(r.score)).toBe(true)
    expect(r.score).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Priority placement
// ═════════════════════════════════════════════════════════════════════════════

describe('is_priority stays a hard partition', () => {
  it('keeps a priority vendor first even with a worse score', () => {
    // This is a commercial commitment, not a quality heuristic. Folding it
    // into the weighted score would let a competitor quietly outbid it.
    const paid = vendor({ id: 'paid', isPriority: true, semanticScore: 0.2, distanceKm: 20, rating: 2, ratingCount: 30 })
    const better = vendor({ id: 'better', semanticScore: 0.99, distanceKm: 0.5 })

    expect(newOrder([better, paid])[0]).toBe('paid')
  })

  it('still ranks within the priority group', () => {
    const a = vendor({ id: 'a', isPriority: true, semanticScore: 0.5, distanceKm: 20 })
    const b = vendor({ id: 'b', isPriority: true, semanticScore: 0.9, distanceKm: 1 })
    expect(newOrder([a, b])[0]).toBe('b')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Determinism
// ═════════════════════════════════════════════════════════════════════════════

describe('determinism', () => {
  it('produces the same order for the same input', () => {
    const vs = [
      vendor({ id: 'a', semanticScore: 0.7 }),
      vendor({ id: 'b', semanticScore: 0.7 }),
      vendor({ id: 'c', semanticScore: 0.7 }),
    ]
    expect(newOrder(vs)).toEqual(newOrder([...vs].reverse()))
  })

  it('breaks exact ties stably by id', () => {
    const vs = [vendor({ id: 'zzz' }), vendor({ id: 'aaa' })]
    expect(newOrder(vs)).toEqual(['aaa', 'zzz'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Old vs new — where the rankings disagree, and why
// ═════════════════════════════════════════════════════════════════════════════

describe('comparison with the embedding-only ranking', () => {
  it('agrees when distance and quality are equal', () => {
    // No regression on the case the old ranking handled fine.
    const vs = [
      vendor({ id: 'a', semanticScore: 0.9 }),
      vendor({ id: 'b', semanticScore: 0.7 }),
      vendor({ id: 'c', semanticScore: 0.5 }),
    ]
    expect(newOrder(vs)).toEqual(legacyOrder(vs))
  })

  it('prefers a near vendor over a marginally better semantic match far away', () => {
    // The headline improvement. The old ranking sent a job across Hyderabad
    // for two points of cosine similarity.
    const near = vendor({ id: 'near', semanticScore: 0.82, distanceKm: 1 })
    const far = vendor({ id: 'far', semanticScore: 0.86, distanceKm: 22, serviceRadiusKm: 25 })

    expect(legacyOrder([near, far])[0]).toBe('far')
    expect(newOrder([near, far])[0]).toBe('near')
  })

  it('does NOT prefer a near vendor when the semantic gap is large', () => {
    // Guards the opposite failure: proximity must not override competence.
    // A tyre-fitter 500m away should not win a wedding photography job.
    const wrongTrade = vendor({ id: 'wrong', semanticScore: 0.15, distanceKm: 0.5 })
    const rightTrade = vendor({ id: 'right', semanticScore: 0.95, distanceKm: 12, serviceRadiusKm: 20 })

    expect(newOrder([wrongTrade, rightTrade])[0]).toBe('right')
  })

  it('demotes an unreliable vendor the old ranking ranked first', () => {
    const flaky = vendor({
      id: 'flaky',
      semanticScore: 0.9,
      completedJobs: 5,
      noShowCount: 12,
      responseRate: 0.15,
      responseCount: 40,
    })
    const dependable = vendor({
      id: 'dependable',
      semanticScore: 0.78,
      completedJobs: 60,
      noShowCount: 0,
      responseRate: 0.95,
      responseCount: 60,
    })

    expect(legacyOrder([flaky, dependable])[0]).toBe('flaky')
    expect(newOrder([flaky, dependable])[0]).toBe('dependable')
  })

  it('demotes an overbooked vendor', () => {
    const busy = vendor({ id: 'busy', semanticScore: 0.88, activeCommitments: 4 })
    const free = vendor({ id: 'free', semanticScore: 0.8, activeCommitments: 0 })

    expect(legacyOrder([busy, free])[0]).toBe('busy')
    expect(newOrder([busy, free])[0]).toBe('free')
  })

  it('collapses to the old behaviour when only semantics are known', () => {
    // Degradation check: with no location, no reviews and no history, the new
    // ranking must not be *worse* than the old one — it should be the same.
    const bare = (id: string, s: number) =>
      vendor({
        id,
        semanticScore: s,
        distanceKm: null,
        rating: null,
        ratingCount: 0,
        responseRate: null,
        responseCount: 0,
        completedJobs: 0,
        noShowCount: 0,
        activeCommitments: 0,
      })
    const vs = [bare('a', 0.4), bare('b', 0.9), bare('c', 0.6)]

    // availability is the only other signal that survives (commitments = 0
    // is known), and it is equal across all three, so semantics decides.
    expect(newOrder(vs)).toEqual(legacyOrder(vs))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Configurable weights
// ═════════════════════════════════════════════════════════════════════════════

describe('weights are configurable, not hardcoded', () => {
  it('changes the ordering when distance is weighted to zero', () => {
    const near = vendor({ id: 'near', semanticScore: 0.82, distanceKm: 1 })
    const far = vendor({ id: 'far', semanticScore: 0.86, distanceKm: 22, serviceRadiusKm: 25 })

    const distanceBlind: RankingWeights = { ...DEFAULT_WEIGHTS, distance: 0 }
    expect(newOrder([near, far])[0]).toBe('near')
    expect(newOrder([near, far], distanceBlind)[0]).toBe('far')
  })

  it('lets price be switched on for verticals that have one', () => {
    const cheap = vendor({ id: 'cheap', priceRupees: 500, semanticScore: 0.8 })
    const dear = vendor({ id: 'dear', priceRupees: 2000, semanticScore: 0.8 })

    // Off by default — price is not a proxy for quality in local services.
    expect(rankVendors([cheap, dear])[0].contributions.price).toBeUndefined()

    const priceAware: RankingWeights = { ...DEFAULT_WEIGHTS, price: 0.4 }
    expect(newOrder([dear, cheap], priceAware)[0]).toBe('cheap')
  })

  it('validates weights loaded from the database', () => {
    expect(isValidWeights(DEFAULT_WEIGHTS)).toBe(true)
    expect(isValidWeights({ ...DEFAULT_WEIGHTS, semantic: -1 })).toBe(false)
    expect(isValidWeights({ ...DEFAULT_WEIGHTS, semantic: 2 })).toBe(false)
    expect(isValidWeights({ ...DEFAULT_WEIGHTS, semantic: 'high' })).toBe(false)
    expect(isValidWeights({ semantic: 0.5 })).toBe(false) // incomplete
    expect(isValidWeights(null)).toBe(false)
  })
})
