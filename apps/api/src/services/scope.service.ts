/**
 * ScopeService — semantic boundary detection, replacing substring matching.
 *
 * The old version did `text.includes('flight ticket')`. That misses:
 *   "need to fly to Delhi tomorrow"
 *   "book me on the 6am to Mumbai"
 *   "విమానం టికెట్" (Telugu)
 *   "airplane seat"
 *
 * Now each boundary carries a canonical natural-language description which is
 * embedded once. Incoming requests are compared by cosine similarity, so
 * paraphrases and other languages land correctly.
 *
 * Two other hardcoded lists are replaced the same way:
 *   • the 18-term NON_SERVICE_CONCEPTS blocklist → role_exemplars, compared
 *     semantically (so "cook" is no longer rejected for containing "book")
 *   • the PLACE_WORDS / SOCIAL_WORDS heuristic lists → exemplar similarity
 *
 * New boundaries can be PROPOSED by the agent when a demand cluster shows a
 * consistent pattern, then reviewed by a human before going active.
 */

import { query } from '../lib/db'
import { generateEmbedding } from '../lib/nim'
import { runTask } from '../ai/contract'
import { proposeBoundaryTask } from '../ai/tasks/propose-boundary'
import { cacheGet, cacheSet } from '../lib/redis'
import { logger } from '../lib/logger'
import { z } from 'zod'

export interface ScopeVerdict {
  inScope: boolean
  boundarySlug?: string
  boundaryLabel?: string
  reason?: string
  message?: string
  similarity?: number
}

export interface RolePlausibility {
  isPlausible: boolean
  confidence: number
  nearestExemplar: string | null
  nearestIsServiceRole: boolean | null
}

export class ScopeService {

