/**
 * MossSyncService — populates Moss indexes from PostgreSQL.
 *
 * Runs once at server startup (non-blocking) and can be triggered manually
 * via the ops endpoint. Idempotent: re-running just upserts the same docs.
 *
 * Three indexes are synced:
 *   1. locogi-categories  — service categories + their aliases
 *   2. locogi-catalog     — catalog items (menus, fixed-price services)
 *   3. locogi-resources   — bookable resources (doctors, tables, stylists)
 */

import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { mossUpsert, MOSS_INDEX, isMossAvailable } from '../lib/moss'
import type { MossDocument } from '../lib/moss'

export class MossSyncService {

  async syncAll(): Promise<void> {
    if (!isMossAvailable()) {
      logger.info('[moss-sync] Moss not available — skipping index sync')
      return
    }

    const start = Date.now()
    logger.info('[moss-sync] Starting full sync')

    const results = await Promise.allSettled([
      this.syncCategories(),
      this.syncCatalog(),
      this.syncResources(),
      this.syncOffers(),
    ])

    const stats = results.map((r, i) => {
      const name = ['categories', 'catalog', 'resources', 'offers'][i]
      return r.status === 'fulfilled'
        ? `${name}: ${r.value} docs`
        : `${name}: FAILED (${(r.reason as Error).message})`
    })

    logger.info(
      { stats, durationMs: Date.now() - start },
      '[moss-sync] Full sync complete'
    )
  }

  // ─── Categories ─────────────────────────────────────────────────────────────

  async syncCategories(): Promise<number> {
    const result = await query<{
      id: string
      slug: string
      canonical_name: string
      description: string | null
      default_booking_type: string | null
      requires_kyc: boolean
      is_regulated: boolean
      is_health_adjacent: boolean
      aliases: string | null
    }>(`
      SELECT c.id, c.slug, c.canonical_name, c.description,
             c.default_booking_type, c.requires_kyc,
             COALESCE(c.is_regulated, false) as is_regulated,
             COALESCE(c.is_health_adjacent, false) as is_health_adjacent,
             string_agg(DISTINCT a.alias, ', ') as aliases
      FROM service_categories c
      LEFT JOIN category_aliases a ON a.category_id = c.id
      GROUP BY c.id
    `)

    const docs: MossDocument[] = result.rows.map(row => ({
      id: row.id,
      content: [
        row.canonical_name,
        row.description,
        row.aliases,
      ].filter(Boolean).join('. '),
      metadata: {
        slug: row.slug,
        canonical_name: row.canonical_name,
        default_booking_type: row.default_booking_type,
        requires_kyc: row.requires_kyc,
        is_regulated: row.is_regulated,
        is_health_adjacent: row.is_health_adjacent,
      },
    }))

    if (docs.length === 0) return 0

    const ok = await mossUpsert(MOSS_INDEX.CATEGORIES, docs)
    if (!ok) throw new Error('Category upsert failed')

    logger.info({ count: docs.length }, '[moss-sync] Categories synced')
    return docs.length
  }

  // ─── Catalog (menu items, services) — now with images ───────────────────────

  async syncCatalog(): Promise<number> {
    const result = await query<{
      id: string
      organization_id: string
      name: string
      description: string | null
      price: number | null
      section: string | null
      is_available: boolean
      is_veg: boolean | null
      spice_level: string | null
      allergens: string[] | null
      image_url: string | null
      org_name: string | null
      org_area: string | null
    }>(`
      SELECT ci.id, ci.organization_id, ci.name, ci.description,
             ci.price, ci.section, ci.is_available,
             ci.is_veg, ci.spice_level, ci.allergens,
             ci.image_url,
             o.display_name as org_name, o.area as org_area
      FROM catalog_items ci
      JOIN organizations o ON o.id = ci.organization_id
      WHERE ci.is_available = true
    `)

    const docs: MossDocument[] = result.rows.map(row => ({
      id: row.id,
      content: [
        row.name,
        row.description,
        row.section,
        row.is_veg ? 'vegetarian' : null,
        row.spice_level ? `${row.spice_level} spice` : null,
        row.org_name,
        row.org_area,
      ].filter(Boolean).join('. '),
      metadata: {
        organization_id: row.organization_id,
        name: row.name,
        price: row.price,
        section: row.section,
        is_veg: row.is_veg,
        spice_level: row.spice_level,
        image_url: row.image_url,         // Moss stores images
        org_name: row.org_name,
        org_area: row.org_area,
      },
    }))

    if (docs.length === 0) {
      logger.info('[moss-sync] No catalog items to sync')
      return 0
    }

    const ok = await mossUpsert(MOSS_INDEX.CATALOG, docs)
    if (!ok) throw new Error('Catalog upsert failed')

    logger.info({ count: docs.length }, '[moss-sync] Catalog synced')
    return docs.length
  }

