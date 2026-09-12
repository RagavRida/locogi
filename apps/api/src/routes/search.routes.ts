/**
 * Search routes — Moss-powered semantic search endpoints.
 *
 * These are the fast-path endpoints that the mobile app calls for:
 *   - Catalog search (menus, services)
 *   - Resource discovery (doctors, stylists, tables)
 *   - Category resolution (what service is the user asking for?)
 *
 * All endpoints gracefully fall back to pgvector if Moss is unavailable.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { mossSearch, isMossAvailable, MOSS_INDEX } from '../lib/moss'
import { query } from '../lib/db'
import { generateEmbedding } from '../lib/nim'
import { logger } from '../lib/logger'
import { MossSyncService } from '../services/moss-sync.service'

export async function searchRoutes(app: FastifyInstance) {

  // ─── Catalog Search ───────────────────────────────────────────────────────
  //
  // GET /search/catalog?q=biryani&org_id=abc
  //
  // Searches menu items and fixed-price services.
  // Returns results in <10ms via Moss, or ~100ms via pgvector fallback.

  app.get('/search/catalog', async (req: FastifyRequest, reply: FastifyReply) => {
    const { q, org_id, limit } = req.query as {
      q?: string
      org_id?: string
      limit?: string
    }

    if (!q || q.trim().length === 0) {
      return reply.code(400).send({ message: 'Query parameter "q" is required' })
    }

    const searchLimit = Math.min(parseInt(limit ?? '10'), 50)
    const start = Date.now()

    // Try Moss first
    const mossResults = await mossSearch(MOSS_INDEX.CATALOG, q, {
      limit: searchLimit,
    })

    if (mossResults.length > 0) {
      // Filter by org_id if provided (client-side filter since Moss metadata filtering varies)
      const filtered = org_id
        ? mossResults.filter(r => r.metadata.organization_id === org_id)
        : mossResults

      return reply.send({
        results: filtered,
        source: 'moss',
        latencyMs: Date.now() - start,
      })
    }

    // Fallback: pgvector
    try {
      const embedding = await generateEmbedding(q)
      const vec = `[${embedding.join(',')}]`

      const pgResult = await query<{
        id: string
        name: string
        description: string
        base_price: number
        organization_id: string
        similarity: number
      }>(`
        SELECT id, name, description, base_price, organization_id,
               1 - (embedding <=> $1::vector) AS similarity
        FROM catalog_items
        WHERE is_available = true
          ${org_id ? 'AND organization_id = $3' : ''}
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `, org_id ? [vec, searchLimit, org_id] : [vec, searchLimit])

      return reply.send({
        results: pgResult.rows.map(r => ({
          id: r.id,
          content: `${r.name}. ${r.description ?? ''}`,
          score: r.similarity,
          metadata: {
            name: r.name,
            base_price: r.base_price,
            organization_id: r.organization_id,
          },
        })),
        source: 'pgvector',
        latencyMs: Date.now() - start,
      })
    } catch (err) {
      logger.error({ err }, '[search] Catalog search failed')
      return reply.code(500).send({ message: 'Search temporarily unavailable' })
    }
  })

  // ─── Resource Discovery ───────────────────────────────────────────────────
  //
  // GET /search/resources?q=heart+doctor&area=kondapur&type=person
  //
  // Searches bookable resources (doctors, tables, stylists, equipment).

  app.get('/search/resources', async (req: FastifyRequest, reply: FastifyReply) => {
    const { q, area, type, limit } = req.query as {
      q?: string
      area?: string
      type?: string
      limit?: string
    }

    if (!q || q.trim().length === 0) {
      return reply.code(400).send({ message: 'Query parameter "q" is required' })
    }

    const searchLimit = Math.min(parseInt(limit ?? '10'), 50)
    const start = Date.now()

    // Try Moss first
    const mossResults = await mossSearch(MOSS_INDEX.RESOURCES, q, {
      limit: searchLimit,
    })

    if (mossResults.length > 0) {
      let filtered = mossResults
      if (area) {
        filtered = filtered.filter(r =>
          String(r.metadata.area ?? '').toLowerCase().includes(area.toLowerCase())
        )
      }
      if (type) {
        filtered = filtered.filter(r => r.metadata.resource_type === type)
      }

      return reply.send({
        results: filtered,
        source: 'moss',
        latencyMs: Date.now() - start,
      })
    }

    // Fallback: pgvector
    try {
      const embedding = await generateEmbedding(q)
      const vec = `[${embedding.join(',')}]`

      const pgResult = await query<{
        id: string
        name: string
        specialization: string
        resource_type: string
        org_display_name: string
        area: string
        similarity: number
      }>(`
        SELECT r.id, r.name, r.specialization, r.resource_type,
               o.display_name as org_display_name, o.area,
               1 - (r.embedding <=> $1::vector) AS similarity
        FROM bookable_resources r
        JOIN organizations o ON o.id = r.organization_id
        WHERE o.verification_status != 'rejected'
          ${area ? `AND LOWER(o.area) LIKE '%' || LOWER($3) || '%'` : ''}
          ${type ? `AND r.resource_type = $${area ? 4 : 3}` : ''}
        ORDER BY r.embedding <=> $1::vector
        LIMIT $2
      `, [vec, searchLimit, ...(area ? [area] : []), ...(type ? [type] : [])])

      return reply.send({
        results: pgResult.rows.map(r => ({
          id: r.id,
          content: `${r.name}. ${r.specialization ?? ''} at ${r.org_display_name}`,
          score: r.similarity,
          metadata: {
            resource_type: r.resource_type,
            area: r.area,
            org_display_name: r.org_display_name,
          },
        })),
        source: 'pgvector',
        latencyMs: Date.now() - start,
      })
    } catch (err) {
      logger.error({ err }, '[search] Resource search failed')
      return reply.code(500).send({ message: 'Search temporarily unavailable' })
    }
  })

  // ─── Category Match ───────────────────────────────────────────────────────
  //
  // GET /search/categories?q=plumber
  //
  // Fast category resolution. Used by the agent to resolve freeform text
  // into canonical service categories.

  app.get('/search/categories', async (req: FastifyRequest, reply: FastifyReply) => {
    const { q, limit } = req.query as { q?: string; limit?: string }

    if (!q || q.trim().length === 0) {
      return reply.code(400).send({ message: 'Query parameter "q" is required' })
    }

    const searchLimit = Math.min(parseInt(limit ?? '5'), 20)
    const start = Date.now()

    const mossResults = await mossSearch(MOSS_INDEX.CATEGORIES, q, {
      limit: searchLimit,
    })

    if (mossResults.length > 0) {
      return reply.send({
        results: mossResults,
        source: 'moss',
        latencyMs: Date.now() - start,
      })
    }

    // Fallback: exact alias + pgvector
    try {
      const normalized = q.toLowerCase().trim()

      // Try exact alias first
      const exact = await query<{
        id: string; slug: string; canonical_name: string
      }>(`
        SELECT c.id, c.slug, c.canonical_name
        FROM category_aliases a
        JOIN service_categories c ON c.id = a.category_id
        WHERE a.alias_normalized = $1
      `, [normalized])

      if (exact.rows.length > 0) {
        return reply.send({
          results: exact.rows.map(r => ({
            id: r.id,
            content: r.canonical_name,
            score: 1.0,
            metadata: { slug: r.slug, canonical_name: r.canonical_name },
          })),
          source: 'exact_alias',
          latencyMs: Date.now() - start,
        })
      }

      // pgvector fallback
      const embedding = await generateEmbedding(q)
      const vec = `[${embedding.join(',')}]`

      const pgResult = await query<{
        id: string; slug: string; canonical_name: string; similarity: number
      }>(`
        SELECT id, slug, canonical_name,
               1 - (embedding <=> $1::vector) AS similarity
        FROM service_categories
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `, [vec, searchLimit])

      return reply.send({
        results: pgResult.rows.map(r => ({
          id: r.id,
          content: r.canonical_name,
          score: r.similarity,
          metadata: { slug: r.slug, canonical_name: r.canonical_name },
        })),
        source: 'pgvector',
        latencyMs: Date.now() - start,
      })
    } catch (err) {
      logger.error({ err }, '[search] Category search failed')
      return reply.code(500).send({ message: 'Search temporarily unavailable' })
    }
  })

  // ─── Admin: trigger re-sync ───────────────────────────────────────────────
  //
  // POST /search/sync
  //
  // Manually re-sync all Moss indexes from the database.

  app.post('/search/sync', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!isMossAvailable()) {
      return reply.code(503).send({ message: 'Moss not configured' })
    }

    const sync = new MossSyncService()
    // Fire-and-forget; respond immediately
    sync.syncAll().catch(err => logger.error({ err }, '[moss-sync] Manual sync failed'))

    return reply.send({ message: 'Sync started', status: 'ok' })
  })
}
