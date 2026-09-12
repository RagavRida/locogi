/**
 * End-to-end tests for the conversational booking pipeline.
 *
 * The model and the database are mocked; everything between them is real —
 * intent handling, the resolution ladder, the confidence policy, the
 * confirmation state machine, UI selection, and context updates.
 *
 * Covers the ten scenarios the brief enumerates, plus the ones that would
 * cancel the wrong booking or leak someone else's.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ───────────────────────────────────────────────────────────────────
const runTask = vi.fn()
vi.mock('../src/ai/contract', () => ({
  runTask: (...a: unknown[]) => runTask(...a),
  untrusted: (t: string) => t,
}))

const repo = {
  listBookingsForResolution: vi.fn(),
  findBookingForCustomer: vi.fn(),
  cancelWithinWindow: vi.fn(),
  findLiveLocation: vi.fn(),
}
const convo = {
  get: vi.fn(),
  update: vi.fn(),
  setPending: vi.fn(),
  consumePending: vi.fn(),
  clearPending: vi.fn(),
  clearActiveBooking: vi.fn(),
}
vi.mock('../src/repositories', () => ({
  requestRepo: new Proxy({}, { get: (_t, k) => (repo as never)[k] }),
  conversationRepo: new Proxy({}, { get: (_t, k) => (convo as never)[k] }),
}))

vi.mock('../src/services/booking-lifecycle.service', () => ({
  BookingLifecycleService: class {
    reschedule = vi.fn()
  },
}))

const { ChatOrchestratorService } = await import('../src/services/chat-orchestrator.service')

// ─── Fixtures ────────────────────────────────────────────────────────────────
const USER = 'user-1'
const NOW = new Date('2026-08-21T12:00:00+05:30')

function booking(over: Record<string, unknown> & { id: string }) {
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
  categories: ['AC Repair'],
  slotTime: '2026-08-21T18:00:00+05:30',
  agreedPrice: 950,
  vendorId: 'V-AC',
  vendorName: 'CoolFix',
})
const PHOTO = booking({
  id: 'BK002',
  categories: ['Photography'],
  slotTime: '2026-08-22T17:00:00+05:30',
  agreedPrice: 4500,
  vendorId: 'V-PHOTO',
  vendorName: 'Rahul Photography',
})
const CLEAN = booking({
  id: 'BK003',
  categories: ['Home Cleaning'],
  slotTime: '2026-08-24T09:00:00+05:30',
  vendorId: 'V-CLEAN',
})

function intentReply(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: { name: 'GET_BOOKING', confidence: 0.95, ...over },
  }
}

let svc: InstanceType<typeof ChatOrchestratorService>

beforeEach(() => {
  vi.clearAllMocks()
  svc = new ChatOrchestratorService()
  convo.get.mockResolvedValue(null)
  convo.update.mockResolvedValue(undefined)
  convo.setPending.mockResolvedValue(undefined)
  convo.clearPending.mockResolvedValue(undefined)
  convo.clearActiveBooking.mockResolvedValue(undefined)
  repo.listBookingsForResolution.mockResolvedValue([])
  repo.findBookingForCustomer.mockResolvedValue(null)
  repo.findLiveLocation.mockResolvedValue(null)
})

const send = (text: string) => svc.handle({ userId: USER, text, now: NOW })

// ═════════════════════════════════════════════════════════════════════════════

describe('Scenario 1 — one booking, "where is my booking?"', () => {
  it('renders the detail card', async () => {
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    repo.findBookingForCustomer.mockResolvedValue(PHOTO)
    runTask.mockResolvedValue(intentReply())

    const r = await send('where is my booking?')

    expect(r?.ui?.type).toBe('booking_detail')
    expect(r?.ui?.data.bookingId).toBe('BK002')
  })

  it('records the booking as active so follow-ups resolve', async () => {
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    repo.findBookingForCustomer.mockResolvedValue(PHOTO)
    runTask.mockResolvedValue(intentReply())

    await send('where is my booking?')

    expect(convo.update).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        activeBookingId: 'BK002',
        lastReferencedEntity: { type: 'booking', id: 'BK002' },
      })
    )
  })
})

describe('Scenario 2 — several bookings', () => {
  it('renders a selector rather than guessing', async () => {
    repo.listBookingsForResolution.mockResolvedValue([AC, PHOTO, CLEAN])
    runTask.mockResolvedValue(intentReply())

    const r = await send('where is my booking?')

    expect(r?.ui?.type).toBe('booking_selector')
    expect(r?.ui?.data.bookingIds).toEqual(['BK001', 'BK002', 'BK003'])
  })

  it('does not execute a tool while ambiguous', async () => {
    repo.listBookingsForResolution.mockResolvedValue([AC, PHOTO, CLEAN])
    runTask.mockResolvedValue(intentReply())

    await send('where is my booking?')
    expect(repo.findBookingForCustomer).not.toHaveBeenCalled()
  })
})

describe('Scenario 3 — "show my photography booking"', () => {
  it('resolves by category', async () => {
    repo.listBookingsForResolution.mockResolvedValue([AC, PHOTO, CLEAN])
    repo.findBookingForCustomer.mockResolvedValue(PHOTO)
    runTask.mockResolvedValue(intentReply({ category: 'photography' }))

    const r = await send('show my photography booking')

    expect(r?.ui?.data.bookingId).toBe('BK002')
  })
})

describe('Scenario 4 — "where is my photographer?"', () => {
  it('renders tracking when the provider is actually sharing', async () => {
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    repo.findBookingForCustomer.mockResolvedValue(PHOTO)
    repo.findLiveLocation.mockResolvedValue({
      lat: 17.4,
      lng: 78.4,
      updatedAt: NOW.toISOString(),
    })
    runTask.mockResolvedValue(intentReply({ name: 'TRACK_BOOKING' }))

    const r = await send('where is my photographer?')

    expect(r?.ui?.type).toBe('booking_tracking')
    expect(r?.message).toContain('on the way')
  })

  it('never claims live location when the provider is not sharing', async () => {
    // The failure that matters: a customer told "on the way" stops calling.
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    repo.findBookingForCustomer.mockResolvedValue(PHOTO)
    repo.findLiveLocation.mockResolvedValue(null)
    runTask.mockResolvedValue(intentReply({ name: 'TRACK_BOOKING' }))

    const r = await send('where is my photographer?')

    expect(r?.ui?.type).toBe('booking_detail')
    expect(r?.message).toContain('not sharing')
    expect(r?.message).not.toContain('on the way')
  })

  it('says so plainly when no provider is assigned', async () => {
    const unassigned = booking({ id: 'BK009', status: 'open', categories: ['Photography'] })
    repo.listBookingsForResolution.mockResolvedValue([unassigned])
    repo.findBookingForCustomer.mockResolvedValue(unassigned)
    runTask.mockResolvedValue(intentReply({ name: 'TRACK_BOOKING' }))

    const r = await send('where is my photographer?')
    expect(r?.message).toContain('No provider has been assigned')
  })
})

describe('Scenario 5 — "is my booking confirmed?"', () => {
  it('renders the status card and answers directly', async () => {
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    repo.findBookingForCustomer.mockResolvedValue(PHOTO)
    runTask.mockResolvedValue(intentReply({ name: 'GET_BOOKING_STATUS' }))

    const r = await send('is my booking confirmed?')

    expect(r?.ui?.type).toBe('booking_status')
    expect(r?.message).toContain('confirmed')
  })

  it('does not say confirmed when it is not', async () => {
    const pending = booking({ id: 'BK010', status: 'open', categories: ['Photography'] })
    repo.listBookingsForResolution.mockResolvedValue([pending])
    repo.findBookingForCustomer.mockResolvedValue(pending)
    runTask.mockResolvedValue(intentReply({ name: 'GET_BOOKING_STATUS' }))

    const r = await send('is my booking confirmed?')
    expect(r?.message).toContain('Not yet')
  })
})

describe('Scenario 6 — new conversation, "show my bookings"', () => {
  it('reads from the database with no context at all', async () => {
    convo.get.mockResolvedValue(null)
    repo.listBookingsForResolution.mockResolvedValue([AC, PHOTO])
    runTask.mockResolvedValue(intentReply({ name: 'GET_BOOKINGS' }))

    const r = await send('show my bookings')

    expect(r?.ui?.type).toBe('booking_list')
    expect(r?.ui?.data.bookingIds).toEqual(['BK001', 'BK002'])
  })
})

describe("Scenario 7 — an id the user doesn't own", () => {
  it('reports not found and renders no booking', async () => {
    repo.listBookingsForResolution.mockResolvedValue([AC])
    runTask.mockResolvedValue(intentReply({ bookingId: 'BK999-other-user' }))

    const r = await send('show booking BK999')

    expect(r?.ui?.type).toBe('empty_state')
    expect(r?.message).toContain("couldn't find")
  })

  it('never queries for a booking the ladder rejected', async () => {
    repo.listBookingsForResolution.mockResolvedValue([AC])
    runTask.mockResolvedValue(intentReply({ bookingId: 'BK999-other-user' }))

    await send('show booking BK999')
    // The model's id must never reach a lookup.
    expect(repo.findBookingForCustomer).not.toHaveBeenCalled()
  })
})

describe('Scenario 8 — no bookings', () => {
  it('offers to find a service', async () => {
    repo.listBookingsForResolution.mockResolvedValue([])
    runTask.mockResolvedValue(intentReply({ name: 'GET_BOOKINGS' }))

    const r = await send('show my bookings')

    expect(r?.ui?.type).toBe('empty_state')
    expect(r?.ui?.data.action).toBe('find_service')
  })
})

describe('Scenario 9 — cancelling', () => {
  it('asks before cancelling anything', async () => {
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    runTask.mockResolvedValue(intentReply({ name: 'CANCEL_BOOKING' }))

    const r = await send('cancel my booking')

    expect(r?.ui?.type).toBe('confirm_action')
    expect(repo.cancelWithinWindow).not.toHaveBeenCalled()
    expect(convo.setPending).toHaveBeenCalledWith(USER, 'CANCEL_BOOKING', 'BK002')
  })

  it('cancels on an explicit yes', async () => {
    convo.get.mockResolvedValue({
      pendingConfirmation: {
        intent: 'CANCEL_BOOKING',
        bookingId: 'BK002',
        expiresAt: '2999-01-01T00:00:00Z',
      },
      updatedAt: '',
    })
    convo.consumePending.mockResolvedValue({
      intent: 'CANCEL_BOOKING',
      bookingId: 'BK002',
    })
    repo.findBookingForCustomer.mockResolvedValue(PHOTO)
    repo.cancelWithinWindow.mockResolvedValue(true)

    const r = await send('yes')

    expect(repo.cancelWithinWindow).toHaveBeenCalled()
    expect(r?.message).toContain('cancelled')
  })

  it('does NOT cancel on "no"', async () => {
    convo.get.mockResolvedValue({
      pendingConfirmation: {
        intent: 'CANCEL_BOOKING',
        bookingId: 'BK002',
        expiresAt: '2999-01-01T00:00:00Z',
      },
      updatedAt: '',
    })

    const r = await send('no')

    expect(repo.cancelWithinWindow).not.toHaveBeenCalled()
    expect(convo.clearPending).toHaveBeenCalled()
    expect(r?.message).toContain('left it as it is')
  })

  it('does NOT cancel on an unrelated message, and disarms', async () => {
    // A stray "yes" three turns later must not destroy a booking.
    convo.get.mockResolvedValue({
      pendingConfirmation: {
        intent: 'CANCEL_BOOKING',
        bookingId: 'BK002',
        expiresAt: '2999-01-01T00:00:00Z',
      },
      updatedAt: '',
    })
    runTask.mockResolvedValue({ ok: true, data: { name: 'UNKNOWN', confidence: 0.9 } })

    await send('actually what about my AC repair, is that still on for tonight')

    expect(repo.cancelWithinWindow).not.toHaveBeenCalled()
    expect(convo.clearPending).toHaveBeenCalled()
  })

  it('refuses an expired confirmation', async () => {
    convo.get.mockResolvedValue({
      pendingConfirmation: {
        intent: 'CANCEL_BOOKING',
        bookingId: 'BK002',
        expiresAt: '2999-01-01T00:00:00Z',
      },
      updatedAt: '',
    })
    // consumePending is the authority; it refuses expired rows in SQL.
    convo.consumePending.mockResolvedValue(null)

    const r = await send('yes')

    expect(repo.cancelWithinWindow).not.toHaveBeenCalled()
    expect(r?.message).toContain('expired')
  })

  it('surfaces the real reason when the window has passed', async () => {
    convo.get.mockResolvedValue({
      pendingConfirmation: {
        intent: 'CANCEL_BOOKING',
        bookingId: 'BK002',
        expiresAt: '2999-01-01T00:00:00Z',
      },
      updatedAt: '',
    })
    convo.consumePending.mockResolvedValue({
      intent: 'CANCEL_BOOKING',
      bookingId: 'BK002',
    })
    repo.findBookingForCustomer.mockResolvedValue(PHOTO)
    repo.cancelWithinWindow.mockResolvedValue(false)

    const r = await send('yes')
    expect(r?.message).toContain('cancellation window')
  })

  it('refuses to cancel an already-terminal booking', async () => {
    convo.get.mockResolvedValue({
      pendingConfirmation: {
        intent: 'CANCEL_BOOKING',
        bookingId: 'BK002',
        expiresAt: '2999-01-01T00:00:00Z',
      },
      updatedAt: '',
    })
    convo.consumePending.mockResolvedValue({
      intent: 'CANCEL_BOOKING',
      bookingId: 'BK002',
    })
    repo.findBookingForCustomer.mockResolvedValue({ ...PHOTO, status: 'completed' })

    const r = await send('yes')

    expect(repo.cancelWithinWindow).not.toHaveBeenCalled()
    expect(r?.message).toContain('already')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Integration contract with the existing flow
// ═════════════════════════════════════════════════════════════════════════════

describe('falling through to the existing pipeline', () => {
  it('declines a brand-new service need', async () => {
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    runTask.mockResolvedValue({ ok: true, data: { name: 'UNKNOWN', confidence: 0.9 } })

    expect(await send('I need a plumber tomorrow')).toBeNull()
  })

  it('declines CREATE_SERVICE_REQUEST, which the old flow owns', async () => {
    repo.listBookingsForResolution.mockResolvedValue([])
    runTask.mockResolvedValue({
      ok: true,
      data: { name: 'CREATE_SERVICE_REQUEST', confidence: 0.9 },
    })

    expect(await send('book me a photographer')).toBeNull()
  })

  it('declines rather than erroring when the model is unavailable', async () => {
    // A NIM outage must not break the chat; the old pipeline still works.
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    runTask.mockResolvedValue({ ok: false, reason: 'unavailable', detail: 'down' })

    expect(await send('where is my booking?')).toBeNull()
  })
})

describe('confidence policy', () => {
  it('will not act on a very low-confidence read', async () => {
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    runTask.mockResolvedValue(intentReply({ confidence: 0.15 }))

    expect(await send('hmm booking?')).toBeNull()
  })

  it('asks instead of cancelling on a middling-confidence cancel', async () => {
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    runTask.mockResolvedValue(intentReply({ name: 'CANCEL_BOOKING', confidence: 0.7 }))

    const r = await send('maybe cancel that?')

    expect(r?.ui?.type).toBe('confirm_action')
    expect(repo.cancelWithinWindow).not.toHaveBeenCalled()
  })
})

describe('follow-up turns', () => {
  it('resolves "when is it?" from the active booking', async () => {
    convo.get.mockResolvedValue({
      activeBookingId: 'BK002',
      lastIntent: 'GET_BOOKING',
      updatedAt: '',
    })
    repo.listBookingsForResolution.mockResolvedValue([AC, PHOTO, CLEAN])
    repo.findBookingForCustomer.mockResolvedValue(PHOTO)
    runTask.mockResolvedValue(intentReply())

    const r = await send('when is it?')

    // Three bookings would normally be ambiguous; context settles it.
    expect(r?.ui?.type).toBe('booking_detail')
    expect(r?.ui?.data.bookingId).toBe('BK002')
  })

  it('resolves "can I cancel it?" to the same booking and asks first', async () => {
    convo.get.mockResolvedValue({
      activeBookingId: 'BK002',
      updatedAt: '',
    })
    repo.listBookingsForResolution.mockResolvedValue([AC, PHOTO, CLEAN])
    runTask.mockResolvedValue(intentReply({ name: 'CANCEL_BOOKING' }))

    const r = await send('can I cancel it?')

    expect(r?.ui?.type).toBe('confirm_action')
    expect(r?.ui?.data.bookingId).toBe('BK002')
  })
})

describe('UI payloads carry identifiers, not snapshots', () => {
  it('never embeds price or status in the schema', async () => {
    repo.listBookingsForResolution.mockResolvedValue([PHOTO])
    repo.findBookingForCustomer.mockResolvedValue(PHOTO)
    runTask.mockResolvedValue(intentReply())

    const r = await send('where is my booking?')
    const keys = Object.keys(r?.ui?.data ?? {})

    // A persisted snapshot becomes a lie the moment the booking changes.
    expect(keys).not.toContain('price')
    expect(keys).not.toContain('status')
    expect(keys).not.toContain('agreedPrice')
    expect(keys).toContain('bookingId')
  })
})
