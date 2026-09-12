/**
 * SafetyRuleset — the deliberate architectural exception.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS ISN'T FULLY AGENTIC, ARGUED PLAINLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything else in this codebase moved from hardcoded lookups to learned
 * knowledge with semantic matching. Emergency detection does not, and the
 * reason is a latency budget measured in human consequences:
 *
 *   Semantic / LLM path:  300ms – 15s, can rate-limit, can time out,
 *                         can be down, can hallucinate, needs network
 *   In-memory regex path: ~0.01ms, cannot fail, cannot be down
 *
 * A person typing "my father can't breathe" is not a matching problem. They
 * need the number 108 on screen before they finish reading the sentence. Any
 * network dependency between that person and an ambulance is an unacceptable
 * design choice, no matter how much better the recall might be.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RESOLUTION: AGENTIC AUTHORING, DETERMINISTIC EXECUTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   • The ruleset lives in the database, so it evolves without a deploy
 *   • The agent PROPOSES patterns from cases it believes were missed
 *   • A human APPROVES before anything goes active — a bad regex here either
 *     misses an emergency or floods users with false alarms
 *   • Responses (including emergency phone numbers) are DB-editable by ops
 *   • On boot, active rows compile into in-memory RegExp objects
 *   • Runtime is pure CPU: zero I/O, zero awaits, sub-millisecond
 *
 * So the knowledge is genuinely learned and improvable. The hot path is not.
 * That is the correct tradeoff for this specific problem, not an oversight.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ADDITIONALLY: a semantic second pass runs AFTER the deterministic one, on
 * requests that passed. It cannot delay a real emergency (that already fired),
 * but it catches phrasings the regex missed and feeds them back as proposals.
 * Best of both: fast floor, learning ceiling.
 */

import { query } from '../lib/db'
import { generateEmbedding } from '../lib/nim'
import { runTask } from '../ai/contract'
import { reviewSafetyTask } from '../ai/tasks/review-safety'
import { logger } from '../lib/logger'
import { z } from 'zod'

export type Severity = 'critical' | 'urgent' | 'advice'

interface CompiledPattern {
  id: string
  regex: RegExp
  label: string
  severity: Severity
  responseKey: string
}

export interface SafetyCheck {
  triggered: boolean
  severity: Severity | 'none'
  label?: string
  patternId?: string
  forcedResponse?: string
}

/**
 * Compiled, in-memory ruleset. Loaded at boot, refreshed on a timer.
 * All lookups against this are synchronous by design.
 */
class CompiledRuleset {
  private critical: CompiledPattern[] = []
  private urgent: CompiledPattern[] = []
  private advice: CompiledPattern[] = []
  private responses = new Map<string, string>()
  private loadedAt: Date | null = null
  private isLoaded = false