  // ─── Is this request outside what Locogi can do? ────────────────────────────
  async checkScope(rawText: string): Promise<ScopeVerdict> {
    // Short-circuit on an exact cache hit for repeated phrasings
    const cacheKey = `scope:${rawText.toLowerCase().trim().slice(0, 120)}`
    const cached = await cacheGet(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached) as ScopeVerdict
      } catch { /* fall through */ }
    }

    let embedding: string
    try {
      const vec = await generateEmbedding(rawText)
      embedding = `[${vec.join(',')}]`
    } catch (err) {
      // Embedding unavailable. Fall back to the legacy substring patterns,
      // which are still stored on the row — degraded but not broken.
      logger.warn({ err }, 'Scope check falling back to substring matching')
      return this.substringFallback(rawText)
    }

    const result = await query<{
      slug: string
      label: string
      reason: string
      explanation: string
      redirect_to: string | null
      similarity_threshold: string
      similarity: string
    }>(
      `SELECT slug, label, reason, explanation, redirect_to,
              similarity_threshold,
              1 - (embedding <=> $1::vector) AS similarity
       FROM out_of_scope_categories
       WHERE embedding IS NOT NULL AND status = 'active'
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [embedding]
    )

    const top = result.rows[0]
    if (!top) {
      return { inScope: true }
    }

    const similarity = Number(top.similarity)
    const threshold = Number(top.similarity_threshold)

    if (similarity < threshold) {
      const verdict: ScopeVerdict = { inScope: true, similarity }
      await cacheSet(cacheKey, JSON.stringify(verdict), 600)
      return verdict
    }

    await query(
      `UPDATE out_of_scope_categories
       SET times_matched = times_matched + 1 WHERE slug = $1`,
      [top.slug]
    )

    const isPrincipled = top.reason === 'regulatory_prohibition'
    const message = isPrincipled
      ? `${top.explanation}\n\n👉 ${top.redirect_to}\n\n` +
        `Anyone offering to book these for a fee is a tout — please avoid them. ` +
        `The official process is free.\n\nAnything local I can actually help with?`
      : `I can't help with ${top.label.toLowerCase()} — ${top.explanation}\n\n` +
        (top.redirect_to ? `👉 Try ${top.redirect_to}\n\n` : '') +
        `What I do cover: photographers, plumbers, electricians, salons, ` +
        `doctors, rides, tutors, rentals, venues and similar local services. ` +
        `Need any of those?`

    const verdict: ScopeVerdict = {
      inScope: false,
      boundarySlug: top.slug,
      boundaryLabel: top.label,
      reason: top.reason,
      message,
      similarity,
    }

    logger.info(
      { slug: top.slug, similarity: similarity.toFixed(3) },
      'Out-of-scope request detected semantically'
    )

    await cacheSet(cacheKey, JSON.stringify(verdict), 600)
    return verdict
  }

  // ─── Is this tag plausibly a hireable service role? ─────────────────────────
  //
  // Replaces the substring blocklist. Compares against exemplars on both sides
  // of the boundary and takes the nearest neighbour's label.
  async checkRolePlausibility(rawTag: string): Promise<RolePlausibility> {
    if (rawTag.trim().length < 3 || !/[a-z]/i.test(rawTag)) {
      return {
        isPlausible: false,
        confidence: 0.9,
        nearestExemplar: null,
        nearestIsServiceRole: null,
      }
    }

    let embedding: string
    try {
      const vec = await generateEmbedding(rawTag)
      embedding = `[${vec.join(',')}]`
    } catch {
      // Without an embedding we cannot judge. Fail OPEN — a false positive
      // (creating a slightly odd category) is cheaper than a false negative
      // (rejecting a real vendor's trade).
      return {
        isPlausible: true,
        confidence: 0.3,
        nearestExemplar: null,
        nearestIsServiceRole: null,
      }
    }

    const result = await query<{
      text: string
      is_service_role: boolean
      similarity: string
    }>(
      `SELECT text, is_service_role, 1 - (embedding <=> $1::vector) AS similarity
       FROM role_exemplars
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 3`,
      [embedding]
    )

    if (result.rows.length === 0) {
      return {
        isPlausible: true,
        confidence: 0.3,
        nearestExemplar: null,
        nearestIsServiceRole: null,
      }
    }

    // Weighted vote across the 3 nearest exemplars, so one odd neighbour
    // doesn't decide it
    let serviceWeight = 0
    let nonServiceWeight = 0
    for (const r of result.rows) {
      const w = Number(r.similarity)
      if (r.is_service_role) serviceWeight += w
      else nonServiceWeight += w
    }

    const total = serviceWeight + nonServiceWeight
    const isPlausible = serviceWeight > nonServiceWeight
    const confidence = total > 0
      ? Math.abs(serviceWeight - nonServiceWeight) / total
      : 0

    const nearest = result.rows[0]

    await query(
      `UPDATE role_exemplars SET times_referenced = times_referenced + 1
       WHERE text = $1`,
      [nearest.text]
    )

    return {
      isPlausible,
      confidence: Math.round(confidence * 100) / 100,
      nearestExemplar: nearest.text,
      nearestIsServiceRole: nearest.is_service_role,
    }
  }

  // ─── Learn a new exemplar from a real outcome ───────────────────────────────
  //
  // This is the loop that makes the boundary sharpen over time. A category
  // that attracted vendors was a real role. One that sat empty for 90 days
  // with requests coming in was not.
  async learnExemplarFromOutcome(
    text: string,
    isServiceRole: boolean,
    reasoning: string
  ): Promise<void> {
    let embedding: string | null = null
    try {
      const vec = await generateEmbedding(text)
      embedding = `[${vec.join(',')}]`
    } catch {
      return // No embedding, no useful exemplar
    }

    await query(
      `INSERT INTO role_exemplars (text, is_service_role, embedding, reasoning, source)
       VALUES ($1,$2,$3::vector,$4,'observed')
       ON CONFLICT (text) DO UPDATE
         SET is_service_role = EXCLUDED.is_service_role,
             reasoning = EXCLUDED.reasoning`,
      [text.slice(0, 120), isServiceRole, embedding, reasoning]
    )

    logger.info(
      { text, isServiceRole, reasoning },
      'Learned a new role-boundary exemplar from observed outcome'
    )
  }

  // ─── Agent proposes a new scope boundary from a demand cluster ──────────────
  //
  // When 30 people ask for something we structurally cannot do, the agent
  // writes a boundary definition. It goes in as status='testing' and needs
  // human review before it starts refusing real requests.
  async proposeBoundaryFromCluster(clusterId: string): Promise<{
    proposed: boolean
    slug?: string
  }> {
    const cluster = await query<{
      label: string
      intent: string
      unique_user_count: number
      samples: string[]
    }>(
      `SELECT dc.label, dc.intent, dc.unique_user_count,
              ARRAY_AGG(ud.raw_text ORDER BY ud.created_at DESC) AS samples
       FROM demand_clusters dc
       JOIN unmet_demand ud ON ud.cluster_id = dc.id
       WHERE dc.id = $1
       GROUP BY dc.id, dc.label, dc.intent, dc.unique_user_count`,
      [clusterId]
    )

    const c = cluster.rows[0]
    if (!c) return { proposed: false }

    // No try/catch: runTask never throws. Its failure cases are values, and
    // each one is handled explicitly below.

    const result = await runTask(proposeBoundaryTask, {
      label: c.label,
      uniqueUserCount: c.unique_user_count,
      samples: (c.samples ?? []).slice(0, 8),
    })

    if (!result.ok) {
      logger.warn(
        { clusterId, label: c.label, reason: result.reason },
        'Boundary proposal unavailable — cluster left for the next sweep'
      )
      return { proposed: false }
    }

    const d = result.data

    if (!d.should_be_boundary) {
      logger.info(
        { clusterId, label: c.label },
        'Agent judged cluster to be in-scope — no boundary proposed'
      )
      return { proposed: false }
    }

    const vec = await generateEmbedding(d.canonical_description)

    await query(
      `INSERT INTO out_of_scope_categories
         (slug, label, reason, explanation, redirect_to, match_patterns,
          canonical_description, embedding, source, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,'agent','testing')
       ON CONFLICT (slug) DO NOTHING`,
      [
        d.slug,
        d.label,
        d.reason,
        d.explanation,
        d.redirect_to,
        [d.label.toLowerCase()], // minimal substring fallback
        d.canonical_description,
        `[${vec.join(',')}]`,
      ]
    )

    logger.warn(
      { slug: d.slug, users: c.unique_user_count, reasoning: d.reasoning },
      '🤖 Agent proposed a new scope boundary — needs human review before going active'
    )

    return { proposed: true, slug: d.slug }
  }

  // ─── Backfill embeddings for boundaries that lack them ─────────────────────
  async embedPendingBoundaries(): Promise<number> {
    const pending = await query<{ slug: string; canonical_description: string }>(
      `SELECT slug, canonical_description
       FROM out_of_scope_categories
       WHERE embedding IS NULL AND canonical_description IS NOT NULL
       LIMIT 20`
    )

    let done = 0
    for (const row of pending.rows) {
      try {
        const vec = await generateEmbedding(row.canonical_description)
        await query(
          `UPDATE out_of_scope_categories SET embedding = $2::vector WHERE slug = $1`,
          [row.slug, `[${vec.join(',')}]`]
        )
        done++
      } catch (err) {
        logger.warn({ err, slug: row.slug }, 'Boundary embedding failed')
      }
    }
    return done
  }

  async embedPendingExemplars(): Promise<number> {
    const pending = await query<{ text: string }>(
      `SELECT text FROM role_exemplars WHERE embedding IS NULL LIMIT 50`
    )

    let done = 0
    for (const row of pending.rows) {
      try {
        const vec = await generateEmbedding(row.text)
        await query(
          `UPDATE role_exemplars SET embedding = $2::vector WHERE text = $1`,
          [row.text, `[${vec.join(',')}]`]
        )
        done++
      } catch { /* skip */ }
    }
    return done
  }

  // ─── Legacy substring path, used only when embeddings are unavailable ──────
  private async substringFallback(rawText: string): Promise<ScopeVerdict> {
    const t = rawText.toLowerCase()
    const result = await query<{
      slug: string
      label: string
      reason: string
      explanation: string
      redirect_to: string | null
      match_patterns: string[]
    }>(
      `SELECT slug, label, reason, explanation, redirect_to, match_patterns
       FROM out_of_scope_categories WHERE status = 'active'`
    )

    for (const row of result.rows) {
      if (row.match_patterns.some((p) => t.includes(p.toLowerCase()))) {
        return {
          inScope: false,
          boundarySlug: row.slug,
          boundaryLabel: row.label,
          reason: row.reason,
          message:
            `I can't help with ${row.label.toLowerCase()} — ${row.explanation}` +
            (row.redirect_to ? `\n\n👉 Try ${row.redirect_to}` : ''),
        }
      }
    }
    return { inScope: true }
  }
}
