import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'
import { logger } from './logger'

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

db.on('error', (err) => {
  logger.error({ err }, 'Unexpected DB pool error')
})

export async function runMigrations() {
  const sql = readFileSync(
    join(__dirname, '../../migrations/001_initial.sql'),
    'utf-8'
  )
  const client = await db.connect()
  try {
    await client.query(sql)
    logger.info('Migrations applied successfully')
  } finally {
    client.release()
  }
}

// Typed query helper
export async function query<T = Record<string, unknown>>(
  text: string,
  values?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const start = Date.now()
  const result = await db.query(text, values)
  const duration = Date.now() - start
  logger.debug({ query: text.slice(0, 60), duration, rows: result.rowCount }, 'DB query')
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 }
}

// Atomic transaction helper
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
