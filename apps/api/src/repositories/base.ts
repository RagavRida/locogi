/**
 * Repository base — the transaction seam.
 *
 * WHY THIS LAYER EXISTS
 * ─────────────────────
 * Before this, every service and route wrote its own SQL inline. The audit
 * found 18 duplicated query sites for just three shapes:
 *
 *   • "find vendor by user_id"        — 10 copies
 *   • "does this user own this request" — 6 copies
 *   • "get vendor's user_id"           — 2 copies
 *
 * More seriously, it made the slot split-brain possible: two different code
 * paths wrote two different tables for the same concept, and nothing in the
 * type system objected. A repository makes that structurally impossible —
 * there is exactly one place that knows how a slot is persisted.
 *
 * THE TRANSACTION PROBLEM
 * ───────────────────────
 * The atomic race-lock runs inside withTransaction(). If repositories always
 * used the pool, a repository call inside a transaction would execute on a
 * DIFFERENT connection — outside the transaction — and the atomicity
 * guarantee would silently evaporate.
 *
 * So every repository method accepts an optional Executor. Pass the
 * transaction client and the query joins the transaction; omit it and the
 * query runs on the pool. The default is safe; the override is explicit.
 *
 *   // standalone
 *   await vendors.findByUserId(userId)
 *
 *   // inside a transaction — same connection, same atomicity
 *   await withTransaction(async (tx) => {
 *     await vendors.findByUserId(userId, tx)
 *     await requests.confirm(requestId, vendorId, tx)
 *   })
 */

import type { PoolClient } from 'pg'
import { db } from '../lib/db'
import { logger } from '../lib/logger'

/**
 * Anything that can run a query: the pool, or a transaction client.
 * Repositories depend on this, not on the concrete Pool — so a caller inside
 * a transaction gets the transaction's connection.
 */
export interface Executor {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>
}

/** Default executor — the connection pool. */
export const defaultExecutor: Executor = {
  query: async <T>(text: string, values?: unknown[]) => {
    const result = await db.query(text, values)
    return { rows: result.rows as T[], rowCount: result.rowCount }
  },
}

/** Wrap a transaction client so it satisfies Executor. */
export function txExecutor(client: PoolClient): Executor {
  return {
    query: async <T>(text: string, values?: unknown[]) => {
      const result = await client.query(text, values)
      return { rows: result.rows as T[], rowCount: result.rowCount }
    },
  }
}

/**
 * Shared repository behaviour: query timing, and the executor default.
 * Deliberately thin — this is not an ORM and should not grow into one.
 */
export abstract class BaseRepository {
  protected exec(executor?: Executor): Executor {
    return executor ?? defaultExecutor
  }

  /**
   * Run a query with timing. Slow queries are logged with the repository name
   * so a p95 regression can be traced to a specific access pattern rather
   * than to "the database".
   */
  protected async run<T>(
    label: string,
    text: string,
    values: unknown[],
    executor?: Executor
  ): Promise<{ rows: T[]; rowCount: number }> {
    const start = Date.now()
    const result = await this.exec(executor).query<T>(text, values)
    const duration = Date.now() - start

    if (duration > 200) {
      logger.warn(
        { repository: this.constructor.name, op: label, duration },
        'Slow repository query'
      )
    }

    return { rows: result.rows, rowCount: result.rowCount ?? 0 }
  }

  /** First row or null — the common single-entity read. */
  protected async one<T>(
    label: string,
    text: string,
    values: unknown[],
    executor?: Executor
  ): Promise<T | null> {
    const { rows } = await this.run<T>(label, text, values, executor)
    return rows[0] ?? null
  }

  /** Did the write affect anything? Used by every atomic guard in the system. */
  protected async didWrite(
    label: string,
    text: string,
    values: unknown[],
    executor?: Executor
  ): Promise<boolean> {
    const { rowCount } = await this.run(label, text, values, executor)
    return rowCount > 0
  }
}

// ─── Row → domain mapping ─────────────────────────────────────────────────────
//
// Postgres returns snake_case; the domain types are camelCase. Doing this
// conversion in one place keeps the mapping honest — a column rename breaks
// one mapper, not fifteen call sites.

/** Numeric columns arrive as strings from pg. Convert safely. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'number' ? v : Number(v)
}

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isNaN(n) ? null : n
}

/** pgvector columns come back as a string like '[0.1,0.2,...]'. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}
