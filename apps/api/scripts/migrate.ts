/**
 * Migration runner.
 * Applies every .sql file in migrations/ in filename order, tracking
 * which have already run in a _migrations table.
 *
 * Usage: npm run db:migrate
 */

import 'dotenv/config'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { Pool } from 'pg'

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
})

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not set. Check your .env file.')
    process.exit(1)
  }

  const client = await db.connect()

  try {
    // Track applied migrations
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename varchar PRIMARY KEY,
        applied_at timestamptz DEFAULT now()
      )
    `)

    const applied = await client.query<{ filename: string }>(
      'SELECT filename FROM _migrations'
    )
    const appliedSet = new Set(applied.rows.map((r) => r.filename))

    const dir = join(__dirname, '../migrations')
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()

    let ran = 0

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`⏭  ${file} (already applied)`)
        continue
      }

      const sql = readFileSync(join(dir, file), 'utf-8')
      console.log(`▶  Applying ${file}...`)

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file])
        await client.query('COMMIT')
        console.log(`✅ ${file}`)
        ran++
      } catch (err) {
        await client.query('ROLLBACK')
        console.error(`❌ ${file} failed:`, err instanceof Error ? err.message : err)
        throw err
      }
    }

    console.log(
      ran === 0
        ? '\n✨ Database already up to date.'
        : `\n✨ Applied ${ran} migration${ran === 1 ? '' : 's'}.`
    )
  } finally {
    client.release()
    await db.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
