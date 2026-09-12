/**
 * KnowledgeService — the agent's mutable belief store.
 *
 * Replaces every hardcoded lookup with knowledge that has provenance,
 * confidence, and an evidence trail. Three operations matter:
 *
 *   resolve(domain, subject, key)  → what do we currently believe?
 *   learn(...)                     → record evidence, adjust confidence
 *   recordOutcome(...)             → did acting on this belief work?
 *
 * Confidence model
 * ────────────────
 * Bayesian-ish, deliberately simple so it stays debuggable:
 *
 *   • First observation of a fact → confidence 0.5
 *   • Each corroborating observation → confidence moves toward 1.0 by
 *     (1 - confidence) * 0.25, so it approaches but never reaches certainty
 *   • Each contradicting observation → confidence drops by 0.15
 *   • Below 0.25 → status flips to 'needs_review'
 *   • Source tier always wins over confidence: an admin assertion at 0.5
 *     beats a learned belief at 0.95, because a human said so on purpose
 *
 * Why not a real Bayesian update? Because someone has to debug this at 2am
 * when the agent starts asking restaurants for medical registration numbers.
 * A legible heuristic beats a correct-but-opaque one here.
 */

import { query } from '../lib/db'
import { cacheGet, cacheSet, redis } from '../lib/redis'
import { logger } from '../lib/logger'

const CACHE_TTL_SECONDS = 300
const NEEDS_REVIEW_THRESHOLD = 0.25
const CORROBORATION_RATE = 0.25
const CONTRADICTION_PENALTY = 0.15

export type KnowledgeSource = 'bootstrap' | 'learned' | 'agent' | 'admin' | 'vendor'

export interface Belief<T = unknown> {
  value: T
  source: KnowledgeSource
  confidence: number
  evidenceCount: number
  reasoning: string | null
  /** True when this is only a seeded prior — the agent hasn't learned yet. */
  isBootstrap: boolean
}

export class KnowledgeService {

