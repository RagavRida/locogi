import type { FastifyInstance } from 'fastify'
import { query } from '../lib/db'
import { requireAuth } from '../lib/auth'

/**
 * Insights routes — what people asked for that we could not serve.
 *
 * This is the most valuable data the product generates. Every rejected query
 * is a signal about what Locogi should become. "Find me a library" isn't a
 * failure to be discarded; it's evidence.
 */
export async function insightsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ─── Unmet demand leaderboard ───────────────────────────────────────────────
  app.get('/insights/unmet-demand', async (_req, reply) => {
    const clusters = await query<{
      id: string
      label: string
      intent: string
      request_count: number
      unique_user_count: number
      status: string
      first_seen: string
      last_seen: string
    }>(
      `SELECT id, label, intent, request_count, unique_user_count,
              status, first_seen, last_seen
       FROM demand_clusters
       ORDER BY unique_user_count DESC, request_count DESC
       LIMIT 50`
    )

    const byIntent = await query<{ intent: string; total: string; users: string }>(
      `SELECT intent, COUNT(*) AS total, COUNT(DISTINCT user_id) AS users
       FROM unmet_demand
       GROUP BY intent
       ORDER BY COUNT(*) DESC`
    )

    // How often are we actually resolving these usefully?
    const resolution = await query<{ resolution_type: string | null; count: string }>(
      `SELECT resolution_type, COUNT(*) AS count
       FROM unmet_demand
       GROUP BY resolution_type`
    )

    return reply.send({
      clusters: clusters.rows.map((c) => ({
        id: c.id,
        label: c.label,
        intent: c.intent,
        requestCount: c.request_count,
        uniqueUsers: c.unique_user_count,
        status: c.status,
        firstSeen: c.first_seen,
        lastSeen: c.last_seen,
      })),
      byIntent: byIntent.rows.map((r) => ({
        intent: r.intent,
        total: Number(r.total),
        uniqueUsers: Number(r.users),
      })),
      resolutionBreakdown: resolution.rows.map((r) => ({
        type: r.resolution_type ?? 'unhandled',
        count: Number(r.count),
      })),
    })
  })

  // ─── Raw asks inside one cluster ────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/insights/unmet-demand/:id',
    async (req, reply) => {
      const items = await query<{
        raw_text: string
        extracted_topic: string | null
        agent_response: string | null
        was_resolved: boolean
        resolution_type: string | null
        created_at: string
      }>(
        `SELECT raw_text, extracted_topic, agent_response,
                was_resolved, resolution_type, created_at
         FROM unmet_demand
         WHERE cluster_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.params.id]
      )
      return reply.send({ items: items.rows })
    }
  )

  // ─── Mark a product decision on a cluster ──────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/insights/unmet-demand/:id',
    async (req, reply) => {
      const { status, decisionNote } = (req.body ?? {}) as {
        status?: string
        decisionNote?: string
      }

      const valid = ['observing', 'candidate', 'building', 'launched', 'rejected']
      if (!status || !valid.includes(status)) {
        return reply.code(400).send({ message: `status must be one of: ${valid.join(', ')}` })
      }

      await query(
        `UPDATE demand_clusters
         SET status = $2, decision_note = $3, updated_at = now()
         WHERE id = $1`,
        [req.params.id, status, decisionNote ?? null]
      )

      return reply.send({ success: true })
    }
  )

  // ─── Supply gaps (categories with demand but not enough vendors) ───────────
  app.get('/insights/supply-gaps', async (_req, reply) => {
    const gaps = await query<{
      id: string
      canonical_name: string
      vendor_count: number
      request_count: number
      ratio: number
      avg_price: number | null
    }>(
      `SELECT id, canonical_name, vendor_count, request_count, avg_price,
              CASE WHEN vendor_count = 0 THEN request_count::numeric
                   ELSE request_count::numeric / vendor_count END AS ratio
       FROM service_categories
       WHERE request_count > 0
       ORDER BY ratio DESC
       LIMIT 25`
    )

    // Categories customers asked for where no vendor exists at all
    const unserved = await query<{ tag: string; count: string }>(
      `SELECT metadata->>'tag' AS tag, COUNT(*) AS count
       FROM events
       WHERE event_type = 'unserved_category_demand'
       GROUP BY metadata->>'tag'
       ORDER BY COUNT(*) DESC
       LIMIT 20`
    )

    return reply.send({
      gaps: gaps.rows.map((g) => ({
        categoryId: g.id,
        name: g.canonical_name,
        vendorCount: g.vendor_count,
        requestCount: g.request_count,
        demandPerVendor: Math.round(Number(g.ratio) * 100) / 100,
        avgPrice: g.avg_price,
        severity:
          Number(g.ratio) > 10 ? 'critical' :
          Number(g.ratio) > 5 ? 'high' :
          Number(g.ratio) > 2 ? 'moderate' : 'healthy',
      })),
      unservedCategories: unserved.rows.map((u) => ({
        tag: u.tag,
        askCount: Number(u.count),
      })),
    })
  })

  // ─── Where demand is coming from geographically ────────────────────────────
  app.get('/insights/demand-heatmap', async (_req, reply) => {
    const result = await query<{
      h3_r7: string
      total: string
      intents: string
    }>(
      `SELECT h3_r7,
              COUNT(*) AS total,
              STRING_AGG(DISTINCT intent, ',') AS intents
       FROM unmet_demand
       WHERE h3_r7 IS NOT NULL
       GROUP BY h3_r7
       ORDER BY COUNT(*) DESC
       LIMIT 100`
    )

    return reply.send({
      cells: result.rows.map((r) => ({
        h3Index: r.h3_r7,
        count: Number(r.total),
        intents: r.intents.split(','),
      })),
    })
  })
}
