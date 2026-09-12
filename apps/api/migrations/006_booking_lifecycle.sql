-- ─── Booking Lifecycle Completion ────────────────────────────────────────────
--
-- Fixes three live bugs and adds four flows that are impossible today.
--
-- BUGS:
--   1. Slot exhaustion — generateSlots() writes 4 weeks ahead and nothing
--      regenerates. Every restaurant and doctor silently hits zero slots
--      after a month. Fixed by slot_schedules + a rolling worker.
--   2. Vendor cancellation orphans bookings — cancelling a slot didn't
--      cascade to the customers holding it.
--   3. `no_show` was a declared enum value that no code ever set.
--
-- NEW FLOWS:
--   4. Reschedule (atomic slot swap, with an audit trail)
--   5. Waitlist with auto-promotion when a slot frees up
--   6. Recurring bookings — the maid/cook/tiffin segment, which is a large
--      part of the Indian market and currently needs a manual request daily
--   7. Booking on behalf of someone else (son books for mother)

-- ─── 1. Slot schedules — the recurrence RULE, not the instances ──────────────
-- Instead of generating slots once and hoping, store the rule and let a worker
-- keep a rolling window populated.
CREATE TABLE slot_schedules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_id uuid REFERENCES bookable_resources(id) ON DELETE CASCADE,

  days_of_week integer[] NOT NULL,        -- [1,2,3,4,5,6] = Mon–Sat
  start_time time NOT NULL,
  end_time time NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 30,
  capacity_per_slot integer NOT NULL DEFAULT 1,

  -- Rolling window: keep this many days of slots materialised ahead
  horizon_days integer NOT NULL DEFAULT 28,

  -- Blackout dates (festivals, leave, maintenance)
  blackout_dates date[],

  is_active boolean DEFAULT true,
  last_generated_until date,              -- worker watermark

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_slot_schedules_active ON slot_schedules (resource_id)
  WHERE is_active = true;
CREATE INDEX idx_slot_schedules_watermark ON slot_schedules (last_generated_until)
  WHERE is_active = true;

-- ─── 2. Reschedule audit trail ───────────────────────────────────────────────
CREATE TABLE booking_reschedules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,

  from_slot_id uuid REFERENCES resource_slots(id),
  to_slot_id uuid REFERENCES resource_slots(id),
  from_slot_time timestamptz NOT NULL,
  to_slot_time timestamptz NOT NULL,

  initiated_by varchar NOT NULL CHECK (initiated_by IN ('customer','vendor','system')),
  initiated_by_user uuid REFERENCES users(id),
  reason text,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_reschedules_request ON booking_reschedules (request_id);

-- Cap reschedules so a booking can't be moved indefinitely
ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS reschedule_count integer DEFAULT 0;

