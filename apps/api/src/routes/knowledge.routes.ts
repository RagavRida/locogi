import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../lib/auth'
import { KnowledgeService } from '../services/knowledge.service'
import { QuestionService } from '../services/question.service'
import { GeocodingService } from '../services/geocoding.service'
import { SafetyRulesetService } from '../services/safety-ruleset'
import { ScopeService } from '../services/scope.service'

const knowledge = new KnowledgeService()
const questions = new QuestionService()
const geocoding = new GeocodingService()
const safety = new SafetyRulesetService()
const scope = new ScopeService()

/**
 * Knowledge routes — inspect and correct what the agent has learned.
 *
 * Once behaviour comes from learned knowledge rather than code, two things
 * become mandatory: you must be able to SEE what it believes, and you must be
 * able to CORRECT it without a deploy. Otherwise "agentic" just means
 * "unpredictable".
 */
export async function knowledgeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ─── What does the agent currently believe? ──────────────────────────────────
  app.get<{ Querystring: { domain?: string; subject?: string } }>(
    '/knowledge',
    async (req, reply) => {
      const { domain, subject } = req.query
      if (!domain) {
        return reply.code(400).send({ message: 'domain is required' })
      }

      const { query } = await import('../lib/db')
      const result = await query<{
        subject: string
        key: string
        value: unknown
        source: string
        confidence: string
        evidence_count: number
        reasoning: string | null
      }>(
        `SELECT subject, key, value, source, confidence, evidence_count, reasoning
         FROM effective_knowledge
         WHERE domain = $1 ${subject ? 'AND subject = $2' : ''}
         ORDER BY subject, key
         LIMIT 200`,
        subject ? [domain, subject] : [domain]
      )

      return reply.send({
        beliefs: result.rows.map((r) => ({
          subject: r.subject,
          key: r.key,
          value: r.value,
          source: r.source,
          confidence: Number(r.confidence),
          evidenceCount: r.evidence_count,
          reasoning: r.reasoning,
          isStillBootstrap: r.source === 'bootstrap',
        })),
      })
    }
  )

  // ─── Beliefs the agent has lost confidence in ────────────────────────────────
  app.get('/knowledge/needs-review', async (_req, reply) => {
    const items = await knowledge.getNeedsReview(50)
    return reply.send({
      items,
      note:
        'These beliefs were contradicted by evidence or produced bad outcomes. ' +
        'Asserting a correct value here overrides the agent permanently.',
    })
  })

  // ─── Human override ─────────────────────────────────────────────────────────
  app.post('/knowledge/assert', async (req, reply) => {
    const Schema = z.object({
      domain: z.string().min(2).max(60),
      subject: z.string().min(1).max(120),
      key: z.string().min(1).max(60),
      value: z.unknown(),
      reasoning: z.string().min(5).max(500),
    })

    const parsed = Schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    // z.unknown() infers as OPTIONAL, so spreading parsed.data would let an
    // admin assert a fact with no value at all — writing empty knowledge that
    // then outranks learned facts, because admin is the highest source tier.
    // Check presence explicitly rather than papering over it with a cast.
    if (parsed.data.value === undefined) {
      return reply.code(400).send({ message: 'A value is required' })
    }

    await knowledge.adminAssert({
      domain: parsed.data.domain,
      subject: parsed.data.subject,
      key: parsed.data.key,
      value: parsed.data.value,
      reasoning: parsed.data.reasoning,
      adminUserId: req.user!.id,
    })

    return reply.send({
      success: true,
      message:
        'Asserted at the admin tier. This now overrides anything the agent ' +
        'learns, until you change it.',
    })
  })

  // ─── Follow-up question performance ─────────────────────────────────────────
  app.get('/knowledge/questions', async (_req, reply) => {
    const performance = await questions.getPerformance()
    return reply.send({
      questions: performance,
      note:
        'answerRate below 25% after 20 asks triggers automatic retirement. ' +
        "origin='bootstrap' means it came from the original hardcoded set and " +
        'has not yet been replaced by a generated one.',
    })
  })

  // ─── Geocoding cache health ─────────────────────────────────────────────────
  app.get('/knowledge/geo-cache', async (_req, reply) => {
    const stats = await geocoding.getCacheStats()
    return reply.send({
      ...stats,
      note:
        'unresolvedQueries shows geography users type that we cannot resolve. ' +
        'These are candidates for manual coordinates or a provider change.',
    })
  })

  // ─── Safety ruleset status + proposals ──────────────────────────────────────
  app.get('/knowledge/safety/status', async (_req, reply) => {
    const status = safety.getStatus()
    return reply.send({
      ...status,
      warning: status.usingFloor
        ? 'DEGRADED: running on the hardcoded emergency floor, not the full ' +
          'ruleset. The database load failed. Investigate immediately.'
        : null,
    })
  })

  app.get('/knowledge/safety/proposed', async (_req, reply) => {
    const proposed = await safety.getProposed()
    return reply.send({
      proposed,
      note:
        'Agent-proposed patterns are INERT until approved. Each was suggested ' +
        'because the semantic second pass believed the deterministic check ' +
        'missed a real emergency. Review the regex carefully — an over-broad ' +
        'pattern will spam users with emergency warnings.',
    })
  })

  app.post<{ Params: { id: string } }>(
    '/knowledge/safety/proposed/:id/approve',
    async (req, reply) => {
      const ok = await safety.approve(req.params.id, req.user!.id)
      return reply.code(ok ? 200 : 404).send({
        success: ok,
        message: ok
          ? 'Approved and live immediately — the ruleset was recompiled.'
          : 'Not found, or already reviewed.',
      })
    }
  )

  app.post<{ Params: { id: string } }>(
    '/knowledge/safety/proposed/:id/reject',
    async (req, reply) => {
      const ok = await safety.reject(req.params.id, req.user!.id)
      return reply.code(ok ? 200 : 404).send({ success: ok })
    }
  )

  // ─── Scope boundaries awaiting review ───────────────────────────────────────
  app.get('/knowledge/scope/testing', async (_req, reply) => {
    const { query } = await import('../lib/db')
    const result = await query<{
      slug: string
      label: string
      reason: string
      canonical_description: string
      source: string
      times_matched: number
      false_positive_count: number
    }>(
      `SELECT slug, label, reason, canonical_description, source,
              times_matched, false_positive_count
       FROM out_of_scope_categories
       WHERE status = 'testing'
       ORDER BY times_matched DESC`
    )

    return reply.send({
      boundaries: result.rows,
      note:
        "Boundaries with source='agent' were proposed from demand clusters. " +
        'They are matched but marked testing — verify the description is ' +
        'accurate before promoting to active.',
    })
  })

  app.post<{ Params: { slug: string } }>(
    '/knowledge/scope/:slug/activate',
    async (req, reply) => {
      const { query } = await import('../lib/db')
      const result = await query(
        `UPDATE out_of_scope_categories
         SET status = 'active' WHERE slug = $1 AND status = 'testing'`,
        [req.params.slug]
      )
      return reply.code((result.rowCount ?? 0) > 0 ? 200 : 404).send({
        success: (result.rowCount ?? 0) > 0,
      })
    }
  )

  // ─── Teach the role boundary a new exemplar ─────────────────────────────────
  app.post('/knowledge/role-exemplar', async (req, reply) => {
    const Schema = z.object({
      text: z.string().min(3).max(120),
      isServiceRole: z.boolean(),
      reasoning: z.string().min(5).max(300),
    })

    const parsed = Schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    await scope.learnExemplarFromOutcome(
      parsed.data.text,
      parsed.data.isServiceRole,
      `${parsed.data.reasoning} [taught by ${req.user!.id}]`
    )

    return reply.send({
      success: true,
      message:
        'Exemplar added. The role boundary will use it for future judgements.',
    })
  })
}
