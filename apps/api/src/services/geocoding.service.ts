/**
 * GeocodingService — replaces the hardcoded HYDERABAD_AREAS map.
 *
 * The old version had 51 area names with coordinates baked into TypeScript.
 * It could not handle a 52nd area, a misspelling, Telugu input, a landmark
 * ("near Inorbit Mall"), or a different city. Adding coverage meant a deploy.
 *
 * Resolution ladder, cheapest first:
 *   1. Exact cache hit                          — ~1ms, free
 *   2. Semantic cache hit (embedding, ≥0.90)    — catches typos and paraphrases
 *   3. Geocoding provider (Google → Nominatim)  — network, cached on success
 *   4. Locality-name fuzzy match in cache       — last resort
 *
 * Failures are cached too, so a hopeless query isn't retried against a paid API
 * on every request.
 */

import { query } from '../lib/db'
import { generateEmbedding } from '../lib/nim'
import { indexLocation } from '../lib/h3'
import { logger } from '../lib/logger'

const SEMANTIC_MATCH_THRESHOLD = 0.90
const FAILURE_RETRY_AFTER_DAYS = 30

export interface GeoResult {
  lat: number
  lng: number
  formattedAddress: string | null
  locality: string | null
  city: string | null
  h3_r8: string
  h3_r7: string
  h3_r6: string
  precision: string | null
  resolvedVia: 'exact_cache' | 'semantic_cache' | 'google' | 'nominatim' | 'locality_fuzzy'
}

export class GeocodingService {

  async resolve(rawQuery: string, cityHint = 'Hyderabad, Telangana, India'): Promise<GeoResult | null> {
    const normalized = rawQuery.toLowerCase().trim()
    if (!normalized || normalized.length < 2) return null

    // ── 1. Exact cache ──────────────────────────────────────────────────────
    const exact = await query<CacheRow>(
      `SELECT lat, lng, formatted_address, locality, city,
              h3_r8, h3_r7, h3_r6, precision_level,
              resolution_failed, created_at
       FROM geo_cache WHERE query_normalized = $1`,
      [normalized]
    )

    const hit = exact.rows[0]
    if (hit) {
      await this.bumpHit(normalized)

      if (hit.resolution_failed) {
        // Don't retry a known-bad query for a month
        const age = Date.now() - new Date(hit.created_at).getTime()
        if (age < FAILURE_RETRY_AFTER_DAYS * 86_400_000) return null
      } else if (hit.lat != null && hit.lng != null) {
        return this.toResult(hit, 'exact_cache')
      }
    }

    // ── 2. Semantic cache — handles typos, paraphrases, Telugu ─────────────
    let embedding: string | null = null
    try {
      const vec = await generateEmbedding(rawQuery)
      embedding = `[${vec.join(',')}]`

      const semantic = await query<CacheRow & { similarity: number }>(
        `SELECT lat, lng, formatted_address, locality, city,
                h3_r8, h3_r7, h3_r6, precision_level,
                resolution_failed, created_at,
                1 - (embedding <=> $1::vector) AS similarity
         FROM geo_cache
         WHERE embedding IS NOT NULL
           AND resolution_failed = false
           AND lat IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT 1`,
        [embedding]
      )

      const top = semantic.rows[0]
      if (top && Number(top.similarity) >= SEMANTIC_MATCH_THRESHOLD) {
        // Cache this phrasing too, pointing at the same coordinates
        await this.cacheResult(normalized, rawQuery, embedding, {
          lat: top.lat!,
          lng: top.lng!,
          formattedAddress: top.formatted_address,
          locality: top.locality,
          city: top.city,
          precision: top.precision_level,
          provider: 'agent',
        })

        logger.debug(
          { rawQuery, matchedLocality: top.locality, sim: top.similarity },
          'Geocode resolved from semantic cache'
        )
        return this.toResult(top, 'semantic_cache')
      }
    } catch (err) {
      logger.debug({ err }, 'Embedding unavailable — skipping semantic geocode step')
    }

    // ── 3. Geocoding provider ──────────────────────────────────────────────
    const geocoded =
      (await this.tryGoogle(rawQuery, cityHint)) ??
      (await this.tryNominatim(rawQuery, cityHint))

    if (geocoded) {
      await this.cacheResult(normalized, rawQuery, embedding, geocoded)
      const h3 = indexLocation(geocoded.lat, geocoded.lng)
      return {
        ...geocoded,
        ...h3,
        resolvedVia: geocoded.provider === 'google' ? 'google' : 'nominatim',
      }
    }

    // ── 4. Fuzzy locality match against what we already know ──────────────
    const fuzzy = await query<CacheRow>(
      `SELECT lat, lng, formatted_address, locality, city,
              h3_r8, h3_r7, h3_r6, precision_level,
              resolution_failed, created_at
       FROM geo_cache
       WHERE resolution_failed = false
         AND lat IS NOT NULL
         AND (locality ILIKE '%' || $1 || '%' OR query_normalized ILIKE '%' || $1 || '%')
       ORDER BY hit_count DESC
       LIMIT 1`,
      [normalized.split(/\s+/)[0]]
    )

    if (fuzzy.rows[0]) {
      return this.toResult(fuzzy.rows[0], 'locality_fuzzy')
    }

    // Cache the failure so we stop paying for this lookup
    await this.cacheFailure(normalized, rawQuery, embedding, 'No provider result')
    return null
  }

