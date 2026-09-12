import { Worker } from 'bullmq'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { NotificationService } from '../services/notification.service'
import { TravelService } from '../services/travel.service'

const notifications = new NotificationService()
const travel = new TravelService()

/**
 * Ops digest worker. Runs daily at 9am IST.
 *
 * THE PROBLEM THIS SOLVES
 * ───────────────────────
 * The agentic layer has five inspection endpoints. That is not the problem.
 * The problem is that inspection endpoints require someone to REMEMBER to open
 * them, and nobody remembers on day 40. Meanwhile:
 *
 *   • Agent-proposed safety patterns sit INERT — real missed emergencies stay
 *     missed because nobody clicked approve
 *   • Contradicted beliefs persist and keep producing bad decisions
 *   • Unresolvable geography silently degrades matching
 *
 * Hardcoded behaviour at least shows up in a git diff. Learned behaviour rots
 * invisibly. So the fix is not another dashboard — it is a push.
 *
 * ESCALATION
 * ──────────
 * A critical item unreviewed for 24h escalates the log level to error, so
 * whatever is watching Sentry or the log pipeline sees it even if nobody reads
 * the notification.
 */
export const opsDigestWorker = new Worker(
  'ops-digest',
  async () => {
    const queue = await query<{
      queue: string
      urgency: string
      count: string
      oldest_hours: string
    }>(
      `SELECT queue, urgency, COUNT(*) AS count,
              MAX(age_hours)::integer AS oldest_hours
       FROM ops_review_queue
       GROUP BY queue, urgency`
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
    const staleCritical = items.filter(
      (i) => i.urgency === 'critical' && i.oldestHours > 24
    )

    // ── Nothing to say? Say nothing. A daily "all clear" trains people to
    //    ignore the channel, which defeats the purpose.
    if (total === 0) {
      logger.info('Ops digest: nothing needs attention')
      return
    }

    // ── Escalate stale critical items to error level ────────────────────────
    if (staleCritical.length > 0) {
      logger.error(
        {
          staleQueues: staleCritical.map(
            (s) => `${s.queue}: ${s.count} items, oldest ${s.oldestHours}h`
          ),
        },
        '🚨 OPS ESCALATION: critical review items unattended for over 24 hours. ' +
        'Agent-proposed safety patterns are INERT until approved — a missed ' +
        'emergency phrasing may still be missed.'
      )
    }

    // ── Travel model calibration drift ──────────────────────────────────────
    const travelAccuracy = await travel.getModelAccuracy()
    if (travelAccuracy.overrideRate > 0.5 && travelAccuracy.totalRejections > 10) {
      logger.warn(
        travelAccuracy,
        'Travel model may be too conservative — vendors override most rejections'
      )
    }

    // ── Is the agent actually learning? ─────────────────────────────────────
    const learning = await query<{ bootstrap: string; learned: string }>(
      `SELECT
         (SELECT COUNT(*) FROM agent_knowledge
          WHERE source = 'bootstrap' AND status = 'active') AS bootstrap,
         (SELECT COUNT(*) FROM agent_knowledge
          WHERE source IN ('learned','agent') AND status = 'active') AS learned`
    )
    const bootstrapCount = Number(learning.rows[0]?.bootstrap ?? 0)
    const learnedCount = Number(learning.rows[0]?.learned ?? 0)

    // After a week of traffic, still zero learned beliefs means the learning
    // loops are not firing — a silent failure worth surfacing.
    const requestVolume = await query<{ count: string }>(
      `SELECT COUNT(*) FROM requests WHERE created_at > now() - interval '7 days'`
    )
    const weeklyRequests = Number(requestVolume.rows[0]?.count ?? 0)

    if (weeklyRequests > 50 && learnedCount === 0) {
      logger.error(
        { weeklyRequests, bootstrapCount },
        '🚨 Agent has learned NOTHING despite real traffic. The learning loops ' +
        'are likely broken — check embedding jobs and the taxonomy worker.'
      )
    }

    // ── Build the message ───────────────────────────────────────────────────
    const lines = items
      .sort((a, b) => {
        const rank = { critical: 3, high: 2, normal: 1, low: 0 }
        return (
          (rank[b.urgency as keyof typeof rank] ?? 0) -
          (rank[a.urgency as keyof typeof rank] ?? 0)
        )
      })
      .map((i) => {
        const icon =
          i.urgency === 'critical' ? '🔴' : i.urgency === 'high' ? '🟠' : '🟡'
        const age = i.oldestHours > 24 ? ` (oldest ${Math.floor(i.oldestHours / 24)}d)` : ''
        return `${icon} ${i.count} × ${QUEUE_LABELS[i.queue] ?? i.queue}${age}`
      })

    const body =
      lines.join('\n') +
      `\n\n${learnedCount} learned beliefs, ${bootstrapCount} still on seeded priors.` +
      (travelAccuracy.totalRejections > 0
        ? `\nTravel model: ${travelAccuracy.verdict}`
        : '')

    // ── Notify whoever is on the ops list ───────────────────────────────────
    const admins = await query<{ id: string }>(
      `SELECT id FROM users WHERE is_ops_reviewer = true AND is_banned = false`
    ).catch(() => ({ rows: [] as Array<{ id: string }> }))

    if (admins.rows.length === 0) {
      // No reviewer configured. This itself is the problem worth shouting about.
      logger.error(
        { total, critical },
        '🚨 Ops digest has items to review but NO user has is_ops_reviewer = true. ' +
        'Nobody is watching the agentic layer. Set a reviewer.'
      )
      return
    }

    for (const admin of admins.rows) {
      await notifications
        .deliver(
          admin.id,
          {
            title:
              critical > 0
                ? `🔴 ${critical} critical review item${critical === 1 ? '' : 's'}`
                : `${total} items to review`,
            body,
            data: { type: 'ops_digest', deepLink: 'locogi://ops' },
          },
          critical > 0 // critical digests fall through to WhatsApp
        )
        .catch((err) => logger.error({ err }, 'Ops digest delivery failed'))
    }

    logger.info(
      { total, critical, staleCritical: staleCritical.length, notified: admins.rows.length },
      'Ops digest sent'
    )
  },
  { connection: { url: process.env.REDIS_URL! } }
)

const QUEUE_LABELS: Record<string, string> = {
  safety_pattern: 'agent-proposed safety patterns (INERT until approved)',
  knowledge_review: 'beliefs that lost confidence',
  scope_boundary: 'proposed scope boundaries',
  unresolved_geo: 'unresolvable locations',
  duplicate_category: 'near-duplicate categories',
  travel_model_dispute: 'travel rejections vendors overrode',
}
