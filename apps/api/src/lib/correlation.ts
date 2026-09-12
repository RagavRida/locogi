/**
 * Correlation context — the thread that stitches one customer's journey
 * together across logs, workers, and processes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS EXISTS TO ANSWER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Why did this customer's booking fail?"
 *
 * Today that is unanswerable. There are ~196 log statements and each carries
 * whichever ids its author happened to have in scope, so a single journey —
 * chat message → intent → matching → quote → booking → outbox → push — leaves
 * six unrelated log lines with no way to join them. You can find the failure;
 * you cannot find what led to it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY AsyncLocalStorage AND NOT A PARAMETER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The alternative is threading a context argument through every service,
 * repository and helper. That is hundreds of signature changes, it is
 * contagious (one un-threaded function breaks the chain), and it will be
 * forgotten the first time someone adds a method in a hurry.
 *
 * AsyncLocalStorage propagates automatically across awaits, promises and
 * timers within the same logical operation. Combined with pino's `mixin`
 * hook, every existing `logger.info(...)` call gains correlation without a
 * single one being edited.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE IT DOES *NOT* PROPAGATE — AND WHAT WE DO ABOUT IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ALS follows async continuations inside one process. It does NOT cross:
 *
 *   - a database write and a later worker that reads it
 *   - a BullMQ job
 *   - a Redis pub/sub hop to another instance
 *
 * Those are exactly the boundaries where a trace is most valuable, because
 * that is where work becomes invisible. So the id is also carried as DATA:
 * `outbox_events.correlation_id` (migration 015) and the WS envelope. The
 * worker re-establishes context from the row.
 *
 * Any claim that a trace is complete depends on that discipline being kept at
 * each boundary — ALS alone would silently drop the thread and nothing would
 * look broken.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/**
 * Ids that accumulate as an operation proceeds.
 *
 * `correlationId` exists from the first moment. The rest are filled in as they
 * become known — a chat message has no bookingId until the booking is created,
 * and every log line after that point should carry it.
 */
export interface CorrelationContext {
  /** Stable for the whole journey. Never changes once set. */
  correlationId: string

  userId?: string
  conversationId?: string
  requestId?: string
  quoteId?: string
  bookingId?: string
  paymentId?: string
  providerId?: string

  /** What kind of work this is: 'http', 'worker', 'ws'. */
  source?: string
  /** Route or job name, for grouping. */
  operation?: string
}

const storage = new AsyncLocalStorage<CorrelationContext>()

/** A fresh id. Prefixed so it is obvious in a log what kind of value it is. */
export function newCorrelationId(): string {
  return `cor_${randomUUID()}`
}

/**
 * Run `fn` inside a correlation context.
 *
 * Everything awaited within — however deep — sees the same context.
 */
export function withCorrelation<T>(
  context: CorrelationContext,
  fn: () => T
): T {
  return storage.run(context, fn)
}

export function getContext(): CorrelationContext | undefined {
  return storage.getStore()
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId
}

/**
 * Add ids to the CURRENT context, in place.
 *
 * Mutating rather than re-running is deliberate: `enrich({ bookingId })` after
 * a booking is created should affect the rest of the operation, including
 * code already on the stack. Wrapping the remainder in a new `storage.run`
 * would mean callers restructuring their control flow to get an id into a log
 * line, which is exactly the friction that stops people bothering.
 *
 * A no-op outside a context, so it is always safe to call.
 */
export function enrich(fields: Partial<Omit<CorrelationContext, 'correlationId'>>): void {
  const current = storage.getStore()
  if (!current) return

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      ;(current as unknown as Record<string, unknown>)[key] = value
    }
  }
}

/**
 * The fields pino should attach to every log line.
 *
 * Wired as pino's `mixin`, which is what makes this work without touching a
 * single existing `logger.info(...)`. Returns an empty object outside a
 * context so scripts and tests are unaffected.
 */
export function logFields(): Record<string, unknown> {
  const ctx = storage.getStore()
  if (!ctx) return {}

  // Spread into a new object: pino may retain what it is given, and handing
  // it the live mutable context would let later `enrich` calls retroactively
  // alter log lines already written.
  return { ...ctx }
}

/**
 * Accept an inbound correlation id, or mint one.
 *
 * A client-supplied id is used only if it looks like an id we would have
 * generated. Without that check, a caller could inject newlines or a
 * megabyte of text into every log line for the whole request — log injection,
 * and a denial-of-service on whatever ingests those logs.
 */
const SAFE_ID = /^[A-Za-z0-9_\-.]{8,128}$/

export function acceptOrCreate(inbound: unknown): string {
  if (typeof inbound === 'string' && SAFE_ID.test(inbound)) {
    return inbound
  }
  return newCorrelationId()
}

/** Header name, used by both the server and the mobile client. */
export const CORRELATION_HEADER = 'x-correlation-id'
