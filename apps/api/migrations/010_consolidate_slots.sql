-- ─── Consolidate Slot Tables ─────────────────────────────────────────────────
--
-- THE BUG
-- ───────
-- Two slot tables have coexisted since migration 005:
--
--   reservation_slots  (001) — vendor-level, keyed by vendor_id
--   resource_slots     (005) — resource-level, keyed by bookable_resources.id
--
-- Migration 005's own comment says resource_slots "replaces vendor-level
-- reservation_slots". That replacement was never finished. The result:
--
--   BookingService.bookSlot()      → writes reservation_slots
--   GET /vendors/:id/slots         → reads  reservation_slots
--   requests.resource_slot_id      → FK to  resource_slots  (stays NULL)
--
--   BookingLifecycleService        → reads  resource_slots
--   booking-maintenance.worker     → reads  resource_slots
--   reminder.worker                → reads  resource_slots
--   TravelService                  → reads  resource_slots
--
-- Because bookSlot never populated requests.resource_slot_id, every feature
-- that joins on it returned zero rows. Silently. No error anywhere:
--
--   • appointment reminders        never sent
--   • no-show detection            never fired
--   • reschedule                   released a NULL slot
--   • waitlist auto-offer          never triggered
--   • travel feasibility check     never ran for appointments
--
-- WHY resource_slots WINS
-- ───────────────────────
-- It is the richer model (price_override, per-resource granularity) and is
-- already the target of the requests FK plus six downstream consumers.
-- Keeping reservation_slots would mean rewriting more code, not less.
--
-- MIGRATION STRATEGY
-- ──────────────────
-- Every vendor already has an implicit 'person' bookable_resource created by
-- migration 005's backfill. We map each reservation_slots row onto that
-- resource, then drop the old table.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. SAFETY CHECK — every vendor with slots must have a bookable resource
-- ═══════════════════════════════════════════════════════════════════════════
-- If migration 005's backfill missed anyone, create the missing resource now
-- rather than silently dropping their slots.
INSERT INTO bookable_resources (organization_id, resource_type, name)
SELECT DISTINCT o.id, 'person', COALESCE(o.display_name, 'Vendor')
FROM reservation_slots rs
JOIN vendors v ON v.id = rs.vendor_id
JOIN organizations o ON o.vendor_id = v.id
WHERE NOT EXISTS (
  SELECT 1 FROM bookable_resources br WHERE br.organization_id = o.id
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. BACKFILL reservation_slots → resource_slots
-- ═══════════════════════════════════════════════════════════════════════════
-- Maps each vendor-level slot onto that vendor's primary bookable resource.
-- ON CONFLICT handles the case where a slot at the same time already exists
-- on the resource — we keep the resource_slots row (newer model wins) but
-- take the higher capacity_booked so no existing booking is lost.
INSERT INTO resource_slots
  (resource_id, slot_time, duration_minutes, capacity_total, capacity_booked,
   is_cancelled, cancelled_at, cancel_reason)
SELECT
  br.id,
  rs.slot_time,
  rs.duration_minutes,
  rs.capacity_total,
  rs.capacity_booked,
  rs.is_cancelled,
  rs.cancelled_at,
  rs.cancel_reason
FROM reservation_slots rs
JOIN vendors v ON v.id = rs.vendor_id
JOIN organizations o ON o.vendor_id = v.id
JOIN LATERAL (
  SELECT id FROM bookable_resources
  WHERE organization_id = o.id AND is_active = true
  ORDER BY display_order, created_at
  LIMIT 1
) br ON true
ON CONFLICT (resource_id, slot_time) DO UPDATE
  SET capacity_booked = GREATEST(
        resource_slots.capacity_booked,
        EXCLUDED.capacity_booked
      );

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. REPAIR ORPHANED requests.resource_slot_id
-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmed appointment bookings made through the old path have a NULL FK.
-- Reconnect them to the corresponding resource_slots row so reminders,
-- no-show detection, reschedule and travel checks start working for them.
UPDATE requests r
SET resource_slot_id = matched.slot_id
FROM (
  SELECT DISTINCT ON (req.id)
    req.id AS request_id,
    nrs.id AS slot_id
  FROM requests req
  JOIN vendors v ON v.id = req.confirmed_vendor_id
  JOIN organizations o ON o.vendor_id = v.id
  JOIN bookable_resources br ON br.organization_id = o.id
  JOIN resource_slots nrs ON nrs.resource_id = br.id
  WHERE req.resource_slot_id IS NULL
    AND req.booking_type = 'appointment'
    AND req.status IN ('confirmed', 'in_progress')
    AND req.expires_at IS NOT NULL
    -- Match on the appointment time we recorded in expires_at
    AND nrs.slot_time = req.expires_at
  ORDER BY req.id, nrs.created_at
) matched
WHERE r.id = matched.request_id;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. DROP THE OLD TABLE
-- ═══════════════════════════════════════════════════════════════════════════
-- Deliberate, not deferred. Leaving it means a future developer wires new code
-- to the wrong table and reintroduces exactly this bug. There is one slot
-- table now, and the type system will enforce it.
DROP TABLE IF EXISTS reservation_slots;

COMMENT ON TABLE resource_slots IS
  'The single slot table. reservation_slots was dropped in migration 010 after '
  'a split-brain bug where bookings wrote one table while reminders, no-show '
  'detection, reschedule, waitlist and travel checks all read the other. '
  'Do not reintroduce a vendor-level slot table — slots belong to a '
  'bookable_resource (a table, a doctor, a stylist, or the vendor themselves).';
