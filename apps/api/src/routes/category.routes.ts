import type { FastifyInstance } from 'fastify'
import { query } from '../lib/db'
import { requireAuth } from '../lib/auth'
import { CategoryService } from '../services/category.service'
import { cacheGet, cacheSet } from '../lib/redis'

const categories = new CategoryService()

export async function categoryRoutes(app: FastifyInstance) {

  // ─── Public: browse the taxonomy (used for vendor onboarding hints) ────────
  app.get('/categories', async (_req, reply) => {
    const cached = await cacheGet('categories:list')
    if (cached) return reply.send(JSON.parse(cached))

    const result = await query<{
      id: string
      slug: string
      canonical_name: string
      description: string | null
      default_booking_type: string | null
      requires_kyc: boolean
      requires_gender_preference: boolean
      vendor_count: number
      avg_price: number | null
    }>(
      `SELECT id, slug, canonical_name, description, default_booking_type,
              requires_kyc, requires_gender_preference, vendor_count, avg_price
       FROM service_categories
       WHERE vendor_count > 0 OR is_verified = true
       ORDER BY vendor_count DESC, canonical_name ASC`
    )

    const payload = {
      categories: result.rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.canonical_name,
        description: r.description,
        bookingType: r.default_booking_type,
        requiresKyc: r.requires_kyc,
        requiresGenderPreference: r.requires_gender_preference,
        vendorCount: r.vendor_count,
        avgPrice: r.avg_price,
      })),
    }

    await cacheSet('categories:list', JSON.stringify(payload), 300)
    return reply.send(payload)
  })

  // ─── Resolve arbitrary text into a canonical category (preview) ────────────
  // The mobile app calls this to show "You'll be listed as: Videography"
  // before the vendor commits to their profile.
  app.post('/categories/resolve', { preHandler: requireAuth }, async (req, reply) => {
    const { tags } = (req.body ?? {}) as { tags?: string[] }
    if (!Array.isArray(tags) || tags.length === 0) {
      return reply.code(400).send({ message: 'Provide at least one tag' })
    }

    const resolved = await categories.resolveTags(tags.slice(0, 5), 'vendor')

    return reply.send({
      resolved: resolved.map((r) => ({
        categoryId: r.categoryId,
        name: r.canonicalName,
        slug: r.slug,
        bookingType: r.defaultBookingType,
        requiresKyc: r.requiresKyc,
        requiresGenderPreference: r.requiresGenderPreference,
        matchedVia: r.matchedVia,
        confidence: r.confidence,
        yourTag: r.sourceTag,
      })),
    })
  })

  // ─── What fields does this role usually need? ───────────────────────────────
  // Powers dynamic onboarding: prompt for fields other vendors in this
  // category have, even if this vendor didn't mention them.
  app.get<{ Params: { id: string } }>(
    '/categories/:id/fields',
    { preHandler: requireAuth },
    async (req, reply) => {
      const template = await categories.getFieldTemplate(req.params.id)
      return reply.send({ fields: template })
    }
  )

  // ─── Admin: taxonomy health + supply gaps ──────────────────────────────────
  app.get('/categories/overview', { preHandler: requireAuth }, async (_req, reply) => {
    const overview = await categories.getTaxonomyOverview()
    return reply.send(overview)
  })

  // ─── Admin: see all aliases resolved into a category ───────────────────────
  app.get<{ Params: { id: string } }>(
    '/categories/:id/aliases',
    { preHandler: requireAuth },
    async (req, reply) => {
      const result = await query<{
        alias: string
        similarity_score: number
        occurrence_count: number
        source: string
        created_at: string
      }>(
        `SELECT alias, similarity_score, occurrence_count, source, created_at
         FROM category_aliases
         WHERE category_id = $1
         ORDER BY occurrence_count DESC, created_at ASC`,
        [req.params.id]
      )
      return reply.send({ aliases: result.rows })
    }
  )

  // ─── Admin: merge a category into another (cleanup) ───────────────────────
  // When the agent creates a category that turns out to be a duplicate,
  // this moves all its vendors and aliases into the canonical one.
  app.post<{ Body: { sourceId?: string; targetId?: string } }>(
    '/categories/merge',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { sourceId, targetId } = req.body ?? {}
      if (!sourceId || !targetId || sourceId === targetId) {
        return reply.code(400).send({ message: 'Provide distinct sourceId and targetId' })
      }

      // Move vendors
      await query(
        `INSERT INTO vendor_categories (vendor_id, category_id, is_primary, confidence, source_tag)
         SELECT vendor_id, $2, is_primary, confidence, source_tag
         FROM vendor_categories WHERE category_id = $1
         ON CONFLICT (vendor_id, category_id) DO NOTHING`,
        [sourceId, targetId]
      )
      await query('DELETE FROM vendor_categories WHERE category_id = $1', [sourceId])

      // Move aliases
      await query(
        'UPDATE category_aliases SET category_id = $2 WHERE category_id = $1',
        [sourceId, targetId]
      )

      // Move schema observations + field templates
      await query(
        'UPDATE category_schema_observations SET category_id = $2 WHERE category_id = $1',
        [sourceId, targetId]
      )
      await query('DELETE FROM category_field_templates WHERE category_id = $1', [sourceId])

      // Move requests
      await query(
        `INSERT INTO request_categories (request_id, category_id, confidence, source_tag)
         SELECT request_id, $2, confidence, source_tag
         FROM request_categories WHERE category_id = $1
         ON CONFLICT (request_id, category_id) DO NOTHING`,
        [sourceId, targetId]
      )
      await query('DELETE FROM request_categories WHERE category_id = $1', [sourceId])

      // Remove the now-empty source
      await query('DELETE FROM service_categories WHERE id = $1', [sourceId])

      await categories.refreshCategoryStats([targetId])

      return reply.send({ success: true, mergedInto: targetId })
    }
  )

  // ─── Admin: verify an auto-created category ────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/categories/:id/verify',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { canonicalName, description, defaultBookingType, requiresKyc, requiresGenderPreference } =
        (req.body ?? {}) as Record<string, unknown>

      await query(
        `UPDATE service_categories
         SET canonical_name = COALESCE($2, canonical_name),
             description = COALESCE($3, description),
             default_booking_type = COALESCE($4, default_booking_type),
             requires_kyc = COALESCE($5, requires_kyc),
             requires_gender_preference = COALESCE($6, requires_gender_preference),
             is_verified = true,
             updated_at = now()
         WHERE id = $1`,
        [
          req.params.id,
          canonicalName ?? null,
          description ?? null,
          defaultBookingType ?? null,
          requiresKyc ?? null,
          requiresGenderPreference ?? null,
        ]
      )

      return reply.send({ success: true })
    }
  )
}