-- ─── 3. No-show tracking + reliability ───────────────────────────────────────
CREATE TABLE no_shows (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,

  party varchar NOT NULL CHECK (party IN ('customer','vendor')),
  user_id uuid REFERENCES users(id),
  vendor_id uuid REFERENCES vendors(id),

  -- How we concluded it was a no-show
  detection varchar NOT NULL
    CHECK (detection IN ('reported_by_other','auto_timeout','both_confirmed')),
  reported_by uuid REFERENCES users(id),

  -- The other side can dispute it
  is_disputed boolean DEFAULT false,
  dispute_note text,
  resolved_by uuid REFERENCES users(id),
  resolution varchar CHECK (resolution IS NULL OR resolution IN ('upheld','overturned')),

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_noshows_user ON no_shows (user_id) WHERE resolution IS DISTINCT FROM 'overturned';
CREATE INDEX idx_noshows_vendor ON no_shows (vendor_id) WHERE resolution IS DISTINCT FROM 'overturned';

-- Reliability scores. Deliberately separate from `rating` — a vendor can do
-- excellent work (5 stars) and still be unreliable about showing up.
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS no_show_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reliability_score numeric DEFAULT 100.0,
  ADD COLUMN IF NOT EXISTS late_cancellation_count integer DEFAULT 0;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS no_show_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reliability_score numeric DEFAULT 100.0,
  -- Repeat no-show customers get restricted rather than banned outright
  ADD COLUMN IF NOT EXISTS booking_restricted_until timestamptz;

-- ─── 4. Waitlist ─────────────────────────────────────────────────────────────
CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,
  resource_id uuid REFERENCES bookable_resources(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES users(id) ON DELETE CASCADE,

  -- What they'd accept
  desired_date date NOT NULL,
  desired_time_from time,
  desired_time_until time,
  party_size integer,
  flexible_on_date boolean DEFAULT false,

  position integer,                       -- queue order for this resource+date
  status varchar DEFAULT 'waiting'
    CHECK (status IN ('waiting','offered','claimed','expired','cancelled')),

  -- When a slot frees, we offer it and hold it briefly
  offered_slot_id uuid REFERENCES resource_slots(id),
  offered_at timestamptz,
  offer_expires_at timestamptz,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_waitlist_lookup
  ON waitlist_entries (resource_id, desired_date, position)
  WHERE status = 'waiting';
CREATE INDEX idx_waitlist_offers ON waitlist_entries (offer_expires_at)
  WHERE status = 'offered';

-- ─── 5. Recurring bookings (maid, cook, tiffin, physio course) ───────────────
CREATE TABLE recurring_bookings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id uuid REFERENCES users(id) ON DELETE CASCADE,
  vendor_id uuid REFERENCES vendors(id),
  resource_id uuid REFERENCES bookable_resources(id),
  category_id uuid REFERENCES service_categories(id),

  raw_description text NOT NULL,
  attributes jsonb,

  -- Recurrence
  frequency varchar NOT NULL
    CHECK (frequency IN ('daily','weekdays','weekly','biweekly','monthly','custom')),
  days_of_week integer[],                 -- for weekly/custom
  time_of_day time NOT NULL,
  duration_minutes integer DEFAULT 60,

  -- Term
  starts_on date NOT NULL,
  ends_on date,                           -- null = open-ended
  total_occurrences integer,              -- e.g. a 12-session physio course
  completed_occurrences integer DEFAULT 0,

  -- Pricing
  price_per_occurrence integer,
  billing varchar DEFAULT 'per_occurrence'
    CHECK (billing IN ('per_occurrence','monthly','upfront')),

  status varchar DEFAULT 'active'
    CHECK (status IN ('pending_vendor','active','paused','completed','cancelled')),
  pause_from date,
  pause_until date,

  -- Watermark so the worker knows how far it has materialised
  last_materialized_until date,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_recurring_active ON recurring_bookings (status, last_materialized_until)
  WHERE status = 'active';
CREATE INDEX idx_recurring_customer ON recurring_bookings (customer_id);
CREATE INDEX idx_recurring_vendor ON recurring_bookings (vendor_id);

-- Each generated occurrence links back to its parent series
ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS recurring_booking_id uuid REFERENCES recurring_bookings(id),
  ADD COLUMN IF NOT EXISTS occurrence_number integer;

CREATE INDEX idx_requests_recurring ON requests (recurring_booking_id)
  WHERE recurring_booking_id IS NOT NULL;

-- ─── 6. Booking on behalf of someone else ────────────────────────────────────
-- Very common: a son books a doctor for his mother, a manager books for staff.
-- The beneficiary is not necessarily an app user.
CREATE TABLE booking_beneficiaries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,

  name varchar NOT NULL,
  relationship varchar,                   -- 'mother', 'child', 'employee'
  phone varchar,                          -- so the vendor can reach them directly
  age integer,
  gender varchar,

  -- Whoever books is responsible for consent on the beneficiary's behalf
  consent_confirmed_by uuid REFERENCES users(id),
  consent_confirmed_at timestamptz DEFAULT now(),

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_beneficiaries_request ON booking_beneficiaries (request_id);

-- ─── 7. Cancellation policy per category ─────────────────────────────────────
-- Cancelling a table 3 hours out is very different from cancelling a
-- photographer the morning of a wedding.
CREATE TABLE cancellation_policies (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id uuid REFERENCES service_categories(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,

  -- Free cancellation window
  free_cancellation_hours integer DEFAULT 24,
  -- Beyond that, a percentage applies (informational until payments go live)
  late_cancellation_fee_percent integer DEFAULT 0,
  no_show_fee_percent integer DEFAULT 0,

  max_reschedules integer DEFAULT 2,
  reschedule_notice_hours integer DEFAULT 4,

  policy_text text,                       -- shown to the customer

  created_at timestamptz DEFAULT now(),
  CHECK (category_id IS NOT NULL OR organization_id IS NOT NULL)
);

CREATE INDEX idx_policies_category ON cancellation_policies (category_id);
CREATE INDEX idx_policies_org ON cancellation_policies (organization_id);

-- Sensible defaults per category type
INSERT INTO cancellation_policies
  (category_id, free_cancellation_hours, late_cancellation_fee_percent,
   no_show_fee_percent, max_reschedules, policy_text)
SELECT id,
  CASE
    WHEN slug LIKE 'restaurant%' THEN 3
    WHEN slug IN ('doctor-consultation','dental-care','diagnostic-lab','physiotherapy') THEN 4
    WHEN slug LIKE 'salon%' OR slug LIKE 'beauty%' OR slug LIKE 'massage%' THEN 6
    WHEN slug LIKE '%photography' OR slug LIKE '%videography' THEN 72
    WHEN slug LIKE 'auto%' OR slug LIKE 'bike%' OR slug LIKE 'cab%' THEN 0
    ELSE 24
  END,
  CASE
    WHEN slug LIKE '%photography' OR slug LIKE '%videography' THEN 25
    WHEN slug LIKE 'restaurant%' THEN 0
    ELSE 0
  END,
  CASE
    WHEN slug LIKE 'restaurant%' THEN 0
    WHEN slug LIKE '%photography' THEN 50
    ELSE 0
  END,
  CASE WHEN slug LIKE 'auto%' OR slug LIKE 'bike%' THEN 0 ELSE 2 END,
  CASE
    WHEN slug LIKE 'restaurant%' THEN
      'Free cancellation up to 3 hours before. Repeated no-shows may limit future bookings.'
    WHEN slug IN ('doctor-consultation','dental-care') THEN
      'Free cancellation up to 4 hours before, so the slot can go to another patient.'
    WHEN slug LIKE '%photography' THEN
      'Free cancellation up to 3 days before. Later cancellations may incur a fee once payments are enabled.'
    ELSE 'Free cancellation up to 24 hours before.'
  END
FROM service_categories
WHERE is_verified = true
ON CONFLICT DO NOTHING;

-- ─── 8. Vendor-initiated disruption tracking ─────────────────────────────────
-- When a doctor cancels OPD or a restaurant closes, every affected booking
-- needs to be found, notified, and offered an alternative.
CREATE TABLE booking_disruptions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  resource_id uuid REFERENCES bookable_resources(id) ON DELETE CASCADE,

  disruption_type varchar NOT NULL
    CHECK (disruption_type IN ('resource_unavailable','org_closed','slot_cancelled')),
  affects_from timestamptz NOT NULL,
  affects_until timestamptz NOT NULL,
  reason text,

  affected_booking_count integer DEFAULT 0,
  notified_count integer DEFAULT 0,
  rebooked_count integer DEFAULT 0,

  created_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_disruptions_org ON booking_disruptions (organization_id);

-- ─── Extend request status for the new lifecycle states ─────────────────────
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
  CHECK (status IN (
    'open','negotiating','confirmed','in_progress','completed',
    'expired','cancelled','no_match',
    -- new
    'rescheduled',           -- moved; a successor request holds the new slot
    'no_show_customer',      -- customer didn't turn up
    'no_show_vendor',        -- vendor didn't turn up
    'disrupted',             -- vendor cancelled; awaiting customer decision
    'waitlisted'             -- no slot yet, queued
  ));

-- ─── Backfill slot_schedules from existing materialised slots ───────────────
-- Infers the rule from what's already there so nothing regresses.
INSERT INTO slot_schedules
  (resource_id, days_of_week, start_time, end_time,
   duration_minutes, capacity_per_slot, last_generated_until)
SELECT
  rs.resource_id,
  ARRAY_AGG(DISTINCT EXTRACT(DOW FROM rs.slot_time AT TIME ZONE 'Asia/Kolkata')::integer),
  MIN((rs.slot_time AT TIME ZONE 'Asia/Kolkata')::time),
  MAX((rs.slot_time AT TIME ZONE 'Asia/Kolkata')::time),
  MODE() WITHIN GROUP (ORDER BY rs.duration_minutes),
  MODE() WITHIN GROUP (ORDER BY rs.capacity_total),
  MAX(rs.slot_time::date)
FROM resource_slots rs
WHERE rs.is_cancelled = false
GROUP BY rs.resource_id
HAVING COUNT(*) >= 3
ON CONFLICT DO NOTHING;
