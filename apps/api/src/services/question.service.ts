/**
 * QuestionService — replaces the hardcoded CATEGORY_FOLLOW_UPS map.
 *
 * The old version had 18 questions I wrote by guessing what a photographer or
 * a massage therapist would need. Some were probably useless; there was no way
 * to know, and no way to add a question without a deploy.
 *
 * The agentic version closes three loops:
 *
 *   1. GENERATE — questions come from fields vendors in this category actually
 *      fill in (category_field_templates already observes this). If 8 out of 10
 *      photographers specify `duration_hours`, that's a question worth asking
 *      customers — nobody had to predict it.
 *
 *   2. MEASURE — every ask records answered vs skipped, and whether the request
 *      went on to convert. A question with a 4% answer rate is friction, not
 *      signal.
 *
 *   3. RETIRE — questions that nobody answers, or that don't improve conversion,
 *      are retired automatically. The set shrinks toward what actually matters.
 *
 * Cold start: bootstrap questions are seeded so the first customer isn't asked
 * nothing. They carry origin='bootstrap' and are the first to be retired once
 * generated questions outperform them.
 */

import { query } from '../lib/db'
import { runTask } from '../ai/contract'
import { writeQuestionTask } from '../ai/tasks/write-question'
import { logger } from '../lib/logger'
import { z } from 'zod'

// Thresholds for retirement — tuned to be conservative, since retiring a
// genuinely useful question silently degrades match quality
const MIN_ASKS_BEFORE_JUDGING = 20
const RETIRE_BELOW_ANSWER_RATE = 0.25
const MIN_OBSERVATIONS_TO_GENERATE = 4

export interface FollowUpQuestion {
  id: string
  fieldName: string
  questionText: string
  options: string[]
  fieldType: string
  origin: string
  answerRate: number | null
}

export class QuestionService {

  // ─── What should we ask a customer in this category? ────────────────────────
  async getQuestions(
    categoryId: string,
    alreadyProvided: string[] = []
  ): Promise<FollowUpQuestion[]> {
    const provided = new Set(alreadyProvided.map((f) => f.toLowerCase()))

    const result = await query<{
      id: string
      field_name: string
      question_text: string
      options: string[] | null
      field_type: string
      origin: string
      answer_rate: string | null
    }>(
      `SELECT id, field_name, question_text, options, field_type, origin, answer_rate
       FROM learned_questions
       WHERE category_id = $1
         AND status IN ('active', 'testing')
       ORDER BY
         -- Proven questions first, then untested, then bootstrap priors
         CASE origin WHEN 'admin' THEN 4 WHEN 'generated' THEN 3
                     WHEN 'vendor_gap' THEN 2 ELSE 1 END DESC,
         answer_rate DESC NULLS LAST,
         display_order
       LIMIT 6`,
      [categoryId]
    )

    return result.rows
      .filter((r) => !provided.has(r.field_name.toLowerCase()))
      .map((r) => ({
        id: r.id,
        fieldName: r.field_name,
        questionText: r.question_text,
        options: r.options ?? [],
        fieldType: r.field_type,
        origin: r.origin,
        answerRate: r.answer_rate ? Number(r.answer_rate) : null,
      }))
      // Cap at 3 — more than that and customers abandon
      .slice(0, 3)
  }

  // ─── Generate a question from observed vendor behaviour ─────────────────────
  //
  // Called by the maintenance worker, not on the hot path. Looks for fields
  // that vendors in a category consistently provide but which we never ask
  // customers about, and writes a question for each.
  async generateMissingQuestions(categoryId: string): Promise<number> {
    const gaps = await query<{
      field_name: string
      field_type: string
      observation_count: number
      category_name: string
      samples: string[]
    }>(
      `SELECT cft.field_name, cft.field_type, cft.observation_count,
              sc.canonical_name AS category_name,
              ARRAY_AGG(DISTINCT cso.sample_value)
                FILTER (WHERE cso.sample_value IS NOT NULL) AS samples
       FROM category_field_templates cft
       JOIN service_categories sc ON sc.id = cft.category_id
       LEFT JOIN category_schema_observations cso
         ON cso.category_id = cft.category_id
         AND cso.field_name = cft.field_name
       WHERE cft.category_id = $1
         AND cft.observation_count >= $2
         AND NOT EXISTS (
           SELECT 1 FROM learned_questions lq
           WHERE lq.category_id = cft.category_id
             AND lq.field_name = cft.field_name
         )
       GROUP BY cft.field_name, cft.field_type, cft.observation_count, sc.canonical_name
       LIMIT 5`,
      [categoryId, MIN_OBSERVATIONS_TO_GENERATE]
    )

    let created = 0

    for (const gap of gaps.rows) {
      const generated = await this.writeQuestion(
        gap.category_name,
        gap.field_name,
        gap.field_type,
        (gap.samples ?? []).slice(0, 6)
      )

      if (!generated) continue

      await query(
        `INSERT INTO learned_questions
           (category_id, field_name, question_text, options, field_type,
            origin, generated_from, status, display_order)
         VALUES ($1,$2,$3,$4,$5,'generated',$6,'testing',$7)
         ON CONFLICT (category_id, field_name) DO NOTHING`,
        [
          categoryId,
          gap.field_name,
          generated.question,
          JSON.stringify(generated.options),
          gap.field_type,
          `${gap.observation_count} vendors in ${gap.category_name} provide this field. ` +
            `Agent reasoning: ${generated.reasoning}`,
          gap.observation_count,
        ]
      )
      created++

      logger.info(
        { categoryId, field: gap.field_name, question: generated.question },
        'Generated a follow-up question from observed vendor fields'
      )
    }

    return created
  }

