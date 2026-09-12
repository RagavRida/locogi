import type { FastifyInstance } from 'fastify'
import { query } from '../lib/db'
import { requireAuth } from '../lib/auth'
import { vendorRepo } from '../repositories'
import { TravelService } from '../services/travel.service'

const travel = new TravelService()

/**
 * Ops routes — one endpoint that answers "does anything need me today?"
 *
 * The problem with the agentic layer is not that it lacks visibility. It has
 * five separate inspection endpoints. The problem is that inspection endpoints
 * are things you have to REMEMBER to open, and nobody remembers on day 40.
 *
 * So: one digest with a single number, plus a scheduled job that pushes it when
 * the number is non-zero. Rot becomes loud instead of silent.
 */
export async function opsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ─── The only endpoint anyone needs to check ─────────────────────────────────
  app.get('/ops/digest', async (_req, reply) => {
    const queue = await query<{
      queue: string
      urgency: string
      count: string
      oldest_hours: string
    }>(
      `SELECT queue, urgency, COUNT(*) AS count,
              MAX(age_hours)::integer AS oldest_hours
       FROM ops_review_queue
       GROUP BY queue, urgency
       ORDER BY
         CASE urgency WHEN 'critical' THEN 3 WHEN 'high' THEN 2
                      WHEN 'normal' THEN 1 ELSE 0 END DESC,
         COUNT(*) DESC`
    )

    const items = queue.rows.map((r) => ({
      queue: r.queue,
      urgency: r.urgency,
      count: Number(r.count),
      oldestHours: Number(r.oldest_hours),
    }))

    const total = items.reduce((s, i) => s + i.count, 0)
    const critical = items
      .filter((i) => i.urgency === 'critical')
      .reduce((s, i) => s + i.count, 0)

    // Anything critical sitting for over 24h is a genuine failure of process
    const stale = items.filter(
      (i) => i.urgency === 'critical' && i.oldestHours > 24
    )

    // Travel model calibration — is it rejecting jobs it shouldn't?
    const travelAccuracy = await travel.getModelAccuracy()

    // Is the agentic layer actually learning, or still on bootstrap priors?
    const learning = await query<{
      bootstrap: string
      learned: string
      needs_review: string
      generated_questions: string
      bootstrap_questions: string
      geo_cached: string
    }>(
      `SELECT
        (SELECT COUNT(*) FROM agent_knowledge WHERE source = 'bootstrap' AND status = 'active') AS bootstrap,
        (SELECT COUNT(*) FROM agent_knowledge WHERE source IN ('learned','agent') AND status = 'active') AS learned,
        (SELECT COUNT(*) FROM agent_knowledge WHERE status = 'needs_review') AS needs_review,
        (SELECT COUNT(*) FROM learned_questions WHERE origin = 'generated') AS generated_questions,
        (SELECT COUNT(*) FROM learned_questions WHERE origin = 'bootstrap' AND status = 'active') AS bootstrap_questions,
        (SELECT COUNT(*) FROM geo_cache WHERE resolution_failed = false) AS geo_cached`
    )
    const l = learning.rows[0]

    return reply.send({
      needsAttention: total,
      criticalCount: critical,
      staleCritical: stale.length,

      // The headline. If this reads clean, nothing else matters today.
      verdict:
        critical > 0
          ? `⚠️ ${critical} CRITICAL item${critical === 1 ? '' : 's'} waiting — ` +
            `agent-proposed safety patterns are inert until reviewed.`
          : total > 0
          ? `${total} items to review. Nothing critical.`
          : '✅ Nothing needs attention.',

      queues: items,

      travelModel: travelAccuracy,

      learningHealth: {
        bootstrapBeliefs: Number(l?.bootstrap ?? 0),
        learnedBeliefs: Number(l?.learned ?? 0),
        needsReview: Number(l?.needs_review ?? 0),
        generatedQuestions: Number(l?.generated_questions ?? 0),
        stillBootstrapQuestions: Number(l?.bootstrap_questions ?? 0),
        geoCacheSize: Number(l?.geo_cached ?? 0),
        // The key signal: is the agent replacing its priors, or coasting?
        note:
          Number(l?.learned ?? 0) === 0
            ? 'Agent has learned NOTHING yet — every belief is still a seeded ' +
              'prior. Expected before real traffic; concerning after a week of it.'
            : `Agent has replaced ${l?.learned} priors with learned beliefs.`,
      },
    })
  })

  // ─── Full queue detail ──────────────────────────────────────────────────────
  app.get<{ Querystring: { queue?: string } }>('/ops/queue', async (req, reply) => {
    const result = await query<{
      queue: string
      item_id: string
      summary: string
      detail: string | null
      urgency: string
      age_hours: string
    }>(
      `SELECT queue, item_id, summary, detail, urgency, age_hours::integer
       FROM ops_review_queue
       ${req.query.queue ? 'WHERE queue = $1' : ''}
       ORDER BY
         CASE urgency WHEN 'critical' THEN 3 WHEN 'high' THEN 2 ELSE 1 END DESC,
         age_hours DESC
       LIMIT 100`,
      req.query.queue ? [req.query.queue] : []
    )

    return reply.send({
      items: result.rows.map((r) => ({
        queue: r.queue,
        itemId: r.item_id,
        summary: r.summary,
        detail: r.detail,
        urgency: r.urgency,
        ageHours: Number(r.age_hours),
        // Where to go to act on it
        actionEndpoint: ACTION_ENDPOINTS[r.queue] ?? null,
      })),
    })
  })

  // ─── Travel model calibration ───────────────────────────────────────────────
  app.get('/ops/travel-model', async (_req, reply) => {
    const accuracy = await travel.getModelAccuracy()

    const overrides = await query<{
      id: string
      estimated_travel_minutes: number
      available_gap_minutes: number
      estimated_km: string
      override_reason: string | null
      outcome: string | null
      created_at: string
    }>(
      `SELECT id, estimated_travel_minutes, available_gap_minutes,
              estimated_km, override_reason, outcome, created_at
       FROM travel_rejections
       WHERE vendor_overrode = true
       ORDER BY created_at DESC
       LIMIT 30`
    )

    return reply.send({
      ...accuracy,
      recentOverrides: overrides.rows,
      howToCorrect:
        'If vendors consistently override and arrive on time, the estimates ' +
        'are too conservative. Raise the speed via POST /knowledge/assert with ' +
        "domain='travel_speed', subject='<mode>', key='kmph'.",
    })
  })

  // ─── Vendor override of a travel rejection ──────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/ops/travel-rejections/:id/override',
    async (req, reply) => {
      const { reason } = (req.body ?? {}) as { reason?: string }
      if (!reason || reason.length < 5) {
        return reply.code(400).send({
          message: 'Tell us why you can make it — helps us fix our estimates.',
        })
      }

      const vendorId = await vendorRepo.findIdByUserId(req.user!.id)
      if (!vendorId) return reply.code(400).send({ message: 'No vendor profile' })

      const ok = await travel.recordOverride(req.params.id, vendorId, reason)
      return reply.code(ok ? 200 : 404).send({
        success: ok,
        message: ok
          ? 'Noted. Send your quote again with overrideTravelWarning: true.'
          : 'Could not find that rejection.',
      })
    }
  )
}

const ACTION_ENDPOINTS: Record<string, string> = {
  safety_pattern: 'POST /knowledge/safety/proposed/:id/approve',
  knowledge_review: 'POST /knowledge/assert',
  scope_boundary: 'POST /knowledge/scope/:slug/activate',
  unresolved_geo: 'POST /knowledge/assert (or add coordinates manually)',
  duplicate_category: 'POST /categories/merge',
  travel_model_dispute: 'GET /ops/travel-model then POST /knowledge/assert',
}
