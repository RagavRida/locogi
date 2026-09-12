/**
 * H3 Geospatial Utilities for Locogi
 *
 * Uber's H3 divides Earth into hexagons at 16 resolutions.
 * We use 3 resolutions for a tiered matching strategy:
 *
 *   Resolution 8  → ~460m edge → street-level precision
 *   Resolution 7  → ~1.2km edge → neighbourhood-level
 *   Resolution 6  → ~3.2km edge → zone-level (wide-area fallback)
 *
 * Matching strategy:
 *   1. Try res-8 disk(k=2)  → 19 cells ≈ ~2km radius   (fast, precise)
 *   2. If < MIN_VENDORS, expand to res-7 disk(k=2) ≈ ~5km
 *   3. If still < MIN_VENDORS, expand to res-6 disk(k=2) ≈ ~12km
 *   4. If still none: fall back to category + embedding only (no geo)
 */

import { latLngToCell, gridDisk, cellToLatLng, gridDistance } from 'h3-js'

export const H3_RES_FINE   = 8   // ~460m  — default matching
export const H3_RES_MID    = 7   // ~1.2km — expanded search
export const H3_RES_BROAD  = 6   // ~3.2km — wide-area fallback

export const MIN_VENDORS_THRESHOLD = 3  // expand search if fewer than this

/**
 * Index a lat/lng into all three resolution cells.
 * Store all three on the vendor/request row.
 */
export function indexLocation(lat: number, lng: number): {
  h3_r8: string
  h3_r7: string
  h3_r6: string
} {
  return {
    h3_r8: latLngToCell(lat, lng, H3_RES_FINE),
    h3_r7: latLngToCell(lat, lng, H3_RES_MID),
    h3_r6: latLngToCell(lat, lng, H3_RES_BROAD),
  }
}

/**
 * Get the set of H3 cells to search at a given resolution + ring size.
 *
 * gridDisk(cell, k) returns the center cell + k rings of neighbours:
 *   k=0 →  1 cell  (just the center)
 *   k=1 →  7 cells (~1 ring out)
 *   k=2 → 19 cells (~2 rings out)  ← default for fine resolution
 *   k=3 → 37 cells (~3 rings out)
 */
export function getSearchCells(
  lat: number,
  lng: number,
  resolution: number,
  rings: number = 2
): string[] {
  const center = latLngToCell(lat, lng, resolution)
  return gridDisk(center, rings)
}

/**
 * Tiered search cell strategy.
 * Returns { cells, resolution, rings } for the first tier,
 * then progressively wider tiers if needed.
 */
export function* searchTiers(lat: number, lng: number): Generator<{
  cells: string[]
  resolution: number
  rings: number
  label: string
}> {
  // Tier 1: Fine resolution, 2 rings (~2km)
  yield {
    cells: getSearchCells(lat, lng, H3_RES_FINE, 2),
    resolution: H3_RES_FINE,
    rings: 2,
    label: '~2km',
  }

  // Tier 2: Fine resolution, 4 rings (~4km)
  yield {
    cells: getSearchCells(lat, lng, H3_RES_FINE, 4),
    resolution: H3_RES_FINE,
    rings: 4,
    label: '~4km',
  }

  // Tier 3: Mid resolution, 2 rings (~5km)
  yield {
    cells: getSearchCells(lat, lng, H3_RES_MID, 2),
    resolution: H3_RES_MID,
    rings: 2,
    label: '~5km',
  }

  // Tier 4: Broad resolution, 2 rings (~12km)
  yield {
    cells: getSearchCells(lat, lng, H3_RES_BROAD, 2),
    resolution: H3_RES_BROAD,
    rings: 2,
    label: '~12km',
  }
}

/**
 * Map resolution → column name in the vendors table.
 */
export function resolutionColumn(resolution: number): 'h3_r8' | 'h3_r7' | 'h3_r6' {
  if (resolution === H3_RES_FINE)  return 'h3_r8'
  if (resolution === H3_RES_MID)   return 'h3_r7'
  return 'h3_r6'
}

/**
 * Hyderabad bounding box — quick sanity check before indexing.
 * Rejects obviously wrong coordinates.
 */
const HYDERABAD_BOUNDS = {
  latMin: 17.2,
  latMax: 17.7,
  lngMin: 78.2,
  lngMax: 78.7,
}

export function isInHyderabad(lat: number, lng: number): boolean {
  return (
    lat >= HYDERABAD_BOUNDS.latMin &&
    lat <= HYDERABAD_BOUNDS.latMax &&
    lng >= HYDERABAD_BOUNDS.lngMin &&
    lng <= HYDERABAD_BOUNDS.lngMax
  )
}

/**
 * Human-readable label for a H3 cell (for logging/debugging).
 */
export function cellLabel(h3Index: string): string {
  try {
    const [lat, lng] = cellToLatLng(h3Index)
    return `${lat.toFixed(4)},${lng.toFixed(4)}`
  } catch {
    return h3Index
  }
}

/**
 * Hex hops between two coordinates at a given resolution.
 * Used by TravelService to estimate distance with zero API calls.
 * Returns null when H3 cannot compute a grid path (crossing an
 * icosahedron edge — shouldn't happen at city scale).
 */
export function hexDistanceBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  resolution = H3_RES_MID
): number | null {
  try {
    return gridDistance(
      latLngToCell(a.lat, a.lng, resolution),
      latLngToCell(b.lat, b.lng, resolution)
    )
  } catch {
    return null
  }
}

/**
 * Great-circle distance in kilometres.
 *
 * Used for live-tracking readouts, where H3 grid distance is too coarse: at
 * resolution 7 a hex edge is roughly 1.2km, so a provider two streets away and
 * one a kilometre away can land in the same cell. Tracking wants metres, and
 * this is exact for the straight line.
 *
 * It is straight-line, NOT road distance. Callers presenting an ETA must apply
 * a winding factor and a realistic city speed, as TravelService does.
 */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180

  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
