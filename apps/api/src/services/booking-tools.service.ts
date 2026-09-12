/**
 * Domain tools for conversational booking operations.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE AUTHORIZATION RULE, AND WHY IT IS SHAPED THIS WAY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every tool takes `customerId` from the authenticated session — never from
 * the model, never from the request body — and every read goes through
 * `requestRepo.findBookingForCustomer(bookingId, customerId)`, which carries
 * the ownership predicate INSIDE the SQL.
 *
 * That is deliberately not "fetch, then compare". A fetch-then-compare can be
 * written correctly and then edited incorrectly six months later, and the bug
 * is invisible in review because the fetch still looks fine. With the
 * predicate in the query there is no intermediate object to forget to check:
 * another user's booking simply does not come back.
 *
 * A booking that isn't theirs returns exactly what a nonexistent booking
 * returns. Distinguishing "not yours" from "no such booking" would confirm
 * which ids exist, which is an enumeration oracle.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THESE REUSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing here reimplements booking logic. Cancellation goes through
 * `requestRepo.cancelWithinWindow`, which enforces the state graph from step 3
 * and the cancellation window. Rescheduling goes through the existing
 * `BookingLifecycleService`. These tools are a conversational façade over
 * machinery that already works, not a second implementation of it.
 */

import { requestRepo, conversationRepo } from '../repositories'
import type { BookingCandidate } from '../repositories/request.repository'
import { BookingLifecycleService } from './booking-lifecycle.service'
import { isTerminal, type RequestStatus } from '../domain/request-state'
import { logger } from '../lib/logger'

const lifecycle = new BookingLifecycleService()

export type ToolFailure =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_permitted'; detail: string }
  | { ok: false; reason: 'unavailable'; detail: string }

export type ToolResult<T> = ({ ok: true } & T) | ToolFailure

/** Statuses a user would call "a booking" rather than "a request". */
function isCommitted(status: RequestStatus): boolean {
  return status === 'confirmed' || status === 'in_progress'
}

export class BookingToolsService {
  // ═══════════════════════════════════════════════════════════════════════════
  // READS
  // ═══════════════════════════════════════════════════════════════════════════

  async getUserBookings(
    customerId: string,
    opts: { includeTerminal?: boolean } = {}
  ): Promise<ToolResult<{ bookings: BookingCandidate[] }>> {
    const bookings = await requestRepo.listBookingsForResolution(customerId, opts)
    return { ok: true, bookings }
  }

  async getBooking(
    bookingId: string,
    customerId: string
  ): Promise<ToolResult<{ booking: BookingCandidate }>> {
    const booking = await requestRepo.findBookingForCustomer(bookingId, customerId)
    if (!booking) return { ok: false, reason: 'not_found' }
    return { ok: true, booking }
  }

  /**
   * Where the provider physically is.
   *
   * Refuses rather than guessing, and the refusals are specific because each
   * one means something different to the user: a booking that hasn't started
   * yet, a vendor who hasn't been assigned, and a vendor who simply isn't
   * sharing location are three different answers.
   *
   * It must never imply live tracking that isn't happening. Saying "on the
   * way" about a vendor who has not opened the app is worse than saying
   * nothing — the customer stops calling them and waits.
   */
  async trackBooking(
    bookingId: string,
    customerId: string
  ): Promise<
    ToolResult<{
      booking: BookingCandidate
      tracking:
        | { available: true; lat: number; lng: number; updatedAt: string }
        | { available: false; why: 'not_started' | 'no_vendor' | 'not_sharing' }
    }>
  > {
    const booking = await requestRepo.findBookingForCustomer(bookingId, customerId)
    if (!booking) return { ok: false, reason: 'not_found' }

    if (!booking.vendorId) {
      return { ok: true, booking, tracking: { available: false, why: 'no_vendor' } }
    }
    if (!isCommitted(booking.status)) {
      return { ok: true, booking, tracking: { available: false, why: 'not_started' } }
    }

    const live = await requestRepo.findLiveLocation(bookingId)
    if (!live) {
      return { ok: true, booking, tracking: { available: false, why: 'not_sharing' } }
    }

    return {
      ok: true,
      booking,
      tracking: {
        available: true,
        lat: live.lat,
        lng: live.lng,
        updatedAt: live.updatedAt,
      },
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MUTATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Cancel, for real.
   *
   * Only ever called after the user has confirmed — the orchestrator arms a
   * pending confirmation and this runs when they answer. It re-checks
   * ownership anyway, because a tool that is only safe when called correctly
   * is not safe.
   */
  async cancelBooking(
    bookingId: string,
    customerId: string
  ): Promise<ToolResult<{ booking: BookingCandidate }>> {
    const booking = await requestRepo.findBookingForCustomer(bookingId, customerId)
    if (!booking) return { ok: false, reason: 'not_found' }

    if (isTerminal(booking.status)) {
      return {
        ok: false,
        reason: 'not_permitted',
        detail: `That booking is already ${booking.status.replace(/_/g, ' ')}.`,
      }
    }

    // The window and the legal-predecessor guard both live in the repository,
    // derived from the state graph. Not duplicated here.
    const cancelled = await requestRepo.cancelWithinWindow(
      bookingId,
      customerId,
      CANCELLATION_WINDOW_MINUTES
    )

    if (!cancelled) {
      return {
        ok: false,
        reason: 'not_permitted',
        detail:
          'The free cancellation window for that booking has passed. ' +
          'Message the provider, or contact support if something has gone wrong.',
      }
    }

    await conversationRepo.clearActiveBooking(customerId, bookingId)

    const after = await requestRepo.findBookingForCustomer(bookingId, customerId)
    logger.info({ bookingId }, 'Booking cancelled from chat')
    return { ok: true, booking: after ?? booking }
  }

  async rescheduleBooking(
    bookingId: string,
    customerId: string,
    newSlotId: string
  ): Promise<ToolResult<{ message: string }>> {
    const booking = await requestRepo.findBookingForCustomer(bookingId, customerId)
    if (!booking) return { ok: false, reason: 'not_found' }

    const result = await lifecycle.reschedule({
      requestId: bookingId,
      newSlotId,
      initiatedBy: 'customer',
      userId: customerId,
    })

    if (!result.success) {
      return { ok: false, reason: 'not_permitted', detail: result.message }
    }
    return { ok: true, message: result.message }
  }

  async getQuotes(
    bookingId: string,
    customerId: string
  ): Promise<ToolResult<{ booking: BookingCandidate }>> {
    // Quote reads are already served by GET /requests/:id/quotes, which does
    // its own ownership check. This tool exists to confirm the request is the
    // caller's before the card is told to fetch from there.
    const booking = await requestRepo.findBookingForCustomer(bookingId, customerId)
    if (!booking) return { ok: false, reason: 'not_found' }
    return { ok: true, booking }
  }
}

/**
 * Matches the window the existing POST /requests/:id/cancel route enforces.
 *
 * Stated as a named constant here rather than re-typed as a literal, because
 * two cancellation paths disagreeing about the window is exactly the class of
 * drift step 3 was spent removing.
 */
export const CANCELLATION_WINDOW_MINUTES = 5