  // ─── Google Geocoding ──────────────────────────────────────────────────────
  private async tryGoogle(
    q: string,
    cityHint: string
  ): Promise<ProviderResult | null> {
    const key = process.env.GOOGLE_MAPS_API_KEY
    if (!key) return null

    try {
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json` +
        `?address=${encodeURIComponent(`${q}, ${cityHint}`)}` +
        `&region=in&key=${key}`

      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null

      const data = (await res.json()) as {
        status: string
        results?: Array<{
          geometry: { location: { lat: number; lng: number }; location_type?: string }
          formatted_address: string
          address_components: Array<{ long_name: string; types: string[] }>
        }>
      }

      if (data.status !== 'OK' || !data.results?.length) return null

      const r = data.results[0]
      const locality = r.address_components.find((c) =>
        c.types.includes('sublocality_level_1') || c.types.includes('sublocality')
      )?.long_name
      const city = r.address_components.find((c) =>
        c.types.includes('locality')
      )?.long_name

      return {
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        formattedAddress: r.formatted_address,
        locality: locality ?? null,
        city: city ?? null,
        precision: this.mapGooglePrecision(r.geometry.location_type),
        provider: 'google',
      }
    } catch (err) {
      logger.warn({ err, q }, 'Google geocoding failed')
      return null
    }
  }

  // ─── Nominatim (OpenStreetMap) — free fallback ─────────────────────────────
  private async tryNominatim(
    q: string,
    cityHint: string
  ): Promise<ProviderResult | null> {
    try {
      const url =
        `https://nominatim.openstreetmap.org/search` +
        `?q=${encodeURIComponent(`${q}, ${cityHint}`)}` +
        `&format=json&limit=1&countrycodes=in`

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Locogi/1.0 (local services, Hyderabad)' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null

      const data = (await res.json()) as Array<{
        lat: string
        lon: string
        display_name: string
        type?: string
      }>

      if (!data.length) return null
      const r = data[0]

      return {
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        formattedAddress: r.display_name,
        locality: r.display_name.split(',')[0]?.trim() ?? null,
        city: cityHint.split(',')[0]?.trim() ?? null,
        precision: r.type === 'house' ? 'rooftop' : 'locality',
        provider: 'nominatim',
      }
    } catch (err) {
      logger.warn({ err, q }, 'Nominatim geocoding failed')
      return null
    }
  }

