/**
 * CRITICAL PATH TEST — concurrent booking confirmation.
 *
 * This is the highest-risk code in Locogi. If the atomic UPDATE ... WHERE
 * status IN ('open','negotiating') guard is ever broken, two vendors could
 * both "win" the same job. That is unrecoverable in the real world.
 *
 * These tests fire N parallel confirmations and assert exactly one wins.
 *
 * Run: npm run test:race
 * Requires a live DATABASE_URL (use a staging DB, not production).
 */

import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { BookingService } from '../src/services/booking.service'

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
})

const booking = new BookingService()

// Test fixtures
let customerId: string
let vendorIds: string[] = []
let requestId: string
let responseIds: string[] = []

const PARALLEL = 10

beforeAll(async () => {
  // Create a test customer
  const cust = await db.query<{ id: string }>(
    `INSERT INTO users (phone, name, consent_given_at)
     VALUES ('+919999900000', 'Race Test Customer', now())
     ON CONFLICT (phone) DO UPDATE SET name = 'Race Test Customer'
     RETURNING id`
  )
  customerId = cust.rows[0].id

  // Create N test vendors
  for (let i = 0; i < PARALLEL; i++) {
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (phone, name, is_vendor, consent_given_at)
       VALUES ($1, $2, true, now())
       ON CONFLICT (phone) DO UPDATE SET is_vendor = true
       RETURNING id`,
      [`+91999990${String(i).padStart(4, '0')}`, `Race Vendor ${i}`]
    )
    const v = await db.query<{ id: string }>(
      `INSERT INTO vendors (user_id, raw_description, category_tags)
       VALUES ($1, 'Race test vendor', ARRAY['RaceTest'])
       RETURNING id`,
      [u.rows[0].id]
    )
    vendorIds.push(v.rows[0].id)
  }
})

afterAll(async () => {
  // Clean up — order matters for FK constraints
  await db.query(`DELETE FROM resource_bookings WHERE request_id IN (SELECT id FROM requests WHERE customer_id = $1)`, [customerId]).catch(() => {})
  await db.query(`DELETE FROM resource_slots WHERE resource_id IN (SELECT br.id FROM bookable_resources br JOIN organizations o ON o.id = br.organization_id WHERE o.vendor_id = ANY($1::uuid[]))`, [vendorIds]).catch(() => {})
  await db.query(`DELETE FROM bookable_resources WHERE organization_id IN (SELECT id FROM organizations WHERE vendor_id = ANY($1::uuid[]))`, [vendorIds]).catch(() => {})
  await db.query(`DELETE FROM organizations WHERE vendor_id = ANY($1::uuid[])`, [vendorIds]).catch(() => {})
  await db.query(`DELETE FROM request_responses WHERE request_id IN (SELECT id FROM requests WHERE customer_id = $1)`, [customerId])
  await db.query(`DELETE FROM requests WHERE customer_id = $1`, [customerId])
  await db.query(`DELETE FROM vendors WHERE id = ANY($1::uuid[])`, [vendorIds])
  // vendors.user_id FK: vendors must be deleted before users
  await db.query(`DELETE FROM users WHERE phone LIKE '+91999990%' OR phone = '+919999900000'`)
  await db.end()
})

beforeEach(async () => {
  // Fresh request for each test
  const r = await db.query<{ id: string }>(
    `INSERT INTO requests
       (customer_id, idempotency_key, raw_description, category_tags,
        booking_type, status, expires_at)
     VALUES ($1, $2, 'Race test request', ARRAY['RaceTest'],
             'quote', 'open', now() + interval '1 hour')
     RETURNING id`,
    [customerId, `race_${Date.now()}_${Math.random()}`]
  )
  requestId = r.rows[0].id

  // Each vendor submits a quote
  responseIds = []
  for (const vendorId of vendorIds) {
    const rr = await db.query<{ id: string }>(
      `INSERT INTO request_responses
         (request_id, vendor_id, status, quoted_price, responded_at)
       VALUES ($1, $2, 'quoted', 1000, now())
       RETURNING id`,
      [requestId, vendorId]
    )
    responseIds.push(rr.rows[0].id)
  }
})

describe('Booking race-lock', () => {
  it(`allows exactly one winner out of ${PARALLEL} parallel confirmations`, async () => {
    const results = await Promise.all(
      responseIds.map((responseId, i) =>
        booking.confirmQuote(requestId, responseId, 1000 + i, `key_${i}_${Date.now()}`)
      )
    )

    const winners = results.filter((r) => r.success)
    const losers = results.filter((r) => !r.success)

    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(PARALLEL - 1)
  })

  it('sets exactly one confirmed_vendor_id in the database', async () => {
    await Promise.all(
      responseIds.map((responseId, i) =>
        booking.confirmQuote(requestId, responseId, 1000, `k2_${i}_${Date.now()}`)
      )
    )

    const result = await db.query<{ confirmed_vendor_id: string; status: string }>(
      'SELECT confirmed_vendor_id, status FROM requests WHERE id = $1',
      [requestId]
    )

    expect(result.rows[0].status).toBe('confirmed')
    expect(result.rows[0].confirmed_vendor_id).toBeTruthy()
  })

  it('marks all non-winning responses as missed', async () => {
    await Promise.all(
      responseIds.map((responseId, i) =>
        booking.confirmQuote(requestId, responseId, 1000, `k3_${i}_${Date.now()}`)
      )
    )

    const counts = await db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count
       FROM request_responses
       WHERE request_id = $1
       GROUP BY status`,
      [requestId]
    )

    const byStatus = Object.fromEntries(
      counts.rows.map((r) => [r.status, parseInt(r.count)])
    )

    expect(byStatus.confirmed).toBe(1)
    expect(byStatus.missed).toBe(PARALLEL - 1)
  })

  it('is idempotent — retrying with the same key returns success', async () => {
    const key = `idem_${Date.now()}`

    const first = await booking.confirmQuote(requestId, responseIds[0], 1500, key)
    const retry = await booking.confirmQuote(requestId, responseIds[0], 1500, key)

    expect(first.success).toBe(true)
    expect(retry.success).toBe(true) // idempotent, not a 409

    // Still only one confirmation in the DB
    const result = await db.query<{ agreed_price: number }>(
      'SELECT agreed_price FROM requests WHERE id = $1',
      [requestId]
    )
    expect(result.rows[0].agreed_price).toBe(1500)
  })
})