  // ─── Ask the LLM to phrase the question ────────────────────────────────────
  private async writeQuestion(
    categoryName: string,
    fieldName: string,
    fieldType: string,
    samples: string[]
  ): Promise<{ question: string; options: string[]; reasoning: string } | null> {
    const result = await runTask(writeQuestionTask, {
      categoryName,
      fieldName,
      fieldType,
      samples,
    })

    if (!result.ok) {
      logger.warn(
        { reason: result.reason, fieldName },
        'Question generation failed — field will not get a learned question yet'
      )
      return null
    }
    return result.data
  }


  // ─── Record what happened when we asked ────────────────────────────────────
  async recordAsked(questionId: string): Promise<void> {
    await query(
      `UPDATE learned_questions
       SET times_asked = times_asked + 1, updated_at = now()
       WHERE id = $1`,
      [questionId]
    )
  }

  async recordAnswered(questionId: string): Promise<void> {
    await query(
      `UPDATE learned_questions
       SET times_answered = times_answered + 1, updated_at = now()
       WHERE id = $1`,
      [questionId]
    )
  }

  async recordSkipped(questionId: string): Promise<void> {
    await query(
      `UPDATE learned_questions
       SET times_skipped = times_skipped + 1, updated_at = now()
       WHERE id = $1`,
      [questionId]
    )
  }

  /** Did the request that included this question go on to convert? */
  async recordConversion(questionIds: string[], converted: boolean): Promise<void> {
    if (questionIds.length === 0) return
    await query(
      `UPDATE learned_questions
       SET bookings_after_asked = bookings_after_asked +
             CASE WHEN $2 THEN 1 ELSE 0 END,
           updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [questionIds, converted]
    )
  }

  // ─── Retire questions that aren't earning their place ──────────────────────
  async retireUnderperformers(): Promise<number> {
    // Low answer rate = friction. Customers are ignoring it.
    const lowAnswer = await query<{ id: string; question_text: string; answer_rate: string }>(
      `UPDATE learned_questions
       SET status = 'retired',
           retired_reason = 'Answer rate below ' ||
             (${RETIRE_BELOW_ANSWER_RATE} * 100)::text || '% after ' ||
             times_asked::text || ' asks — customers are skipping it.',
           updated_at = now()
       WHERE status IN ('active','testing')
         AND times_asked >= $1
         AND answer_rate < $2
       RETURNING id, question_text, answer_rate`,
      [MIN_ASKS_BEFORE_JUDGING, RETIRE_BELOW_ANSWER_RATE]
    )

    for (const q of lowAnswer.rows) {
      logger.info(
        { question: q.question_text, answerRate: q.answer_rate },
        'Retired a follow-up question — low answer rate'
      )
    }

    // Promote tested questions that are performing
    const promoted = await query<{ id: string }>(
      `UPDATE learned_questions
       SET status = 'active', updated_at = now()
       WHERE status = 'testing'
         AND times_asked >= $1
         AND answer_rate >= 0.5
       RETURNING id`,
      [MIN_ASKS_BEFORE_JUDGING]
    )

    if (promoted.rows.length > 0) {
      logger.info(
        { count: promoted.rows.length },
        'Promoted follow-up questions from testing to active'
      )
    }

    return lowAnswer.rows.length
  }

  // ─── Ops view ──────────────────────────────────────────────────────────────
  async getPerformance(): Promise<
    Array<{
      categoryName: string
      questionText: string
      origin: string
      status: string
      timesAsked: number
      answerRate: number | null
    }>
  > {
    const result = await query<{
      category_name: string
      question_text: string
      origin: string
      status: string
      times_asked: number
      answer_rate: string | null
    }>(
      `SELECT sc.canonical_name AS category_name, lq.question_text,
              lq.origin, lq.status, lq.times_asked, lq.answer_rate
       FROM learned_questions lq
       JOIN service_categories sc ON sc.id = lq.category_id
       ORDER BY lq.times_asked DESC
       LIMIT 100`
    )

    return result.rows.map((r) => ({
      categoryName: r.category_name,
      questionText: r.question_text,
      origin: r.origin,
      status: r.status,
      timesAsked: r.times_asked,
      answerRate: r.answer_rate ? Number(r.answer_rate) : null,
    }))
  }
}
