/**
 * CategoryService — the self-organizing vendor taxonomy.
 *
 * The LLM returns freeform tags. This service resolves them into canonical
 * categories so the vendor pool never fragments across synonyms.
 *
 * Resolution ladder (cheapest first):
 *   1. Exact alias hit (string match) — no embedding, no LLM. ~1ms
 *   2. Embedding similarity vs existing aliases  ≥ 0.92 → same alias
 *   3. Embedding similarity vs category centroids ≥ 0.82 → new alias of it
 *   4. Below threshold → CREATE a new canonical category
 *
 * Every resolution registers the alias, so step 1 handles it next time.
 * The taxonomy gets cheaper and smarter as more vendors join.
 */

import { query, withTransaction } from '../lib/db'
import { generateEmbedding } from '../lib/nim'
import { logger } from '../lib/logger'
import { ScopeService } from './scope.service'
import { mossSearch, MOSS_INDEX } from '../lib/moss'

const scope = new ScopeService()

// ─── Tuning ───────────────────────────────────────────────────────────────────
const ALIAS_MATCH_THRESHOLD = 0.92    // "drone shots" ≈ "drone videography"
const CATEGORY_MATCH_THRESHOLD = 0.82 // close enough to join an existing role
const FIELD_PROMOTION_THRESHOLD = 5   // observations before a field graduates

export interface ResolvedCategory {
  categoryId: string
  slug: string
  canonicalName: string
  defaultBookingType: string | null
  requiresKyc: boolean
  requiresGenderPreference: boolean
  matchedVia: 'exact_alias' | 'alias_similarity' | 'category_similarity' | 'created'
  confidence: number
  sourceTag: string
}

export class CategoryService {

  // ─── Resolve a batch of raw tags into canonical categories ──────────────────
  async resolveTags(
    rawTags: string[],
    source: 'vendor' | 'request' = 'vendor'
  ): Promise<ResolvedCategory[]> {
    const resolved: ResolvedCategory[] = []
    const seen = new Set<string>()

    for (const tag of rawTags) {
      const clean = tag.trim()
      if (!clean || clean.length > 80) continue

      const result = await this.resolveTag(clean, source)
      if (result && !seen.has(result.categoryId)) {
        resolved.push(result)
        seen.add(result.categoryId)
      }
    }

    return resolved
  }