  // ─── What do we believe? ────────────────────────────────────────────────────
  async resolve<T = unknown>(
    domain: string,
    subject: string,
    key: string
  ): Promise<Belief<T> | null> {
    const cacheKey = `kn:${domain}:${subject}:${key}`

    const cached = await cacheGet(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached) as Belief<T>
      } catch {
        // Corrupt cache entry — fall through to the DB
      }
    }

    const result = await query<{
      value: T
      source: KnowledgeSource
      confidence: string
      evidence_count: number
      reasoning: string | null
    }>(
      `SELECT value, source, confidence, evidence_count, reasoning
       FROM effective_knowledge
       WHERE domain = $1 AND subject = $2 AND key = $3`,
      [domain, subject, key]
    )

    const row = result.rows[0]
    if (!row) return null

    const belief: Belief<T> = {
      value: row.value,
      source: row.source,
      confidence: Number(row.confidence),
      evidenceCount: row.evidence_count,
      reasoning: row.reasoning,
      isBootstrap: row.source === 'bootstrap',
    }

    await cacheSet(cacheKey, JSON.stringify(belief), CACHE_TTL_SECONDS)
    return belief
  }

  /** Resolve with a fallback, so callers never have to null-check. */
  async resolveOr<T>(
    domain: string,
    subject: string,
    key: string,
    fallback: T
  ): Promise<T> {
    const belief = await this.resolve<T>(domain, subject, key)
    return belief?.value ?? fallback
  }

  // ─── Record evidence ────────────────────────────────────────────────────────
  async learn(params: {
    domain: string
    subject: string
    key: string
    value: unknown
    source: KnowledgeSource
    reasoning?: string
  }): Promise<{ confidence: number; isNew: boolean; contradicted: boolean }> {

    // Does an assertion from this same source already exist?
    const existing = await query<{
      id: string
      value: unknown
      confidence: string
      evidence_count: number
    }>(
      `SELECT id, value, confidence, evidence_count
       FROM agent_knowledge
       WHERE domain = $1 AND subject = $2 AND key = $3 AND source = $4
         AND status = 'active'`,
      [params.domain, params.subject, params.key, params.source]
    )

    const prior = existing.rows[0]

    if (!prior) {
      await query(
        `INSERT INTO agent_knowledge
           (domain, subject, key, value, source, confidence, evidence_count, reasoning)
         VALUES ($1,$2,$3,$4,$5,0.5,1,$6)
         ON CONFLICT (domain, subject, key, source) DO NOTHING`,
        [
          params.domain,
          params.subject,
          params.key,
          JSON.stringify(params.value),
          params.source,
          params.reasoning ?? null,
        ]
      )
      await this.invalidate(params.domain, params.subject, params.key)
      return { confidence: 0.5, isNew: true, contradicted: false }
    }

    // Same value → corroboration. Different value → contradiction.
    const same =
      JSON.stringify(prior.value) === JSON.stringify(params.value)

    const current = Number(prior.confidence)
    const next = same
      ? current + (1 - current) * CORROBORATION_RATE
      : Math.max(0, current - CONTRADICTION_PENALTY)

    if (same) {
      await query(
        `UPDATE agent_knowledge
         SET confidence = $2,
             evidence_count = evidence_count + 1,
             last_observed = now(),
             updated_at = now()
         WHERE id = $1`,
        [prior.id, next]
      )
    } else {
      // A contradiction replaces the value but resets confidence — we now
      // believe the new thing, but weakly, because our prior was wrong once.
      const status = next < NEEDS_REVIEW_THRESHOLD ? 'needs_review' : 'active'
      await query(
        `UPDATE agent_knowledge
         SET value = $2,
             confidence = $3,
             evidence_count = 1,
             status = $4,
             reasoning = COALESCE($5, reasoning),
             last_observed = now(),
             updated_at = now()
         WHERE id = $1`,
        [prior.id, JSON.stringify(params.value), next, status, params.reasoning ?? null]
      )

      logger.info(
        {
          domain: params.domain,
          subject: params.subject,
          key: params.key,
          from: prior.value,
          to: params.value,
          confidence: next,
        },
        'Belief revised — prior contradicted'
      )
    }

    await this.invalidate(params.domain, params.subject, params.key)
    return { confidence: next, isNew: false, contradicted: !same }
  }

  // ─── Did acting on this belief work out? ────────────────────────────────────
  //
  // This closes the loop that separates "learned" from "guessed". A belief that
  // keeps producing bad outcomes loses confidence even if it's frequently
  // observed.
  async recordOutcome(params: {
    domain: string
    subject: string
    key: string
    outcome: 'success' | 'failure'
    requestId?: string
    vendorId?: string
    note?: string
  }): Promise<void> {
    const result = await query<{ id: string; value: unknown }>(
      `SELECT id, value FROM agent_knowledge
       WHERE domain = $1 AND subject = $2 AND key = $3 AND status = 'active'
       ORDER BY confidence DESC LIMIT 1`,
      [params.domain, params.subject, params.key]
    )

    const knowledge = result.rows[0]
    if (!knowledge) return

    await query(
      `UPDATE agent_knowledge
       SET applied_count = applied_count + 1,
           success_count = success_count + CASE WHEN $2 THEN 1 ELSE 0 END,
           confidence = CASE
             WHEN $2 THEN LEAST(1.0, confidence + 0.05)
             ELSE GREATEST(0.0, confidence - 0.1)
           END,
           status = CASE
             WHEN NOT $2 AND confidence - 0.1 < $3 THEN 'needs_review'
             ELSE status
           END,
           updated_at = now()
       WHERE id = $1`,
      [knowledge.id, params.outcome === 'success', NEEDS_REVIEW_THRESHOLD]
    )

    await query(
      `INSERT INTO knowledge_applications
         (knowledge_id, request_id, vendor_id, applied_value, outcome, outcome_note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        knowledge.id,
        params.requestId ?? null,
        params.vendorId ?? null,
        JSON.stringify(knowledge.value),
        params.outcome,
        params.note ?? null,
      ]
    )

    await this.invalidate(params.domain, params.subject, params.key)
  }

  // ─── Beliefs the agent is no longer confident about ─────────────────────────
  async getNeedsReview(limit = 50): Promise<
    Array<{
      id: string
      domain: string
      subject: string
      key: string
      value: unknown
      confidence: number
      evidenceCount: number
      appliedCount: number
      successRate: number | null
      reasoning: string | null
    }>
  > {
    const result = await query<{
      id: string
      domain: string
      subject: string
      key: string
      value: unknown
      confidence: string
      evidence_count: number
      applied_count: number
      success_count: number
      reasoning: string | null
    }>(
      `SELECT id, domain, subject, key, value, confidence,
              evidence_count, applied_count, success_count, reasoning
       FROM agent_knowledge
       WHERE status = 'needs_review'
       ORDER BY applied_count DESC, confidence ASC
       LIMIT $1`,
      [limit]
    )

    return result.rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      subject: r.subject,
      key: r.key,
      value: r.value,
      confidence: Number(r.confidence),
      evidenceCount: r.evidence_count,
      appliedCount: r.applied_count,
      successRate:
        r.applied_count > 0 ? r.success_count / r.applied_count : null,
      reasoning: r.reasoning,
    }))
  }

  // ─── Human override — highest trust tier ───────────────────────────────────
  async adminAssert(params: {
    domain: string
    subject: string
    key: string
    value: unknown
    reasoning: string
    adminUserId: string
  }): Promise<void> {
    await query(
      `INSERT INTO agent_knowledge
         (domain, subject, key, value, source, confidence, reasoning, status)
       VALUES ($1,$2,$3,$4,'admin',1.0,$5,'active')
       ON CONFLICT (domain, subject, key, source)
         DO UPDATE SET value = EXCLUDED.value,
                       confidence = 1.0,
                       reasoning = EXCLUDED.reasoning,
                       status = 'active',
                       updated_at = now()`,
      [
        params.domain,
        params.subject,
        params.key,
        JSON.stringify(params.value),
        `${params.reasoning} [asserted by admin ${params.adminUserId}]`,
      ]
    )

    // Any lower-tier belief on this fact is now superseded
    await query(
      `UPDATE agent_knowledge
       SET status = 'superseded', updated_at = now()
       WHERE domain = $1 AND subject = $2 AND key = $3
         AND source <> 'admin' AND status = 'active'`,
      [params.domain, params.subject, params.key]
    )

    await this.invalidate(params.domain, params.subject, params.key)
    logger.info(
      { domain: params.domain, subject: params.subject, key: params.key },
      'Admin asserted knowledge — lower tiers superseded'
    )
  }

  // ─── Bulk resolve, to avoid N+1 on hot paths ────────────────────────────────
  async resolveMany<T = unknown>(
    domain: string,
    subjects: string[],
    key: string
  ): Promise<Map<string, Belief<T>>> {
    if (subjects.length === 0) return new Map()

    const result = await query<{
      subject: string
      value: T
      source: KnowledgeSource
      confidence: string
      evidence_count: number
      reasoning: string | null
    }>(
      `SELECT subject, value, source, confidence, evidence_count, reasoning
       FROM effective_knowledge
       WHERE domain = $1 AND key = $2 AND subject = ANY($3::text[])`,
      [domain, key, subjects]
    )

    const map = new Map<string, Belief<T>>()
    for (const r of result.rows) {
      map.set(r.subject, {
        value: r.value,
        source: r.source,
        confidence: Number(r.confidence),
        evidenceCount: r.evidence_count,
        reasoning: r.reasoning,
        isBootstrap: r.source === 'bootstrap',
      })
    }
    return map
  }

  private async invalidate(
    domain: string,
    subject: string,
    key: string
  ): Promise<void> {
    try {
      await redis.del(`kn:${domain}:${subject}:${key}`)
    } catch {
      // Cache invalidation failure is survivable — the TTL will catch up
    }
  }
}
