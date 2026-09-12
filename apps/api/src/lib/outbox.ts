/**
 * Enqueuing outbox events.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A HELPER RATHER THAN FOUR EDITED INSERT STATEMENTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The correlation id has to be stamped onto every outbox event, or the trace
 * breaks at the commit boundary — which is exactly where the interesting
 * failures live.
 *
 * There are four `INSERT INTO outbox_events` sites today. Editing them all is
 * a one-off fix that lasts until the fifth one is written, and the fifth one
 * will be written by someone who has never read this file. Whoever adds it
 * will get a working event and a silently broken trace, with nothing to
 * notice.
 *
 * So the insert lives here. Adding an event means calling this, and the
 * stamping is not something anyone has to remember.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TRANSACTION ARGUMENT IS NOT OPTIONAL BY ACCIDENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The whole point of the outbox pattern is that the event and the state
 * change commit together. An event written on a pooled connection while the
 * state change is still in an open transaction can be processed by the worker
 * BEFORE that transaction commits — or persist after it rolls back, firing a
 * notification about something that never happened.
 *
 * Callers inside a transaction MUST pass their client.
 */

import { query } from './db'
import { getCorrelationId } from './correlation'

/** The minimum surface needed: `query`. Satisfied by a pool or a PoolClient. */
export interface OutboxExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>
}

/**
 * Write an event to the outbox, stamped with the current correlation id.
 *
 * @param executor Pass the transaction client when inside a transaction, so
 *                 the event commits atomically with the state change it
 *                 describes. Omit only for genuinely standalone writes.
 */
export async function enqueueOutbox(
  eventType: string,
  payload: Record<string, unknown>,
  executor?: OutboxExecutor
): Promise<void> {
  const sql = `INSERT INTO outbox_events (event_type, payload, correlation_id)
               VALUES ($1, $2, $3)`
  // Null rather than a fresh id when there is no context: a made-up id would
  // look like a trace and lead nowhere, which is worse than an honest gap.
  const values = [eventType, JSON.stringify(payload), getCorrelationId() ?? null]

  if (executor) {
    await executor.query(sql, values)
  } else {
    await query(sql, values)
  }
}