describe('Slot booking race-lock', () => {
  let slotId: string
  let resourceId: string

  beforeEach(async () => {
    // Slots hang off a bookable_resource, not a vendor directly.
    // Reuse the vendor's implicit 'person' resource, creating it if the
    // migration-005 backfill did not (e.g. a vendor made inside this test).
    const resource = await db.query<{ id: string }>(
      `WITH org AS (
         INSERT INTO organizations (vendor_id, legal_name, display_name, org_type)
         VALUES ($1, 'Race Test Org', 'Race Test Org', 'individual')
         ON CONFLICT DO NOTHING
         RETURNING id
       ), existing_org AS (
         SELECT id FROM organizations WHERE vendor_id = $1 LIMIT 1
       )
       INSERT INTO bookable_resources (organization_id, resource_type, name)
       SELECT COALESCE(
         (SELECT id FROM org),
         (SELECT id FROM existing_org)
       ), 'person', 'Race Test Resource'
       RETURNING id`,
      [vendorIds[0]]
    )
    resourceId = resource.rows[0].id

    const slot = await db.query<{ id: string }>(
      `INSERT INTO resource_slots
         (resource_id, slot_time, capacity_total, capacity_booked)
       VALUES ($1, now() + interval '2 days', 1, 0)
       RETURNING id`,
      [resourceId]
    )
    slotId = slot.rows[0].id
  })

  it('allows exactly one booking for a capacity-1 slot', async () => {
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        booking.bookSlot(slotId, requestId, `slot_${i}_${Date.now()}`)
      )
    )

    const winners = results.filter((r) => r.success)
    expect(winners).toHaveLength(1)

    const slot = await db.query<{ capacity_booked: number }>(
      'SELECT capacity_booked FROM resource_slots WHERE id = $1',
      [slotId]
    )
    expect(slot.rows[0].capacity_booked).toBe(1)
  })

  it('respects capacity_total for multi-capacity slots', async () => {
    await db.query(
      'UPDATE resource_slots SET capacity_total = 3 WHERE id = $1',
      [slotId]
    )

    // Each parallel booking needs its own request — the state machine prevents
    // a single request from being confirmed twice, which is correct behaviour.
    // In production, 3 different customers would each submit their own request.
    const requestIds: string[] = []
    for (let i = 0; i < PARALLEL; i++) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO requests
           (customer_id, idempotency_key, raw_description, category_tags,
            booking_type, status, expires_at)
         VALUES ($1, $2, 'Multi-cap test', ARRAY['RaceTest'],
                 'appointment', 'open', now() + interval '1 hour')
         RETURNING id`,
        [customerId, `multicap_${i}_${Date.now()}_${Math.random()}`]
      )
      requestIds.push(r.rows[0].id)
    }

    const results = await Promise.all(
      requestIds.map((rid, i) =>
        booking.bookSlot(slotId, rid, `cap_${i}_${Date.now()}`)
      )
    )

    const winners = results.filter((r) => r.success)
    expect(winners).toHaveLength(3)

    const slot = await db.query<{ capacity_booked: number }>(
      'SELECT capacity_booked FROM resource_slots WHERE id = $1',
      [slotId]
    )
    expect(slot.rows[0].capacity_booked).toBe(3)
  })

  it('rejects booking a slot in the past', async () => {
    await db.query(
      `UPDATE resource_slots SET slot_time = now() - interval '1 hour' WHERE id = $1`,
      [slotId]
    )

    const result = await booking.bookSlot(slotId, requestId, `past_${Date.now()}`)
    expect(result.success).toBe(false)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // REGRESSION TEST — migration 010
  //
  // bookSlot() previously wrote reservation_slots and never set
  // requests.resource_slot_id. That FK is what appointment reminders,
  // no-show detection, reschedule, waitlist auto-offer and the travel
  // feasibility check all join on — so all five silently returned zero rows
  // for every appointment ever booked, with no error logged anywhere.
  //
  // If this test fails, those five features are dead again.
  // ═══════════════════════════════════════════════════════════════════════════
  it('links the booked slot to the request via resource_slot_id', async () => {
    const result = await booking.bookSlot(slotId, requestId, `link_${Date.now()}`)
    expect(result.success).toBe(true)

    const req = await db.query<{
      resource_slot_id: string | null
      status: string
    }>(
      'SELECT resource_slot_id, status FROM requests WHERE id = $1',
      [requestId]
    )

    expect(req.rows[0].status).toBe('confirmed')
    expect(
      req.rows[0].resource_slot_id,
      'resource_slot_id is NULL — reminders, no-show detection, reschedule, ' +
      'waitlist and travel checks are all silently broken. See migration 010.'
    ).toBe(slotId)
  })

  it('the downstream join that five features depend on returns a row', async () => {
    await booking.bookSlot(slotId, requestId, `join_${Date.now()}`)

    // This is the exact join shape used by booking-maintenance.worker,
    // reminder.worker, BookingLifecycleService and TravelService.
    const downstream = await db.query<{ slot_time: string }>(
      `SELECT rs.slot_time
       FROM requests r
       JOIN resource_slots rs ON rs.id = r.resource_slot_id
       WHERE r.id = $1`,
      [requestId]
    )

    expect(
      downstream.rows.length,
      'The requests → resource_slots join returned nothing. Every ' +
      'slot-dependent background job will no-op.'
    ).toBe(1)
  })

  it('rejects booking a cancelled slot', async () => {
    await db.query(
      'UPDATE resource_slots SET is_cancelled = true WHERE id = $1',
      [slotId]
    )

    const result = await booking.bookSlot(slotId, requestId, `cancel_${Date.now()}`)
    expect(result.success).toBe(false)
  })
})
