/**
 * LocationService — updates H3 index for vendors and requests.
 *
 * Called:
 * - When a vendor sets or updates their location
 * - When a customer request includes a location in attributes
 * - When a rider posts a live_location update (ride mode)
 */

import { query } from '../lib/db'
import { indexLocation, isInHyderabad } from '../lib/h3'
import { logger } from '../lib/logger'
import { GeocodingService } from './geocoding.service'

const geocoder = new GeocodingService()

export class LocationService {

  // ─── Index a vendor's location into H3 cells ───────────────────────────────
  async indexVendorLocation(
    vendorId: string,
    lat: number,
    lng: number
  ): Promise<void> {
    if (!this._validate(lat, lng, vendorId)) return

    const { h3_r8, h3_r7, h3_r6 } = indexLocation(lat, lng)

    await query(
      `UPDATE vendors
       SET lat = $1, lng = $2,
           h3_r8 = $3, h3_r7 = $4, h3_r6 = $5
       WHERE id = $6`,
      [lat, lng, h3_r8, h3_r7, h3_r6, vendorId]
    )

    logger.debug(
      { vendorId, lat, lng, h3_r8 },
      'Vendor H3 index updated'
    )
  }

  // ─── Index a request's location into H3 cells ─────────────────────────────
  async indexRequestLocation(
    requestId: string,
    lat: number,
    lng: number
  ): Promise<void> {
    if (!this._validate(lat, lng, requestId)) return

    const { h3_r8, h3_r7, h3_r6 } = indexLocation(lat, lng)

    await query(
      `UPDATE requests
       SET lat = $1, lng = $2,
           h3_r8 = $3, h3_r7 = $4, h3_r6 = $5
       WHERE id = $6`,
      [lat, lng, h3_r8, h3_r7, h3_r6, requestId]
    )

    logger.debug(
      { requestId, lat, lng, h3_r8 },
      'Request H3 index updated'
    )
  }

  // ─── Extract location from LLM-extracted attributes ───────────────────────
  // The LLM may extract an area name like "Kondapur" or "Madhapur".
  // We geocode it to lat/lng, then H3-index it.
  async indexFromAreaName(
    entityType: 'vendor' | 'request',
    entityId: string,
    areaName: string
  ): Promise<boolean> {
    // Was a 51-entry hardcoded map. Now: geocode, cache, and let the cache
    // grow into whatever geography users actually type — including
    // misspellings, landmarks, Telugu input, and areas nobody predicted.
    const geo = await geocoder.resolve(areaName)

    if (!geo) {
      logger.debug({ areaName }, 'Could not geocode area name — H3 index skipped')
      return false
    }

    if (entityType === 'vendor') {
      await this.indexVendorLocation(entityId, geo.lat, geo.lng)
    } else {
      await this.indexRequestLocation(entityId, geo.lat, geo.lng)
    }

    logger.debug(
      { areaName, locality: geo.locality, via: geo.resolvedVia },
      'Geocoded and H3-indexed from area name'
    )
    return true
  }

  private _validate(lat: number, lng: number, id: string): boolean {
    if (isNaN(lat) || isNaN(lng)) {
      logger.warn({ id, lat, lng }, 'Invalid coordinates — skipping H3 index')
      return false
    }
    if (!isInHyderabad(lat, lng)) {
      logger.warn({ id, lat, lng }, 'Coordinates outside Hyderabad — skipping H3 index')
      return false
    }
    return true
  }
}
