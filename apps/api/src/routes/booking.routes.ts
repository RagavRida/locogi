/**
 * Read endpoints for the booking cards rendered in chat.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE EXIST WHEN /requests/:id ALREADY DOES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/requests/:id` serves the request-centric flow: extraction, quotes,
 * matching. These serve the booking-centric view a card needs — the vendor's
 * name and rating, the slot time, and the two booleans that decide which
 * buttons are shown. Fetching the request and assembling that on the client
 * would put a policy decision ("can this be cancelled?") in the UI, where it
 * would immediately drift from the server's answer.
 *
 * The word "booking" in the path is the user's word. Underneath, each of these
 * is a `request` in a committed state — there is no second table.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTHORIZATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every read goes through `findBookingForCustomer(id, req.user.id)`, whose
 * ownership predicate is inside the SQL. Someone else's id returns 404 —
 * identical to a nonexistent one, so the endpoint cannot be used to discover
 * which ids are real.
 */

import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../lib/auth'
import { requestRepo, type BookingCandidate } from '../repositories'
import { BookingToolsService, CANCELLATION_WINDOW_MINUTES } from '../services/booking-tools.service'
import { isTerminal } from '../domain/request-state'
import { haversineKm } from '../lib/h3'
import { query } from '../lib/db'
import { realtime } from '../services/realtime.service'
import { isTrackingPhase, type TrackingPhase } from '@locogi/types'
import { logger } from '../lib/logger'

const tools = new BookingToolsService()

/**
 * Whether the free-cancellation window is still open.
 *
 * Computed here so the card's button state and the server's actual decision
 * come from the same rule. The authoritative check still runs on cancel — this
 * only decides whether to offer the button.
 */
function withinCancellationWindow(createdAt: string): boolean {
  const elapsedMinutes = (Date.now() - new Date(createdAt).getTime()) / 60_000
  return elapsedMinutes <= CANCELLATION_WINDOW_MINUTES
}

function toView(b: BookingCandidate) {
  return {
    id: b.id,
    title: b.categories[0] ?? b.description.slice(0, 60),
    status: b.status,
    bookingType: b.bookingType,
    price: b.agreedPrice,
    slotTime: b.slotTime,
    vendorId: b.vendorId,
    vendorName: b.vendorName,
    vendorRating: b.vendorRating,
    categories: b.categories,
    canCancel: !isTerminal(b.status) && withinCancellationWindow(b.createdAt),
    // Only offer Track when a vendor is committed. Offering it on an open
    // request produces a button that can only ever disappoint.
    canTrack:
      b.vendorId !== null && (b.status === 'confirmed' || b.status === 'in_progress'),
  }
}