  // ─── Bookable Resources — now with images ───────────────────────────────────

  async syncResources(): Promise<number> {
    const result = await query<{
      id: string
      organization_id: string
      resource_type: string
      name: string
      specialization: string | null
      base_price: number | null
      image_url: string | null
      org_display_name: string | null
      org_type: string | null
      area: string | null
    }>(`
      SELECT r.id, r.organization_id, r.resource_type, r.name,
             r.specialization, r.base_price, r.image_url,
             o.display_name as org_display_name,
             o.org_type, o.area
      FROM bookable_resources r
      JOIN organizations o ON o.id = r.organization_id
      WHERE o.verification_status != 'rejected'
    `)

    const docs: MossDocument[] = result.rows.map(row => ({
      id: row.id,
      content: [
        row.name,
        row.specialization,
        row.resource_type,
        row.org_display_name,
        row.area,
      ].filter(Boolean).join('. '),
      metadata: {
        organization_id: row.organization_id,
        resource_type: row.resource_type,
        org_type: row.org_type,
        area: row.area,
        base_price: row.base_price,
        image_url: row.image_url,           // Moss stores images
        org_display_name: row.org_display_name,
      },
    }))

    if (docs.length === 0) {
      logger.info('[moss-sync] No resources to sync')
      return 0
    }

    const ok = await mossUpsert(MOSS_INDEX.RESOURCES, docs)
    if (!ok) throw new Error('Resource upsert failed')

    logger.info({ count: docs.length }, '[moss-sync] Resources synced')
    return docs.length
  }

  // ─── Offers / Deals ─────────────────────────────────────────────────────────
  //
  // Synced to Moss so the AI can semantically search:
  //   "any deals on biryani?" → finds "Biryani Bonanza: 20% off all biryanis"

  async syncOffers(): Promise<number> {
    const result = await query<{
      id: string
      organization_id: string
      offer_type: string
      title: string
      description: string | null
      image_url: string | null
      badge_text: string | null
      discount_value: number | null
      discount_type: string | null
      min_order_value: number | null
      max_discount: number | null
      start_date: string
      end_date: string | null
      start_time: string | null
      end_time: string | null
      active_days: number[]
      is_featured: boolean
      org_name: string | null
      org_area: string | null
    }>(`
      SELECT o.id, o.organization_id, o.offer_type, o.title,
             o.description, o.image_url, o.badge_text,
             o.discount_value, o.discount_type,
             o.min_order_value, o.max_discount,
             o.start_date, o.end_date, o.start_time, o.end_time,
             o.active_days, o.is_featured,
             org.display_name as org_name, org.area as org_area
      FROM offers o
      JOIN organizations org ON org.id = o.organization_id
      WHERE o.is_active = true
        AND (o.end_date IS NULL OR o.end_date >= CURRENT_DATE)
    `)

    const docs: MossDocument[] = result.rows.map(row => ({
      id: row.id,
      content: [
        row.title,
        row.description,
        row.badge_text,
        row.offer_type.replace(/_/g, ' '),
        row.org_name,
        row.org_area,
        row.discount_value && row.discount_type === 'percent'
          ? `${row.discount_value}% off`
          : null,
        row.discount_value && row.discount_type === 'flat'
          ? `₹${row.discount_value} off`
          : null,
      ].filter(Boolean).join('. '),
      metadata: {
        organization_id: row.organization_id,
        offer_type: row.offer_type,
        title: row.title,
        image_url: row.image_url,
        badge_text: row.badge_text,
        discount_value: row.discount_value,
        discount_type: row.discount_type,
        min_order_value: row.min_order_value,
        max_discount: row.max_discount,
        start_date: row.start_date,
        end_date: row.end_date,
        start_time: row.start_time,
        end_time: row.end_time,
        is_featured: row.is_featured,
        org_name: row.org_name,
        org_area: row.org_area,
      },
    }))

    if (docs.length === 0) {
      logger.info('[moss-sync] No offers to sync')
      return 0
    }

    const ok = await mossUpsert(MOSS_INDEX.OFFERS, docs)
    if (!ok) throw new Error('Offers upsert failed')

    logger.info({ count: docs.length }, '[moss-sync] Offers synced')
    return docs.length
  }
}

