/**
 * Moss semantic search client — singleton with graceful degradation.
 *
 * Moss delivers sub-10ms semantic search. We use it for:
 *   1. Category matching (replaces pgvector cosine queries)
 *   2. Catalog search (menu items, services)
 *   3. Resource discovery (doctors, tables, stylists)
 *
 * If Moss is unavailable (no key, network down), the caller falls back to
 * pgvector. No request ever fails because Moss is down.
 */

import { MossClient } from '@moss-dev/moss'
import type { SearchResult } from '@moss-dev/moss'
import { logger } from './logger'

// ─── Index names ────────────────────────────────────────────────────────────
export const MOSS_INDEX = {
  CATEGORIES: 'locogi-categories',
  CATALOG: 'locogi-catalog',
  RESOURCES: 'locogi-resources',
  OFFERS: 'locogi-offers',
} as const

// ─── Singleton ──────────────────────────────────────────────────────────────
let _client: MossClient | null = null
let _initFailed = false

/** Loaded indexes are tracked so we don't re-load on every query. */
const _loadedIndexes = new Set<string>()

function getMossClient(): MossClient | null {
  if (_initFailed) return null
  if (_client) return _client

  const projectId = process.env.MOSS_PROJECT_ID
  const projectKey = process.env.MOSS_PROJECT_KEY
  if (!projectId || !projectKey) {
    logger.warn('MOSS_PROJECT_ID/MOSS_PROJECT_KEY not set — Moss search disabled, falling back to pgvector')
    _initFailed = true
    return null
  }

  try {
    _client = new MossClient(projectId, projectKey)
    logger.info('Moss client initialized')
    return _client
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Moss client')
    _initFailed = true
    return null
  }
}

// ─── Public helpers ─────────────────────────────────────────────────────────

export function isMossAvailable(): boolean {
  return getMossClient() !== null
}

/**
 * Search a Moss index. Returns results or an empty array if Moss is down.
 *
 * Automatically loads the index into memory on first query for sub-10ms
 * subsequent queries.
 */
export async function mossSearch(
  indexName: string,
  queryText: string,
  options: { limit?: number } = {}
): Promise<MossSearchResult[]> {
  const client = getMossClient()
  if (!client) return []

  const start = Date.now()
  try {
    // Load index into memory if not already loaded (enables local-first querying)
    if (!_loadedIndexes.has(indexName)) {
      try {
        await client.loadIndex(indexName)
        _loadedIndexes.add(indexName)
        logger.info({ index: indexName }, '[moss] index loaded into memory')
      } catch {
        // Index may not exist yet — will be created on first sync
        logger.debug({ index: indexName }, '[moss] index not yet available for local load, using cloud query')
      }
    }

    const result: SearchResult = await client.query(indexName, queryText, {
      topK: options.limit ?? 5,
    })

    const latencyMs = Date.now() - start
    const docs = result.docs ?? []
    logger.info(
      { index: indexName, query: queryText, results: docs.length, latencyMs },
      '[moss] search complete'
    )

    return docs.map((doc) => ({
      id: doc.id ?? '',
      content: doc.text ?? '',
      score: doc.score ?? 0,
      metadata: doc.metadata ?? {},
    }))
  } catch (err) {
    const latencyMs = Date.now() - start
    logger.warn({ err, index: indexName, query: queryText, latencyMs }, '[moss] search failed — falling back')
    return []
  }
}

/**
 * Upsert documents into a Moss index.
 *
 * Creates the index if it doesn't exist, otherwise adds/updates docs.
 */
export async function mossUpsert(
  indexName: string,
  documents: MossDocument[]
): Promise<boolean> {
  const client = getMossClient()
  if (!client) return false

  try {
    // Check if index exists
    let indexExists = false
    try {
      const indexes = await client.listIndexes()
      indexExists = indexes.some((idx) => idx.name === indexName)
    } catch {
      // listIndexes failed — assume index doesn't exist
    }

    // Convert to Moss DocumentInfo format
    // Moss metadata values must be strings
    const mossDocs = documents.map(d => ({
      id: d.id,
      text: d.content,
      metadata: d.metadata
        ? Object.fromEntries(
            Object.entries(d.metadata).map(([k, v]) => [k, String(v ?? '')])
          )
        : undefined,
    }))

    if (!indexExists) {
      // Create the index with initial documents
      await client.createIndex(indexName, mossDocs)
      logger.info({ index: indexName, count: documents.length }, '[moss] created index with documents')
    } else {
      // Add/update documents in batches
      const BATCH_SIZE = 50
      for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        const batch = mossDocs.slice(i, i + BATCH_SIZE)
        await client.addDocs(indexName, batch, { upsert: true })
      }
      logger.info({ index: indexName, count: documents.length }, '[moss] upserted documents')
    }

    // Force reload on next query so it picks up new data
    _loadedIndexes.delete(indexName)

    return true
  } catch (err) {
    logger.error({ err, index: indexName }, '[moss] upsert failed')
    return false
  }
}

/**
 * Close the Moss client and release resources. Called during shutdown.
 */
export async function closeMoss(): Promise<void> {
  if (_client) {
    await _client.close()
    _client = null
    _loadedIndexes.clear()
    logger.info('[moss] client closed')
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MossSearchResult {
  id: string
  content: string
  score: number
  metadata: Record<string, unknown>
}

export interface MossDocument {
  id: string
  content: string
  metadata?: Record<string, unknown>
}