export async function bookingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/bookings', async (req, reply) => {
    const includeTerminal =
      (req.query as { all?: string }).all === 'true'

    const result = await tools.getUserBookings(req.user!.id, { includeTerminal })
    if (!result.ok) return reply.code(500).send({ message: 'Could not load bookings' })

    return reply.send({ bookings: result.bookings.map(toView) })
  })

  app.get<{ Params: { id: string } }>('/bookings/:id', async (req, reply) => {
    const result = await tools.getBooking(req.params.id, req.user!.id)
    if (!result.ok) return reply.code(404).send({ message: 'Booking not found' })
    return reply.send(toView(result.booking))
  })

  /**
   * Live position of the assigned provider.
   *
   * Returns `available: false` with a reason rather than an error, because
   * "not sharing" is a normal state the card must render honestly. Distance is
   * straight-line and labelled as such downstream — presenting it as road
   * distance would understate every ETA in a city like Hyderabad.
   */
  app.get<{ Params: { id: string } }>('/bookings/:id/tracking', async (req, reply) => {
    const result = await tools.trackBooking(req.params.id, req.user!.id)
    if (!result.ok) return reply.code(404).send({ message: 'Booking not found' })

    if (!result.tracking.available) {
      return reply.send({
        available: false,
        why: result.tracking.why,
        vendorName: result.booking.vendorName,
      })
    }

    const dest = await requestRepo.findById(req.params.id)
    const distanceKm =
      dest?.lat != null && dest?.lng != null
        ? haversineKm(result.tracking.lat, result.tracking.lng, dest.lat, dest.lng)
        : null

    return reply.send({
      available: true,
      lat: result.tracking.lat,
      lng: result.tracking.lng,
      updatedAt: result.tracking.updatedAt,
      vendorName: result.booking.vendorName,
      distanceKm: distanceKm === null ? null : Math.round(distanceKm * 10) / 10,
      // Deliberately pessimistic city speed, consistent with TravelService.
      // An ETA that is too optimistic is worse than none: the customer stops
      // watching the door.
      etaMinutes:
        distanceKm === null ? null : Math.max(1, Math.round((distanceKm / 18) * 60)),
    })
  })

  /**
   * Provider reports where they are in the journey.
   *
   * ── Authorization ─────────────────────────────────────────────────────────
   * Only the ASSIGNED vendor may set this, checked in the SQL. A customer
   * marking their own provider "arrived" would corrupt the very evidence a
   * no-show dispute depends on.
   *
   * ── Why the claim is recorded with its distance ───────────────────────────
   * `tracking_events` stores how far from the job the provider was when they
   * pressed the button. A provider who marks themselves arrived from 4km away
   * is either mistaken or gaming the reliability score, and neither is
   * visible without that number.
   */
  app.post<{ Params: { id: string }; Body: { phase?: string; lat?: number; lng?: number } }>(
    '/bookings/:id/phase',
    async (req, reply) => {
      const phase = req.body?.phase
      if (!isTrackingPhase(phase)) {
        return reply.code(400).send({ message: 'Unknown tracking phase' })
      }

      // Ownership AND assignment in one predicate — the vendor must be the
      // one actually confirmed on this booking.
      const owns = await query<{ request_id: string; lat: number | null; lng: number | null }>(
        `SELECT r.id AS request_id, r.lat, r.lng
           FROM requests r
           JOIN vendors v ON v.id = r.confirmed_vendor_id
          WHERE r.id = $1 AND v.user_id = $2`,
        [req.params.id, req.user!.id]
      )
      const booking = owns.rows[0]
      if (!booking) {
        return reply.code(404).send({ message: 'Booking not found' })
      }

      const lat = typeof req.body?.lat === 'number' ? req.body.lat : null
      const lng = typeof req.body?.lng === 'number' ? req.body.lng : null

      const distanceM =
        lat !== null && lng !== null && booking.lat !== null && booking.lng !== null
          ? Math.round(haversineKm(lat, lng, booking.lat, booking.lng) * 1000)
          : null

      // Current phase lives on live_locations beside the coordinates; the
      // append-only history lives in tracking_events. Both, always — the
      // mutable row answers "where are they now", the log answers "what
      // happened", and a dispute needs the second one.
      await query(
        `INSERT INTO live_locations (user_id, request_id, lat, lng, phase, phase_changed_at, updated_at)
         VALUES ($1, $2, COALESCE($3, 0), COALESCE($4, 0), $5, now(), now())
         ON CONFLICT (user_id) DO UPDATE SET
           request_id = EXCLUDED.request_id,
           lat = COALESCE($3, live_locations.lat),
           lng = COALESCE($4, live_locations.lng),
           phase = EXCLUDED.phase,
           phase_changed_at =
             CASE WHEN live_locations.phase IS DISTINCT FROM EXCLUDED.phase
                  THEN now() ELSE live_locations.phase_changed_at END,
           updated_at = now()`,
        [req.user!.id, req.params.id, lat, lng, phase]
      )

      await query(
        `INSERT INTO tracking_events
           (request_id, vendor_user_id, phase, lat, lng, distance_from_job_m)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.params.id, req.user!.id, phase, lat, lng, distanceM]
      )

      // This is what removes the 20-second poll: the customer's open socket
      // hears immediately instead of discovering it up to 20s later.
      await realtime.trackingUpdated(req.params.id, {
        phase: phase as TrackingPhase,
        movedAt: new Date().toISOString(),
      })

      if (distanceM !== null && phase === 'arrived' && distanceM > 500) {
        logger.warn(
          { requestId: req.params.id, distanceM },
          'Provider marked arrived from an implausible distance'
        )
      }

      return reply.send({ success: true, phase })
    }
  )

  /**
   * Cancel from a card button.
   *
   * The chat path arms a confirmation before reaching this; a button press IS
   * the confirmation, so it executes directly. Both paths converge on the same
   * tool, which re-checks ownership, terminality and the window.
   */
  app.post<{ Params: { id: string } }>('/bookings/:id/cancel', async (req, reply) => {
    const result = await tools.cancelBooking(req.params.id, req.user!.id)

    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404 : 409
      return reply.code(code).send({
        success: false,
        message:
          result.reason === 'not_found'
            ? 'Booking not found'
            : result.detail,
      })
    }

    return reply.send({ success: true, message: 'Your booking is cancelled.' })
  })
}
