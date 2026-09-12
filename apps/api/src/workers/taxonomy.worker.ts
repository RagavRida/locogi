import { Worker } from 'bullmq'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { CategoryService } from '../services/category.service'
import { QuestionService } from '../services/question.service'
import { ScopeService } from '../services/scope.service'

const categories = new CategoryService()
const questions = new QuestionService()
const scope = new ScopeService()

/**
 * Taxonomy maintenance worker. Runs hourly.
 *
 * 1. Recompute category centroid embeddings from member vendors.
 *    A category's semantic center drifts toward what its members actually do,
 *    so future tag resolution gets more accurate as the pool grows.
 *
 * 2. Refresh vendor counts and median prices.
 *
 * 3. Flag near-duplicate categories for admin review. When the agent
 *    auto-creates a category that turns out to overlap an existing one,
 *    this surfaces it so it can be merged.
 *
 * 4. Backfill embeddings for aliases that were created before the
 *    embedding call succeeded.
 */
export const taxonomyWorker = new Worker(
  'taxonomy',
  async () => {
    // ── 1. Recompute centroids ──────────────────────────────────────────────
    const centroidsUpdated = await categories.refreshCentroids()

    // ── 2. Refresh stats ────────────────────────────────────────────────────
    await categories.refreshCategoryStats()

    // ── 3. Detect near-duplicate categories ─────────────────────────────────
    const duplicates = await query<{
      id_a: string
      name_a: string
      id_b: string
      name_b: string
      similarity: number
      vendors_a: number
      vendors_b: number
    }>(
      `SELECT a.id AS id_a, a.canonical_name AS name_a,
              b.id AS id_b, b.canonical_name AS name_b,
              1 - (a.embedding <=> b.embedding) AS similarity,
              a.vendor_count AS vendors_a, b.vendor_count AS vendors_b
       FROM service_categories a
       JOIN service_categories b ON a.id < b.id
       WHERE a.embedding IS NOT NULL
         AND b.embedding IS NOT NULL
         AND (a.is_verified = false OR b.is_verified = false)
         AND 1 - (a.embedding <=> b.embedding) > 0.90
       ORDER BY similarity DESC
       LIMIT 20`
    )

    for (const dup of duplicates.rows) {
      // Log as an event so the admin dashboard can surface it
      await query(
        `INSERT INTO events (event_type, metadata)
         VALUES ('taxonomy_duplicate_detected', $1)`,
        [
          JSON.stringify({
            categoryA: { id: dup.id_a, name: dup.name_a, vendors: dup.vendors_a },
            categoryB: { id: dup.id_b, name: dup.name_b, vendors: dup.vendors_b },
            similarity: Number(dup.similarity),
            // Suggest merging the smaller into the larger
            suggestedMerge:
              dup.vendors_a >= dup.vendors_b
                ? { source: dup.id_b, target: dup.id_a }
                : { source: dup.id_a, target: dup.id_b },
          }),
        ]
      )

      logger.warn(
        {
          a: dup.name_a,
          b: dup.name_b,
          similarity: Number(dup.similarity).toFixed(3),
        },
        'Near-duplicate categories detected — review for merge'
      )
    }

    // ── 4. Report supply gaps ───────────────────────────────────────────────
    const gaps = await query<{
      canonical_name: string
      vendor_count: number
      request_count: number
      ratio: number
    }>(
      `SELECT canonical_name, vendor_count, request_count,
              CASE WHEN vendor_count = 0 THEN request_count
                   ELSE request_count::numeric / vendor_count END AS ratio
       FROM service_categories
       WHERE request_count >= 5
       ORDER BY ratio DESC
       LIMIT 5`
    )

    if (gaps.rows.length > 0) {
      const topGaps = gaps.rows.filter((g) => Number(g.ratio) > 3)
      if (topGaps.length > 0) {
        logger.info(
          {
            gaps: topGaps.map(
              (g) =>
                `${g.canonical_name}: ${g.request_count} requests / ${g.vendor_count} vendors`
            ),
          },
          '📊 Vendor supply gaps — recruit here'
        )

        await query(
          `INSERT INTO events (event_type, metadata)
           VALUES ('supply_gap_report', $1)`,
          [JSON.stringify({ gaps: topGaps })]
        )
      }
    }

    // ── Generate follow-up questions from observed vendor fields ───────────
    // Replaces the hardcoded CATEGORY_FOLLOW_UPS map: questions now come from
    // fields vendors in each category actually fill in.
    const withTemplates = await query<{ category_id: string }>(
      `SELECT DISTINCT category_id FROM category_field_templates
       WHERE observation_count >= 4
       LIMIT 30`
    )
    let questionsGenerated = 0
    for (const row of withTemplates.rows) {
      try {
        questionsGenerated += await questions.generateMissingQuestions(row.category_id)
      } catch (err) {
        logger.warn({ err, categoryId: row.category_id }, 'Question generation failed')
      }
    }

    // ── Retire questions nobody answers ────────────────────────────────────
    const questionsRetired = await questions.retireUnderperformers()

    // ── Keep embeddings current for semantic boundaries ────────────────────
    const boundariesEmbedded = await scope.embedPendingBoundaries()
    const exemplarsEmbedded = await scope.embedPendingExemplars()

    logger.info(
      {
        questionsGenerated,
        questionsRetired,
        boundariesEmbedded,
        exemplarsEmbedded,
        centroidsUpdated,
        duplicatesFlagged: duplicates.rows.length,
        gapsDetected: gaps.rows.length,
      },
      'Taxonomy maintenance complete'
    )
  },
  { connection: { url: process.env.REDIS_URL! } }
)
