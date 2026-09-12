import { Worker } from 'bullmq'
import { query } from '../lib/db'
import { logger } from '../lib/logger'

const CLUSTER_MATCH_THRESHOLD = 0.86  // similar enough to be the same ask
const CANDIDATE_THRESHOLD = 15        // distinct users before it's a candidate
const BUILDING_THRESHOLD = 50         // distinct users before it's urgent

function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 60)
}

/**
 * Demand clustering worker. Runs every 6 hours.
 *
 * Everything the intent gate rejected lands in unmet_demand. This worker
 * groups semantically similar asks into clusters. When a cluster crosses a
 * user-count threshold, it graduates from 'observing' → 'candidate', which
 * surfaces it on the admin dashboard as a possible new vertical.
 *
 * This is how "find me a library" stops being a dead end and becomes evidence.
 * If 200 people ask for study spaces, that is a real product decision waiting
 * to be made — not noise to be discarded.
 */
export const demandWorker = new Worker(
  'demand',
  async () => {
    // ── 1. Assign unclustered demand to clusters ────────────────────────────
    const unclustered = await query<{
      id: string
      raw_text: string
      intent: string
      extracted_topic: string | null
      embedding: string
      user_id: string
    }>(
      `SELECT id, raw_text, intent, extracted_topic, embedding, user_id
       FROM unmet_demand
       WHERE cluster_id IS NULL
         AND embedding IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 200`
    )

    let assigned = 0
    let created = 0

    for (const item of unclustered.rows) {
      // Find the nearest existing cluster with the same intent
      const nearest = await query<{ id: string; similarity: number; label: string }>(
        `SELECT id, label, 1 - (centroid <=> $1::vector) AS similarity
         FROM demand_clusters
         WHERE intent = $2 AND centroid IS NOT NULL
         ORDER BY centroid <=> $1::vector
         LIMIT 1`,
        [item.embedding, item.intent]
      )

      const top = nearest.rows[0]

      if (top && Number(top.similarity) >= CLUSTER_MATCH_THRESHOLD) {
        // Join the existing cluster
        await query(
          'UPDATE unmet_demand SET cluster_id = $1 WHERE id = $2',
          [top.id, item.id]
        )
        assigned++
      } else {
        // Start a new cluster seeded by this item
        const label = item.extracted_topic
          ? titleCase(item.extracted_topic)
          : item.raw_text.slice(0, 40)

        const newCluster = await query<{ id: string }>(
          `INSERT INTO demand_clusters (label, centroid, intent)
           VALUES ($1, $2::vector, $3)
           RETURNING id`,
          [label, item.embedding, item.intent]
        )

        const clusterId = newCluster.rows[0]?.id
        if (clusterId) {
          await query(
            'UPDATE unmet_demand SET cluster_id = $1 WHERE id = $2',
            [clusterId, item.id]
          )
          created++
        }
      }
    }

    // ── 2. Recompute cluster centroids and counts ───────────────────────────
    await query(
      `UPDATE demand_clusters c
       SET centroid = sub.centroid,
           request_count = sub.total,
           unique_user_count = sub.users,
           last_seen = sub.latest,
           updated_at = now()
       FROM (
         SELECT cluster_id,
                AVG(embedding)::vector(1536) AS centroid,
                COUNT(*) AS total,
                COUNT(DISTINCT user_id) AS users,
                MAX(created_at) AS latest
         FROM unmet_demand
         WHERE cluster_id IS NOT NULL AND embedding IS NOT NULL
         GROUP BY cluster_id
       ) sub
       WHERE c.id = sub.cluster_id`
    )

    // ── 3. Graduate clusters that crossed a threshold ───────────────────────
    const promoted = await query<{
      id: string
      label: string
      intent: string
      unique_user_count: number
      new_status: string
    }>(
      `UPDATE demand_clusters
       SET status = CASE
             WHEN unique_user_count >= $2 THEN 'building'
             WHEN unique_user_count >= $1 THEN 'candidate'
             ELSE status
           END,
           updated_at = now()
       WHERE status = 'observing'
         AND unique_user_count >= $1
       RETURNING id, label, intent, unique_user_count, status AS new_status`,
      [CANDIDATE_THRESHOLD, BUILDING_THRESHOLD]
    )

    for (const p of promoted.rows) {
      await query(
        `INSERT INTO events (event_type, metadata)
         VALUES ('demand_cluster_promoted', $1)`,
        [
          JSON.stringify({
            clusterId: p.id,
            label: p.label,
            intent: p.intent,
            uniqueUsers: p.unique_user_count,
            newStatus: p.new_status,
          }),
        ]
      )

      logger.warn(
        {
          label: p.label,
          intent: p.intent,
          users: p.unique_user_count,
          status: p.new_status,
        },
        '📈 Demand cluster promoted — real product signal, review this'
      )
    }

    // ── 4. Report the top unmet asks ────────────────────────────────────────
    const top = await query<{
      label: string
      intent: string
      request_count: number
      unique_user_count: number
      status: string
    }>(
      `SELECT label, intent, request_count, unique_user_count, status
       FROM demand_clusters
       WHERE unique_user_count >= 3
       ORDER BY unique_user_count DESC
       LIMIT 8`
    )

    if (top.rows.length > 0) {
      logger.info(
        {
          topUnmetDemand: top.rows.map(
            (r) => `${r.label} (${r.intent}): ${r.unique_user_count} users [${r.status}]`
          ),
        },
        'Unmet demand leaderboard'
      )
    }

    logger.info(
      { processed: unclustered.rows.length, assigned, created, promoted: promoted.rows.length },
      'Demand clustering complete'
    )
  },
  { connection: { url: process.env.REDIS_URL! } }
)