  // ─── Cache writes ──────────────────────────────────────────────────────────
  private async cacheResult(
    normalized: string,
    original: string,
    embedding: string | null,
    r: ProviderResult
  ): Promise<void> {
    const h3 = indexLocation(r.lat, r.lng)
    await query(
      `INSERT INTO geo_cache
         (query_normalized, query_original, lat, lng, formatted_address,
          locality, city, h3_r8, h3_r7, h3_r6, embedding, provider,
          precision_level)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12,$13)
       ON CONFLICT (query_normalized) DO UPDATE
         SET lat = EXCLUDED.lat, lng = EXCLUDED.lng,
             resolution_failed = false, last_hit_at = now()`,
      [
        normalized, original, r.lat, r.lng, r.formattedAddress,
        r.locality, r.city, h3.h3_r8, h3.h3_r7, h3.h3_r6,
        embedding, r.provider, r.precision,
      ]
    )
  }

  private async cacheFailure(
    normalized: string,
    original: string,
    embedding: string | null,
    reason: string
  ): Promise<void> {
    await query(
      `INSERT INTO geo_cache
         (query_normalized, query_original, embedding, resolution_failed, failure_reason)
       VALUES ($1,$2,$3::vector,true,$4)
       ON CONFLICT (query_normalized) DO UPDATE
         SET failure_reason = EXCLUDED.failure_reason, last_hit_at = now()`,
      [normalized, original, embedding, reason]
    )
  }

  private async bumpHit(normalized: string): Promise<void> {
    await query(
      `UPDATE geo_cache
       SET hit_count = hit_count + 1, last_hit_at = now()
       WHERE query_normalized = $1`,
      [normalized]
    )
  }

  private toResult(row: CacheRow, via: GeoResult['resolvedVia']): GeoResult {
    return {
      lat: row.lat!,
      lng: row.lng!,
      formattedAddress: row.formatted_address,
      locality: row.locality,
      city: row.city,
      h3_r8: row.h3_r8!,
      h3_r7: row.h3_r7!,
      h3_r6: row.h3_r6!,
      precision: row.precision_level,
      resolvedVia: via,
    }
  }

  private mapGooglePrecision(t?: string): string {
    switch (t) {
      case 'ROOFTOP': return 'rooftop'
      case 'RANGE_INTERPOLATED': return 'street'
      case 'GEOMETRIC_CENTER': return 'locality'
      case 'APPROXIMATE': return 'approximate'
      default: return 'locality'
    }
  }

  // ─── Ops visibility: what geography are users actually typing? ─────────────
  async getCacheStats(): Promise<{
    totalCached: number
    failureRate: number
    topQueries: Array<{ query: string; hits: number; locality: string | null }>
    unresolvedQueries: Array<{ query: string; reason: string | null }>
  }> {
    const stats = await query<{ total: string; failed: string }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE resolution_failed) AS failed
       FROM geo_cache`
    )
    const top = await query<{ query_original: string; hit_count: number; locality: string | null }>(
      `SELECT query_original, hit_count, locality FROM geo_cache
       WHERE resolution_failed = false
       ORDER BY hit_count DESC LIMIT 20`
    )
    const unresolved = await query<{ query_original: string; failure_reason: string | null }>(
      `SELECT query_original, failure_reason FROM geo_cache
       WHERE resolution_failed = true
       ORDER BY last_hit_at DESC LIMIT 20`
    )

    const total = Number(stats.rows[0]?.total ?? 0)
    const failed = Number(stats.rows[0]?.failed ?? 0)

    return {
      totalCached: total,
      failureRate: total > 0 ? Math.round((failed / total) * 100) / 100 : 0,
      topQueries: top.rows.map((r) => ({
        query: r.query_original,
        hits: r.hit_count,
        locality: r.locality,
      })),
      unresolvedQueries: unresolved.rows.map((r) => ({
        query: r.query_original,
        reason: r.failure_reason,
      })),
    }
  }
}

interface CacheRow {
  lat: number | null
  lng: number | null
  formatted_address: string | null
  locality: string | null
  city: string | null
  h3_r8: string | null
  h3_r7: string | null
  h3_r6: string | null
  precision_level: string | null
  resolution_failed: boolean
  created_at: string
}

interface ProviderResult {
  lat: number
  lng: number
  formattedAddress: string | null
  locality: string | null
  city: string | null
  precision: string | null
  provider: 'google' | 'nominatim' | 'agent' | 'manual'
}
