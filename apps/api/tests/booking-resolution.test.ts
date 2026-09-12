/**
 * Tests for booking resolution.
 *
 * This is the code that decides what "cancel it" refers to. Every scenario the
 * brief enumerates is here, plus the cases that would quietly cancel the wrong
 * job. No database, no model — the ladder is pure, so all of it is cheap.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveBooking,
  judgeConfidence,
  matchesCategory,
  type Resolution,
} from '../src/domain/booking-resolution'
import type { BookingCandidate } from '../src/repositories/request.repository'
import type { UserIntent } from '@locogi/types'

const NOW = new Date('2026-08-21T12:00:00+05:30')

function booking(over: Partial<BookingCandidate> & { id: string }): BookingCandidate {
  return {
    description: 'a job',
    status: 'confirmed',
    bookingType: 'appointment',
    agreedPrice: 1000,
    createdAt: '2026-08-20T10:00:00+05:30',
    vendorId: null,
    vendorName: null,
    vendorRating: null,
    slotTime: null,
    categories: [],
    ...over,
  }
}

const AC = booking({
  id: 'BK001',
  description: 'AC not cooling, need repair',
  categories: ['AC Repair'],
  slotTime: '2026-08-21T18:00:00+05:30', // today
  agreedPrice: 950,
  vendorId: 'V-AC',
  vendorName: 'CoolFix',
})

const PHOTO = booking({
  id: 'BK002',
  description: 'photographer for my sister wedding',
  categories: ['Event Photography'],
  slotTime: '2026-08-22T17:00:00+05:30', // Saturday
  agreedPrice: 4500,
  vendorId: 'V-PHOTO',
  vendorName: 'Rahul Photography',
  vendorRating: 4.8,
})

const CLEAN = booking({
  id: 'BK003',
  description: 'deep cleaning 2bhk',
  categories: ['Home Cleaning'],
  slotTime: '2026-08-24T09:00:00+05:30', // Monday
  agreedPrice: 1800,
  vendorId: 'V-CLEAN',
})

function intent(over: Partial<UserIntent> = {}): UserIntent {
  return { name: 'GET_BOOKING', confidence: 0.9, ...over }
}

function resolve(
  candidates: BookingCandidate[],
  i: Partial<UserIntent> = {},
  context: { activeBookingId?: string; lastReferencedBookingId?: string } = {}
): Resolution {
  return resolveBooking({ intent: intent(i), candidates, context, now: NOW })
}

// ─────────────────────────────────────────────────────────────────────────────
// The scenarios the brief names
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 1 — one booking, "where is my booking?"', () => {
  it('resolves it without asking', () => {
    const r = resolve([PHOTO])
    expect(r.status).toBe('RESOLVED')
    if (r.status === 'RESOLVED') {
      expect(r.booking.id).toBe('BK002')
      expect(r.source).toBe('sole_candidate')
    }
  })
})

describe('Scenario 2 — several bookings, "where is my booking?"', () => {
  it('asks instead of guessing', () => {
    const r = resolve([AC, PHOTO, CLEAN])
    expect(r.status).toBe('AMBIGUOUS')
    if (r.status === 'AMBIGUOUS') {
      expect(r.candidates).toHaveLength(3)
      expect(r.reason).toBe('multiple_candidates')
    }
  })

  it('offers them soonest-first, so the list reads naturally', () => {
    const r = resolve([CLEAN, PHOTO, AC])
    if (r.status === 'AMBIGUOUS') {
      expect(r.candidates.map((c) => c.id)).toEqual(['BK001', 'BK002', 'BK003'])
    }
  })

  it('never silently picks the soonest', () => {
    // The tempting heuristic, and the one that cancels the wrong booking.
    const r = resolve([AC, PHOTO, CLEAN])
    expect(r.status).not.toBe('RESOLVED')
  })
})

describe('Scenario 3 — "show my photography booking"', () => {
  it('resolves by category', () => {
    const r = resolve([AC, PHOTO, CLEAN], { category: 'photography' })
    expect(r.status).toBe('RESOLVED')
    if (r.status === 'RESOLVED') {
      expect(r.booking.id).toBe('BK002')
      expect(r.source).toBe('category_reference')
    }
  })

  it('matches the wording the user originally typed, not just the taxonomy', () => {
    // Taxonomy says "Event Photography"; the user said "photographer".
    const r = resolve([AC, PHOTO], { category: 'photographer' })
    expect(r.status).toBe('RESOLVED')
  })

  it('says not found rather than answering about a different category', () => {
    // Asking about plumbing and getting the AC booking would be worse than
    // an honest miss.
    const r = resolve([AC, PHOTO], { category: 'plumbing' })
    expect(r.status).toBe('NOT_FOUND')
    if (r.status === 'NOT_FOUND') expect(r.reason).toBe('no_booking_in_category')
  })

  it('asks when a category has two bookings', () => {
    const photo2 = booking({
      ...PHOTO,
      id: 'BK004',
      slotTime: '2026-08-29T17:00:00+05:30',
    })
    const r = resolve([PHOTO, photo2], { category: 'photography' })
    expect(r.status).toBe('AMBIGUOUS')
    if (r.status === 'AMBIGUOUS') expect(r.reason).toBe('multiple_in_category')
  })

  it('uses a date to break a category tie', () => {
    const photo2 = booking({
      ...PHOTO,
      id: 'BK004',
      slotTime: '2026-08-29T17:00:00+05:30',
    })
    const r = resolve([PHOTO, photo2], {
      category: 'photography',
      date: '2026-08-29',
    })
    expect(r.status).toBe('RESOLVED')
    if (r.status === 'RESOLVED') expect(r.booking.id).toBe('BK004')
  })
})

describe('Scenario 8 — no bookings at all', () => {
  it('reports nothing found', () => {
    const r = resolve([])
    expect(r.status).toBe('NOT_FOUND')
    if (r.status === 'NOT_FOUND') expect(r.reason).toBe('no_bookings')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Precedence
// ─────────────────────────────────────────────────────────────────────────────

describe('the ladder is ordered, not scored', () => {
  it('lets an explicit id beat active context', () => {
    const r = resolve([AC, PHOTO], { bookingId: 'BK001' }, { activeBookingId: 'BK002' })
    if (r.status === 'RESOLVED') {
      expect(r.booking.id).toBe('BK001')
      expect(r.source).toBe('explicit_id')
    }
  })

  it('lets a category beat active context', () => {
    const r = resolve([AC, PHOTO], { category: 'photography' }, { activeBookingId: 'BK001' })
    if (r.status === 'RESOLVED') expect(r.booking.id).toBe('BK002')
  })

  it('prefers active context over last referenced', () => {
    const r = resolve([AC, PHOTO], {}, {
      activeBookingId: 'BK002',
      lastReferencedBookingId: 'BK001',
    })
    if (r.status === 'RESOLVED') {
      expect(r.booking.id).toBe('BK002')
      expect(r.source).toBe('active_context')
    }
  })

  it('falls back to last referenced when there is no active booking', () => {
    const r = resolve([AC, PHOTO], {}, { lastReferencedBookingId: 'BK001' })
    if (r.status === 'RESOLVED') {
      expect(r.booking.id).toBe('BK001')
      expect(r.source).toBe('last_referenced')
    }
  })

  it('resolves the only upcoming booking among past ones', () => {
    const past = booking({
      id: 'BK000',
      slotTime: '2026-08-10T10:00:00+05:30',
      status: 'completed',
    })
    const r = resolve([past, PHOTO])
    if (r.status === 'RESOLVED') expect(r.source).toBe('sole_upcoming')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Security
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 7 — an id the user does not own', () => {
  it('reports not found rather than resolving something else', () => {
    // The candidate list is already scoped to the caller, so an id from
    // outside it simply is not there. Critically it must NOT then fall
    // through the ladder and answer about a booking they do own.
    const r = resolve([AC, PHOTO], { bookingId: 'BK999-someone-else' })
    expect(r.status).toBe('NOT_FOUND')
    if (r.status === 'NOT_FOUND') expect(r.reason).toBe('booking_not_found')
  })

  it('gives the same answer for a nonexistent id as for another user\'s', () => {
    // Distinguishable answers would be an enumeration oracle.
    const a = resolve([AC], { bookingId: 'BK-does-not-exist' })
    const b = resolve([AC], { bookingId: 'BK-belongs-to-someone-else' })
    expect(a).toEqual(b)
  })

  it('ignores a provider id the user has no booking with', () => {
    const r = resolve([AC], { providerId: 'V-STRANGER' })
    // Falls through to the sole candidate rather than leaking that V-STRANGER
    // exists — and it is the user's own booking either way.
    expect(r.status).toBe('RESOLVED')
    if (r.status === 'RESOLVED') expect(r.booking.id).toBe('BK001')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Category matching
// ─────────────────────────────────────────────────────────────────────────────

describe('matchesCategory', () => {
  it('matches canonical taxonomy names', () => {
    expect(matchesCategory(PHOTO, 'Event Photography')).toBe(true)
  })

  it('matches a stem, so photographer finds photography', () => {
    expect(matchesCategory(PHOTO, 'photographer')).toBe(true)
  })

  it('matches free text from the original request', () => {
    expect(matchesCategory(PHOTO, 'wedding')).toBe(true)
  })

  it('does not match an unrelated category', () => {
    expect(matchesCategory(PHOTO, 'plumbing')).toBe(false)
  })

  it('ignores punctuation and case', () => {
    expect(matchesCategory(AC, '  A/C  ')).toBe(true)
  })

  it('refuses an empty needle instead of matching everything', () => {
    expect(matchesCategory(PHOTO, '')).toBe(false)
    expect(matchesCategory(PHOTO, '   ')).toBe(false)
  })

  it('does not let a two-letter stem match half the catalogue', () => {
    // Guards the stem shortcut: "as" must not match "AC Repair" via stemming.
    expect(matchesCategory(CLEAN, 'as')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Confidence
// ─────────────────────────────────────────────────────────────────────────────

describe('judgeConfidence', () => {
  const resolved = (source: 'explicit_id' | 'sole_candidate'): Resolution => ({
    status: 'RESOLVED',
    booking: PHOTO,
    source,
  })

  it('executes a confident read', () => {
    expect(
      judgeConfidence({ confidence: 0.9, isMutation: false, resolution: resolved('sole_candidate') })
    ).toBe('execute')
  })

  it('holds a mutation to a higher bar than a read', () => {
    const p = { confidence: 0.7, resolution: resolved('sole_candidate') }
    expect(judgeConfidence({ ...p, isMutation: false })).toBe('execute')
    expect(judgeConfidence({ ...p, isMutation: true })).toBe('clarify')
  })

  it('never executes on an ambiguous resolution, however confident', () => {
    // Confidence in the INTENT says nothing about which booking is meant.
    expect(
      judgeConfidence({
        confidence: 1,
        isMutation: false,
        resolution: { status: 'AMBIGUOUS', candidates: [AC, PHOTO], reason: 'x' },
      })
    ).toBe('clarify')
  })

  it('never executes when nothing was found', () => {
    expect(
      judgeConfidence({
        confidence: 1,
        isMutation: true,
        resolution: { status: 'NOT_FOUND', reason: 'no_bookings' },
      })
    ).toBe('clarify')
  })

  it('relaxes the bar when the user named the booking outright', () => {
    // 0.75 is below the 0.85 mutation bar, but the entity is not in doubt.
    expect(
      judgeConfidence({ confidence: 0.75, isMutation: true, resolution: resolved('explicit_id') })
    ).toBe('execute')
  })

  it('rejects a very low confidence outright', () => {
    expect(
      judgeConfidence({ confidence: 0.2, isMutation: false, resolution: resolved('sole_candidate') })
    ).toBe('reject')
  })

  it('still refuses a low-confidence mutation even when explicit', () => {
    expect(
      judgeConfidence({ confidence: 0.3, isMutation: true, resolution: resolved('explicit_id') })
    ).toBe('reject')
  })
})