  // ─── Resolve one tag ────────────────────────────────────────────────────────
  private async resolveTag(
    rawTag: string,
    source: 'vendor' | 'request'
  ): Promise<ResolvedCategory | null> {
    const normalized = rawTag.toLowerCase().trim()

    // ── Step 1: exact alias hit (free) ──────────────────────────────────────
    const exact = await query<CategoryRow>(
      `SELECT c.id, c.slug, c.canonical_name, c.default_booking_type,
              c.requires_kyc, c.requires_gender_preference
       FROM category_aliases a
       JOIN service_categories c ON c.id = a.category_id
       WHERE a.alias_normalized = $1`,
      [normalized]
    )

    if (exact.rows.length > 0) {
      // Bump the occurrence counter — signals which phrasings are common
      await query(
        `UPDATE category_aliases
         SET occurrence_count = occurrence_count + 1
         WHERE alias_normalized = $1`,
        [normalized]
      )
      return this.toResolved(exact.rows[0], 'exact_alias', 1.0, rawTag)
    }

    // ── Step 1.5: Moss semantic search (sub-10ms, no embedding needed) ───────
    //
    // Moss is faster than generating an embedding + pgvector query. If it finds
    // a match with high confidence, we skip the OpenAI embedding call entirely.
    try {
      const mossResults = await mossSearch(MOSS_INDEX.CATEGORIES, rawTag, { limit: 1 })
      if (mossResults.length > 0 && mossResults[0].score >= 0.82) {
        const mossHit = mossResults[0]
        const slug = String(mossHit.metadata.slug ?? '')
        if (slug) {
          const catRow = await query<CategoryRow>(
            `SELECT id, slug, canonical_name, default_booking_type,
                    requires_kyc, requires_gender_preference
             FROM service_categories WHERE slug = $1`,
            [slug]
          )
          if (catRow.rows.length > 0) {
            // Register as alias so Step 1 handles it next time (free)
            await this.registerAlias(
              catRow.rows[0].id,
              rawTag,
              '',  // no embedding — will be backfilled if pgvector is used later
              mossHit.score,
              source
            )
            logger.info(
              { rawTag, matched: catRow.rows[0].canonical_name, score: mossHit.score },
              'Tag resolved via Moss semantic search'
            )
            return this.toResolved(
              catRow.rows[0],
              'alias_similarity',
              mossHit.score,
              rawTag
            )
          }
        }
      }
    } catch (err) {
      // Moss failure is non-fatal — continue to pgvector path
      logger.debug({ err, rawTag }, 'Moss category search failed — continuing to pgvector')
    }

    // ── Steps 2-4 need an embedding ─────────────────────────────────────────
    let embedding: number[]
    try {
      embedding = await generateEmbedding(rawTag)
    } catch (err) {
      logger.error({ err, rawTag }, 'Could not embed tag — skipping resolution')
      return null
    }
    const vec = `[${embedding.join(',')}]`

    // ── Step 2: similar to an existing alias? ───────────────────────────────
    const aliasMatch = await query<CategoryRow & { similarity: number }>(
      `SELECT c.id, c.slug, c.canonical_name, c.default_booking_type,
              c.requires_kyc, c.requires_gender_preference,
              1 - (a.embedding <=> $1::vector) AS similarity
       FROM category_aliases a
       JOIN service_categories c ON c.id = a.category_id
       WHERE a.embedding IS NOT NULL
       ORDER BY a.embedding <=> $1::vector
       LIMIT 1`,
      [vec]
    )

    const aliasTop = aliasMatch.rows[0]
    if (aliasTop && Number(aliasTop.similarity) >= ALIAS_MATCH_THRESHOLD) {
      await this.registerAlias(
        aliasTop.id,
        rawTag,
        vec,
        Number(aliasTop.similarity),
        source
      )
      logger.info(
        { rawTag, matched: aliasTop.canonical_name, sim: aliasTop.similarity },
        'Tag resolved via alias similarity'
      )
      return this.toResolved(
        aliasTop,
        'alias_similarity',
        Number(aliasTop.similarity),
        rawTag
      )
    }

    // ── Step 3: similar to a category centroid? ─────────────────────────────
    const catMatch = await query<CategoryRow & { similarity: number }>(
      `SELECT id, slug, canonical_name, default_booking_type,
              requires_kyc, requires_gender_preference,
              1 - (embedding <=> $1::vector) AS similarity
       FROM service_categories
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [vec]
    )

    const catTop = catMatch.rows[0]
    if (catTop && Number(catTop.similarity) >= CATEGORY_MATCH_THRESHOLD) {
      await this.registerAlias(
        catTop.id,
        rawTag,
        vec,
        Number(catTop.similarity),
        source
      )
      logger.info(
        { rawTag, matched: catTop.canonical_name, sim: catTop.similarity },
        'Tag resolved via category similarity'
      )
      return this.toResolved(
        catTop,
        'category_similarity',
        Number(catTop.similarity),
        rawTag
      )
    }

    // ── Step 4: genuinely new role → create it ──────────────────────────────
    //
    // SAFETY NET. The IntentService gate should already have caught non-service
    // requests, but category creation is permanent and pollution is expensive
    // to clean up. So we guard again here, and we only let REQUESTS create
    // categories if a vendor could plausibly fill them.
    if (!(await this.isPlausibleServiceRole(rawTag))) {
      logger.warn(
        { rawTag, source },
        'Refusing to create category — does not look like a hireable service role'
      )
      return null
    }

    // Requests alone never create categories. Demand without supply just makes
    // an orphan category. Only a real vendor claiming a role can open one.
    if (source === 'request') {
      logger.info(
        { rawTag },
        'Request tag matched no category — logged as demand, not creating a category'
      )
      await this.logUnservedCategoryDemand(rawTag, vec)
      return null
    }

    const created = await this.createCategory(rawTag, vec, source)
    if (!created) return null

    logger.info(
      { rawTag, slug: created.slug, nearestSim: catTop?.similarity ?? 0 },
      '🆕 New canonical category created from vendor description'
    )

    return this.toResolved(created, 'created', 1.0, rawTag)
  }

  /**
   * Is this plausibly a service someone can be HIRED for?
   *
   * Was an 18-term substring blocklist, which rejected "cook" because it
   * contained "book" and had no idea what to do with anything not on the list.
   *
   * Now: semantic comparison against exemplars on both sides of the boundary
   * (role_exemplars). The boundary sharpens over time — a category that
   * attracted vendors becomes a positive exemplar, one that stayed empty for
   * 90 days becomes a negative one.
   */
  private async isPlausibleServiceRole(rawTag: string): Promise<boolean> {
    const verdict = await scope.checkRolePlausibility(rawTag)

    if (!verdict.isPlausible) {
      logger.info(
        {
          rawTag,
          nearestExemplar: verdict.nearestExemplar,
          confidence: verdict.confidence,
        },
        'Tag judged not to be a hireable service role'
      )
    }

    // Low-confidence verdicts fail OPEN. A false positive (an odd category
    // that stays empty) is cheaper than a false negative (rejecting a real
    // vendor's trade and losing them at onboarding).
    if (verdict.confidence < 0.2) return true

    return verdict.isPlausible
  }

  /**
   * A request asked for something no vendor offers yet. Don't create an orphan
   * category — log it as demand so the supply-gap report can surface it.
   */
  private async logUnservedCategoryDemand(
    rawTag: string,
    vec: string
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO events (event_type, metadata)
         VALUES ('unserved_category_demand', $1)`,
        [JSON.stringify({ tag: rawTag, timestamp: new Date().toISOString() })]
      )
    } catch (err) {
      logger.error({ err, rawTag }, 'Could not log unserved category demand')
    }
  }

  // ─── Create a brand-new canonical category ──────────────────────────────────
  private async createCategory(
    rawTag: string,
    vec: string,
    source: 'vendor' | 'request'
  ): Promise<CategoryRow | null> {
    const slug = this.slugify(rawTag)
    const canonicalName = this.titleCase(rawTag)

    return withTransaction(async (client) => {
      const result = await client.query<CategoryRow>(
        `INSERT INTO service_categories
           (slug, canonical_name, description, embedding, is_verified)
         VALUES ($1, $2, $3, $4::vector, false)
         ON CONFLICT (slug) DO UPDATE SET slug = service_categories.slug
         RETURNING id, slug, canonical_name, default_booking_type,
                   requires_kyc, requires_gender_preference`,
        [
          slug,
          canonicalName,
          `Auto-created from a ${source} description: "${rawTag}"`,
          vec,
        ]
      )

      const cat = result.rows[0]
      if (!cat) return null

      // Register the originating tag as its first alias
      await client.query(
        `INSERT INTO category_aliases
           (category_id, alias, alias_normalized, embedding, similarity_score, source)
         VALUES ($1, $2, $3, $4::vector, 1.0, $5)
         ON CONFLICT (alias_normalized) DO NOTHING`,
        [cat.id, rawTag, rawTag.toLowerCase().trim(), vec, source]
      )

      return cat
    })
  }

  // ─── Register a new alias for an existing category ──────────────────────────
  private async registerAlias(
    categoryId: string,
    alias: string,
    vec: string,
    similarity: number,
    source: 'vendor' | 'request'
  ): Promise<void> {
    await query(
      `INSERT INTO category_aliases
         (category_id, alias, alias_normalized, embedding, similarity_score, source)
       VALUES ($1, $2, $3, $4::vector, $5, $6)
       ON CONFLICT (alias_normalized)
         DO UPDATE SET occurrence_count = category_aliases.occurrence_count + 1`,
      [categoryId, alias, alias.toLowerCase().trim(), vec, similarity, source]
    )
  }

  // ─── Link a vendor to its resolved categories ───────────────────────────────
  async linkVendor(
    vendorId: string,
    resolved: ResolvedCategory[]
  ): Promise<void> {
    if (resolved.length === 0) return

    // Replace existing links (vendor may have edited their profile)
    await query('DELETE FROM vendor_categories WHERE vendor_id = $1', [vendorId])

    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i]
      await query(
        `INSERT INTO vendor_categories
           (vendor_id, category_id, is_primary, confidence, source_tag)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vendor_id, category_id) DO UPDATE
           SET is_primary = EXCLUDED.is_primary,
               confidence = EXCLUDED.confidence`,
        [vendorId, r.categoryId, i === 0, r.confidence, r.sourceTag]
      )
    }

    // Refresh vendor counts
    await this.refreshCategoryStats(resolved.map((r) => r.categoryId))
  }

  // ─── Link a request to its resolved categories ──────────────────────────────
  async linkRequest(
    requestId: string,
    resolved: ResolvedCategory[]
  ): Promise<void> {
    for (const r of resolved) {
      await query(
        `INSERT INTO request_categories (request_id, category_id, confidence, source_tag)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (request_id, category_id) DO NOTHING`,
        [requestId, r.categoryId, r.confidence, r.sourceTag]
      )
    }

    await query(
      `UPDATE service_categories
       SET request_count = request_count + 1
       WHERE id = ANY($1::uuid[])`,
      [resolved.map((r) => r.categoryId)]
    )
  }

  // ─── Observe the attribute schema the LLM produced for this role ────────────
  // This is how the system learns what fields each role actually needs.
  async observeSchema(
    categoryIds: string[],
    attributeSchema: Record<string, string>,
    attributes: Record<string, unknown>,
    source: 'vendor' | 'request',
    entityId: string
  ): Promise<void> {
    const entries = Object.entries(attributeSchema ?? {})
    if (entries.length === 0 || categoryIds.length === 0) return

    for (const categoryId of categoryIds) {
      for (const [fieldName, fieldType] of entries) {
        const sample = attributes?.[fieldName]
        await query(
          `INSERT INTO category_schema_observations
             (category_id, field_name, field_type, sample_value, source, entity_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            categoryId,
            fieldName.toLowerCase().trim(),
            this.normalizeFieldType(fieldType),
            sample != null ? String(sample).slice(0, 200) : null,
            source,
            entityId,
          ]
        )
      }
    }

    // Try to promote any fields that crossed the threshold
    await this.promoteFields(categoryIds)
  }

  // ─── Promote frequently-observed fields into the canonical role template ────
  private async promoteFields(categoryIds: string[]): Promise<void> {
    const candidates = await query<{
      category_id: string
      field_name: string
      field_type: string
      distinct_entities: string
    }>(
      `SELECT category_id, field_name,
              MODE() WITHIN GROUP (ORDER BY field_type) AS field_type,
              COUNT(DISTINCT entity_id) AS distinct_entities
       FROM category_schema_observations
       WHERE category_id = ANY($1::uuid[])
       GROUP BY category_id, field_name
       HAVING COUNT(DISTINCT entity_id) >= $2`,
      [categoryIds, FIELD_PROMOTION_THRESHOLD]
    )

    for (const c of candidates.rows) {
      const count = Number(c.distinct_entities)
      await query(
        `INSERT INTO category_field_templates
           (category_id, field_name, field_type, field_label,
            observation_count, prompt_question, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (category_id, field_name) DO UPDATE
           SET observation_count = EXCLUDED.observation_count,
               field_type = EXCLUDED.field_type,
               updated_at = now()`,
        [
          c.category_id,
          c.field_name,
          c.field_type,
          this.titleCase(c.field_name.replace(/_/g, ' ')),
          count,
          this.buildPrompt(c.field_name, c.field_type),
          count, // more common fields sort first
        ]
      )
    }

    if (candidates.rows.length > 0) {
      logger.info(
        { promoted: candidates.rows.length },
        'Category field templates updated from schema observations'
      )
    }
  }

  // ─── Get the learned field template for a role ──────────────────────────────
  // Used at vendor onboarding: prompt for fields this role usually has,
  // even if the vendor didn't mention them.
  async getFieldTemplate(categoryId: string): Promise<
    Array<{
      fieldName: string
      fieldType: string
      fieldLabel: string
      promptQuestion: string
      isRequired: boolean
    }>
  > {
    const result = await query<{
      field_name: string
      field_type: string
      field_label: string
      prompt_question: string
      is_required: boolean
    }>(
      `SELECT field_name, field_type, field_label, prompt_question, is_required
       FROM category_field_templates
       WHERE category_id = $1
       ORDER BY display_order DESC, field_name ASC
       LIMIT 8`,
      [categoryId]
    )

    return result.rows.map((r) => ({
      fieldName: r.field_name,
      fieldType: r.field_type,
      fieldLabel: r.field_label,
      promptQuestion: r.prompt_question,
      isRequired: r.is_required,
    }))
  }

  // ─── Recompute category centroid embeddings + stats ────────────────────────
  // The centroid is the average of member vendor embeddings. As vendors join,
  // the category's semantic center drifts toward what its members actually do.
  async refreshCategoryStats(categoryIds?: string[]): Promise<void> {
    const filter = categoryIds?.length
      ? 'WHERE c.id = ANY($1::uuid[])'
      : ''
    const params = categoryIds?.length ? [categoryIds] : []

    await query(
      `UPDATE service_categories c
       SET vendor_count = sub.cnt,
           avg_price = sub.median_price,
           updated_at = now()
       FROM (
         SELECT vc.category_id,
                COUNT(DISTINCT vc.vendor_id) AS cnt,
                PERCENTILE_CONT(0.5) WITHIN GROUP (
                  ORDER BY r.agreed_price
                )::integer AS median_price
         FROM vendor_categories vc
         LEFT JOIN requests r
           ON r.confirmed_vendor_id = vc.vendor_id
          AND r.status = 'completed'
          AND r.agreed_price IS NOT NULL
         GROUP BY vc.category_id
       ) sub
       WHERE c.id = sub.category_id
       ${filter ? 'AND c.id = ANY($1::uuid[])' : ''}`,
      params
    )
  }

  // ─── Recompute centroids from member vendor embeddings ──────────────────────
  async refreshCentroids(): Promise<number> {
    const result = await query(
      `UPDATE service_categories c
       SET embedding = sub.centroid, updated_at = now()
       FROM (
         SELECT vc.category_id,
                AVG(v.embedding)::vector(1536) AS centroid
         FROM vendor_categories vc
         JOIN vendors v ON v.id = vc.vendor_id
         WHERE v.embedding IS NOT NULL
         GROUP BY vc.category_id
         HAVING COUNT(*) >= 3
       ) sub
       WHERE c.id = sub.category_id`
    )
    return result.rowCount
  }

  // ─── Admin / analytics: taxonomy health ────────────────────────────────────
  async getTaxonomyOverview(): Promise<{
    categories: Array<{
      id: string
      slug: string
      canonicalName: string
      vendorCount: number
      requestCount: number
      aliasCount: number
      avgPrice: number | null
      isVerified: boolean
      supplyGap: number
    }>
    unverifiedCount: number
    orphanCount: number
  }> {
    const result = await query<{
      id: string
      slug: string
      canonical_name: string
      vendor_count: number
      request_count: number
      alias_count: string
      avg_price: number | null
      is_verified: boolean
    }>(
      `SELECT c.id, c.slug, c.canonical_name, c.vendor_count, c.request_count,
              c.avg_price, c.is_verified,
              COUNT(a.id) AS alias_count
       FROM service_categories c
       LEFT JOIN category_aliases a ON a.category_id = c.id
       GROUP BY c.id
       ORDER BY c.request_count DESC, c.vendor_count DESC`
    )

    const categories = result.rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      canonicalName: r.canonical_name,
      vendorCount: r.vendor_count,
      requestCount: r.request_count,
      aliasCount: Number(r.alias_count),
      avgPrice: r.avg_price,
      isVerified: r.is_verified,
      // Demand/supply ratio — where you need to recruit vendors
      supplyGap:
        r.vendor_count > 0
          ? Math.round((r.request_count / r.vendor_count) * 100) / 100
          : r.request_count,
    }))

    return {
      categories,
      unverifiedCount: categories.filter((c) => !c.isVerified).length,
      orphanCount: categories.filter((c) => c.vendorCount === 0).length,
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  private toResolved(
    row: CategoryRow,
    matchedVia: ResolvedCategory['matchedVia'],
    confidence: number,
    sourceTag: string
  ): ResolvedCategory {
    return {
      categoryId: row.id,
      slug: row.slug,
      canonicalName: row.canonical_name,
      defaultBookingType: row.default_booking_type,
      requiresKyc: row.requires_kyc,
      requiresGenderPreference: row.requires_gender_preference,
      matchedVia,
      confidence: Math.round(confidence * 1000) / 1000,
      sourceTag,
    }
  }

  private slugify(s: string): string {
    return s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60)
  }

  private titleCase(s: string): string {
    return s
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ')
      .slice(0, 80)
  }

  private normalizeFieldType(t: string): string {
    const valid = ['text', 'number', 'date', 'currency', 'list', 'boolean']
    const lower = t?.toLowerCase?.() ?? 'text'
    return valid.includes(lower) ? lower : 'text'
  }

  private buildPrompt(fieldName: string, fieldType: string): string {
    const label = fieldName.replace(/_/g, ' ')
    switch (fieldType) {
      case 'currency':
        return `What is your ${label}? (in ₹)`
      case 'number':
        return `What is your ${label}?`
      case 'date':
        return `What ${label}?`
      case 'list':
        return `Which ${label} do you offer?`
      case 'boolean':
        return `Do you offer ${label}?`
      default:
        return `Tell us about your ${label}`
    }
  }
}

interface CategoryRow {
  id: string
  slug: string
  canonical_name: string
  default_booking_type: string | null
  requires_kyc: boolean
  requires_gender_preference: boolean
}