  /**
   * Hardcoded last-resort floor.
   *
   * If the database is unreachable at boot, we do NOT start with zero
   * emergency coverage. These few patterns are the minimum that must always
   * work, even in total infrastructure failure. This is intentional
   * redundancy, not the primary ruleset.
   */
  private static readonly EMERGENCY_FLOOR: Array<[RegExp, string, Severity]> = [
    [/\b(chest pain|heart attack|cardiac arrest)\b/i, 'cardiac', 'critical'],
    [/\b(can'?t breathe|cannot breathe|not breathing)\b/i, 'respiratory', 'critical'],
    [/\b(unconscious|unresponsive)\b/i, 'unconscious', 'critical'],
    [/\b(suicide|kill myself|end my life)\b/i, 'self_harm', 'critical'],
    [/\b(severe bleeding|heavy bleeding)\b/i, 'bleeding', 'critical'],
    [/\b(overdose|poisoned)\b/i, 'poisoning', 'critical'],
    [/\b(seizure|convulsion)\b/i, 'seizure', 'critical'],
  ]

  private static readonly FLOOR_RESPONSE =
    '🚨 This sounds like an emergency. Please call **108** (ambulance) or ' +
    '**112** right now.\n\n' +
    'For mental health support: **Tele-MANAS 14416** (free, 24×7).\n\n' +
    "I'm a booking app and cannot help with emergencies — please call now."

  /**
   * Self-harm gets its own floor response, and the difference is not cosmetic.
   *
   * Telling someone in a suicidal crisis to "call an ambulance" is the wrong
   * referral: it is the wrong service, it reads as bureaucratic at the worst
   * possible moment, and it omits the helplines that actually exist for this.
   * The generic response leads with 108; this one leads with a human being.
   *
   * Numbers are Indian national services, free and 24×7:
   *   Tele-MANAS 14416 — Government of India mental health programme
   *   AASRA 9152987821 — long-running suicide prevention helpline
   * 112 stays listed last for immediate physical danger.
   */
  private static readonly SELF_HARM_RESPONSE =
    "I'm really glad you said something, and I want you to talk to someone " +
    'who can help right now.\n\n' +
    '**Tele-MANAS 14416** — free, 24×7, government mental health helpline\n' +
    '**AASRA 9152987821** — 24×7 suicide prevention helpline\n\n' +
    "If you're in immediate danger, call **112**.\n\n" +
    "I'm only a booking app — I can't be the support you need, but the " +
    'people on those lines can be. Please call one of them.'

  async load(): Promise<{ loaded: number; usedFloor: boolean }> {
    try {
      const patterns = await query<{
        id: string
        pattern: string
        label: string
        severity: Severity
        response_key: string
      }>(
        `SELECT id, pattern, label, severity, response_key
         FROM safety_patterns
         WHERE status = 'active'
         ORDER BY severity, label`
      )

      const responses = await query<{ response_key: string; body: string }>(
        `SELECT response_key, body FROM safety_responses`
      )

      const nextCritical: CompiledPattern[] = []
      const nextUrgent: CompiledPattern[] = []
      const nextAdvice: CompiledPattern[] = []
      let skipped = 0

      for (const p of patterns.rows) {
        let regex: RegExp
        try {
          regex = new RegExp(p.pattern, 'i')
        } catch (err) {
          // An invalid regex in the DB must not take down the whole ruleset
          logger.error(
            { patternId: p.id, pattern: p.pattern, err },
            'Invalid safety regex in database — skipped'
          )
          skipped++
          continue
        }

        const compiled: CompiledPattern = {
          id: p.id,
          regex,
          label: p.label,
          severity: p.severity,
          responseKey: p.response_key,
        }

        if (p.severity === 'critical') nextCritical.push(compiled)
        else if (p.severity === 'urgent') nextUrgent.push(compiled)
        else nextAdvice.push(compiled)
      }

      // Refuse to load an empty critical set — that would silently disable
      // emergency detection, which is worse than keeping the previous ruleset
      if (nextCritical.length === 0) {
        logger.error(
          'Safety ruleset load produced ZERO critical patterns — keeping previous ruleset and falling back to floor'
        )
        if (!this.isLoaded) this.loadFloor()
        return { loaded: 0, usedFloor: !this.isLoaded }
      }

      // Atomic swap
      this.critical = nextCritical
      this.urgent = nextUrgent
      this.advice = nextAdvice
      this.responses = new Map(responses.rows.map((r) => [r.response_key, r.body]))
      this.loadedAt = new Date()
      this.isLoaded = true

      logger.info(
        {
          critical: nextCritical.length,
          urgent: nextUrgent.length,
          advice: nextAdvice.length,
          responses: this.responses.size,
          skipped,
        },
        'Safety ruleset compiled into memory'
      )

      return { loaded: patterns.rows.length - skipped, usedFloor: false }
    } catch (err) {
      logger.error(
        { err },
        'Could not load safety ruleset from DB — using hardcoded emergency floor'
      )
      this.loadFloor()
      return { loaded: this.critical.length, usedFloor: true }
    }
  }

  private loadFloor(): void {
    this.critical = CompiledRuleset.EMERGENCY_FLOOR.map(([regex, label, severity], i) => ({
      id: `floor_${i}`,
      regex,
      label,
      severity,
      // Self-harm must not fall through to the ambulance message
      responseKey: label === 'self_harm' ? 'floor_self_harm' : 'floor',
    }))
    this.urgent = []
    this.advice = []
    this.responses = new Map([
      ['floor', CompiledRuleset.FLOOR_RESPONSE],
      ['floor_self_harm', CompiledRuleset.SELF_HARM_RESPONSE],
    ])
    this.isLoaded = true
    this.loadedAt = new Date()
  }

  /**
   * THE HOT PATH. Synchronous. No I/O. No awaits. Sub-millisecond.
   */
  check(text: string): SafetyCheck {
    if (!this.isLoaded) this.loadFloor()

    for (const p of this.critical) {
      if (p.regex.test(text)) {
        return {
          triggered: true,
          severity: 'critical',
          label: p.label,
          patternId: p.id,
          // Label-aware fallback: a DB-authored self_harm pattern with a
          // missing response must still not emit the ambulance message.
          forcedResponse:
            this.responses.get(p.responseKey) ??
            (p.label === 'self_harm'
              ? CompiledRuleset.SELF_HARM_RESPONSE
              : CompiledRuleset.FLOOR_RESPONSE),
        }
      }
    }

    for (const p of this.urgent) {
      if (p.regex.test(text)) {
        return {
          triggered: true,
          severity: 'urgent',
          label: p.label,
          patternId: p.id,
          forcedResponse: this.responses.get(p.responseKey),
        }
      }
    }

    for (const p of this.advice) {
      if (p.regex.test(text)) {
        return {
          triggered: true,
          severity: 'advice',
          label: p.label,
          patternId: p.id,
          forcedResponse: this.responses.get(p.responseKey),
        }
      }
    }

    return { triggered: false, severity: 'none' }
  }

  getStatus() {
    return {
      isLoaded: this.isLoaded,
      loadedAt: this.loadedAt,
      criticalCount: this.critical.length,
      urgentCount: this.urgent.length,
      adviceCount: this.advice.length,
      usingFloor: this.critical.some((p) => p.id.startsWith('floor_')),
    }
  }
}

// Module-level singleton — one compiled ruleset per process
const ruleset = new CompiledRuleset()

export class SafetyRulesetService {

  /** Call once at boot, before serving traffic. */
  async initialize(): Promise<void> {
    const result = await ruleset.load()
    if (result.usedFloor) {
      logger.error(
        'SAFETY DEGRADED: running on the hardcoded emergency floor, not the full ruleset'
      )
    }

    // Refresh every 10 minutes so ops edits take effect without a restart
    setInterval(() => {
      ruleset.load().catch((err) =>
        logger.error({ err }, 'Safety ruleset refresh failed — keeping current ruleset')
      )
    }, 10 * 60 * 1000)
  }

  /** Synchronous hot path. */
  check(text: string): SafetyCheck {
    return ruleset.check(text)
  }

  getStatus() {
    return ruleset.getStatus()
  }

  async recordMatch(patternId: string): Promise<void> {
    if (patternId.startsWith('floor_')) return
    await query(
      `UPDATE safety_patterns SET times_matched = times_matched + 1 WHERE id = $1`,
      [patternId]
    ).catch(() => {})
  }

  async reportFalsePositive(patternId: string): Promise<void> {
    if (patternId.startsWith('floor_')) return
    await query(
      `UPDATE safety_patterns
       SET false_positive_reports = false_positive_reports + 1
       WHERE id = $1`,
      [patternId]
    )
    logger.warn({ patternId }, 'Safety pattern false-positive reported')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENTIC LAYER — proposes patterns, never activates them
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Semantic second pass. Runs AFTER the deterministic check has already
   * passed, so it cannot delay a real emergency. Its only job is to catch
   * phrasings the regex missed and turn them into review-ready proposals.
   *
   * Called asynchronously (fire-and-forget) from the request path.
   */
  async semanticSecondPass(text: string, userId: string): Promise<void> {
    try {
      // Cheap pre-filter: only spend an LLM call if the text has any
      // health-adjacent signal at all
      if (!/\b(pain|hurt|help|blood|breath|sick|ill|fever|emergency|urgent|dying|bleeding|unconscious|accident)\b/i.test(text)) {
        return
      }

      const result = await runTask(reviewSafetyTask, { text })

      if (!result.ok) {
        logger.warn(
          { reason: result.reason },
          'Semantic safety pass unavailable — deterministic floor still applies'
        )
        return
      }

      const d = result.data
      if (!d.is_emergency) return


      // A genuine miss. Two things happen:
      //   1. Log it loudly — an operator should look at this today
      //   2. Propose a pattern for review, INERT until approved
      logger.error(
        {
          userId,
          severity: d.severity,
          reasoning: d.reasoning,
          // Deliberately NOT logging the raw text — health data
        },
        '🚨 MISSED EMERGENCY: semantic pass caught what the regex did not. Review urgently.'
      )

      await query(
        `INSERT INTO events (event_type, user_id, metadata)
         VALUES ('emergency_missed_by_regex', $1, $2)`,
        [
          userId,
          JSON.stringify({
            severity: d.severity,
            reasoning: d.reasoning,
            proposedPattern: d.suggested_pattern,
          }),
        ]
      )

      if (d.suggested_pattern && d.label) {
        // The task's output schema already rejected patterns that fail to
        // compile, match the empty string, or carry nested quantifiers, so an
        // unusable regex never reaches here. The old inline `new RegExp()`
        // check only covered the first of those three.

        await query(
          `INSERT INTO safety_patterns
             (pattern, label, severity, response_key, source, status, proposed_reasoning)
           VALUES ($1,$2,$3,$4,'agent_proposed','proposed',$5)
           ON CONFLICT (pattern, label) DO NOTHING`,
          [
            d.suggested_pattern,
            d.label,
            d.severity === 'critical' ? 'critical' : 'urgent',
            d.severity === 'critical' ? 'emergency_medical' : 'urgent_medical',
            d.reasoning,
          ]
        )

        logger.warn(
          { label: d.label, pattern: d.suggested_pattern },
          '🤖 Agent proposed a safety pattern — INERT until a human approves it'
        )
      }
    } catch (err) {
      // This path must never throw into the request cycle
      logger.debug({ err }, 'Semantic safety second pass failed (non-fatal)')
    }
  }

  /** Patterns waiting on human review. */
  async getProposed(): Promise<
    Array<{
      id: string
      pattern: string
      label: string
      severity: string
      reasoning: string | null
      createdAt: string
    }>
  > {
    const result = await query<{
      id: string
      pattern: string
      label: string
      severity: string
      proposed_reasoning: string | null
      created_at: string
    }>(
      `SELECT id, pattern, label, severity, proposed_reasoning, created_at
       FROM safety_patterns
       WHERE status = 'proposed'
       ORDER BY created_at DESC`
    )

    return result.rows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      label: r.label,
      severity: r.severity,
      reasoning: r.proposed_reasoning,
      createdAt: r.created_at,
    }))
  }

  /** Human approval. Only path by which a pattern becomes live. */
  async approve(patternId: string, adminUserId: string): Promise<boolean> {
    const result = await query(
      `UPDATE safety_patterns
       SET status = 'active', approved_by = $2, approved_at = now()
       WHERE id = $1 AND status = 'proposed'`,
      [patternId, adminUserId]
    )

    if ((result.rowCount ?? 0) > 0) {
      await ruleset.load() // take effect immediately
      logger.info({ patternId, adminUserId }, 'Safety pattern approved and live')
      return true
    }
    return false
  }

  async reject(patternId: string, adminUserId: string): Promise<boolean> {
    const result = await query(
      `UPDATE safety_patterns
       SET status = 'rejected', approved_by = $2, approved_at = now()
       WHERE id = $1 AND status = 'proposed'`,
      [patternId, adminUserId]
    )
    return (result.rowCount ?? 0) > 0
  }
}
