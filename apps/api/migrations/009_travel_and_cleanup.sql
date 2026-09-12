-- ─── Travel Feasibility + Dead Schema Removal ────────────────────────────────
--
-- Two unrelated things, deliberately in one migration because both are small
-- and both are about honesty:
--
--   1. A vendor can currently accept 2pm in Kondapur and 2:30pm in LB Nagar.
--      That is 25km apart. The system allows it, the vendor no-shows one of
--      them, and both parties blame us. This makes it impossible at the DB
--      level rather than "validated" in application code.
--
--   2. vendor_agent_rules and agent_decisions have existed since migration 001
--      and NOTHING has ever read or written them. Dead schema is worse than
--      missing schema — the next person to read this database will believe the
--      vendor automation agent exists. Dropping them. The design is recoverable
--      from git history when Phase 3 actually starts.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. VENDOR COMMITMENTS — one row per thing a vendor has agreed to be at
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Why a separate table instead of deriving from requests?
--
-- Because the reserved window is NOT the appointment window. A 2pm job in
-- Kondapur that takes 90 minutes, with 50 minutes of travel either side,
-- occupies 12:10 to 4:20. That is what must not overlap, and expressing it as
-- a materialised tstzrange lets Postgres enforce it with an EXCLUDE constraint.
--
-- Same guarantee as the rental exclusion constraint: two overlapping
-- commitments for one vendor are IMPOSSIBLE, not "prevented by a code path
-- someone might refactor away".
CREATE TABLE vendor_commitments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,

  -- What the customer sees
  service_from timestamptz NOT NULL,
  service_until timestamptz NOT NULL,

  -- What is actually blocked, including travel either side
  blocked_period tstzrange NOT NULL,

  -- Where, so the next commitment can be checked against it
  lat double precision,
  lng double precision,
  h3_r7 varchar(16),
  area_label varchar,

  -- The travel estimate that produced the buffer, kept for auditability.
  -- When a vendor disputes "why did you reject that job", this is the answer.
  travel_in_minutes integer,
  travel_out_minutes integer,
  estimate_method varchar
    CHECK (estimate_method IS NULL OR estimate_method IN
      ('h3_hex_distance', 'distance_matrix_api', 'vendor_declared', 'default')),

  status varchar DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'completed')),

  created_at timestamptz DEFAULT now(),

  CHECK (service_until > service_from),

  -- THE guarantee. Cancelled commitments are excluded so cancelling frees
  -- the window immediately.
  EXCLUDE USING gist (
    vendor_id WITH =,
    blocked_period WITH &&
  ) WHERE (status = 'active')
);

CREATE INDEX idx_commitments_vendor ON vendor_commitments (vendor_id)
  WHERE status = 'active';
CREATE INDEX idx_commitments_period ON vendor_commitments USING gist (blocked_period);
CREATE INDEX idx_commitments_request ON vendor_commitments (request_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. TRAVEL PROFILE — per vendor, because a bike is not a tempo
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS travel_mode varchar DEFAULT 'two_wheeler'
    CHECK (travel_mode IN ('walk', 'two_wheeler', 'car', 'tempo', 'public_transport')),
  -- Vendors who work at a fixed premises (salon, clinic) never travel
  ADD COLUMN IF NOT EXISTS is_fixed_premises boolean DEFAULT false,
  -- Minimum gap the vendor wants between jobs regardless of distance —
  -- setup, cleanup, a chai break. Their call, not ours.
  ADD COLUMN IF NOT EXISTS min_gap_minutes integer DEFAULT 15,
  -- How long their typical job runs, learned from completed jobs
  ADD COLUMN IF NOT EXISTS typical_duration_minutes integer;

-- Average city speeds by mode, in km/h. These are Hyderabad-realistic, not
-- textbook figures — 18 km/h for a car reflects actual traffic, not the
-- 40 km/h a routing API will optimistically return.
--
-- Stored as knowledge rather than constants so they can be corrected from
-- observed data without a deploy.
INSERT INTO agent_knowledge (domain, subject, key, value, source, confidence, reasoning)
VALUES
  ('travel_speed', 'walk', 'kmph', '4', 'bootstrap', 0.7,
   'Walking pace. Rarely relevant beyond 1km.'),
  ('travel_speed', 'two_wheeler', 'kmph', '22', 'bootstrap', 0.5,
   'Hyderabad two-wheeler average including traffic. Bikes filter through jams, ' ||
   'so faster than cars in practice.'),
  ('travel_speed', 'car', 'kmph', '18', 'bootstrap', 0.5,
   'Hyderabad car average in traffic. Deliberately pessimistic — an ' ||
   'optimistic estimate causes double-bookings, which is the failure we are ' ||
   'preventing.'),
  ('travel_speed', 'tempo', 'kmph', '15', 'bootstrap', 0.5,
   'Goods vehicles are slower and restricted on some roads.'),
  ('travel_speed', 'public_transport', 'kmph', '12', 'bootstrap', 0.4,
   'Bus and metro including waiting and walking legs.'),
  -- Hex distance underestimates road distance; roads wind.
  ('travel_model', 'global', 'road_winding_factor', '1.35', 'bootstrap', 0.4,
   'Multiplier converting straight-line hex distance to road distance. ' ||
   'Should be corrected from observed vendor arrival times.')
ON CONFLICT (domain, subject, key, source) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. TRAVEL REJECTION LOG — so this is explainable, not mysterious
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A vendor who gets told "you can't take this job" deserves to know why, and
-- we need to know whether our estimates are too conservative. If vendors keep
-- overriding rejections and arriving fine, the model is wrong.
CREATE TABLE travel_rejections (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id uuid REFERENCES vendors(id) ON DELETE CASCADE,
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,

  conflicting_commitment_id uuid REFERENCES vendor_commitments(id) ON DELETE SET NULL,

  estimated_travel_minutes integer,
  available_gap_minutes integer,
  hex_distance integer,
  estimated_km numeric,

  -- Did the vendor say we were wrong?
  vendor_overrode boolean DEFAULT false,
  override_reason text,
  -- If they overrode and then made it fine, our estimate was too pessimistic
  outcome varchar CHECK (outcome IS NULL OR outcome IN
    ('vendor_arrived_on_time', 'vendor_was_late', 'vendor_no_showed', 'unknown')),

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_travel_rejections_vendor ON travel_rejections (vendor_id);
CREATE INDEX idx_travel_rejections_override ON travel_rejections (vendor_overrode)
  WHERE vendor_overrode = true;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. OPS REVIEW QUEUE — makes the agentic layer's rot LOUD instead of silent
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The problem with learned knowledge is that nobody notices when it goes bad.
-- A dashboard does not solve this — dashboards are things you have to remember
-- to open. A queue with an age and an escalation does.
CREATE VIEW ops_review_queue AS
  -- Agent-proposed safety patterns, inert until approved
  SELECT
    'safety_pattern' AS queue,
    id::text AS item_id,
    label AS summary,
    proposed_reasoning AS detail,
    'critical' AS urgency,
    created_at,
    EXTRACT(EPOCH FROM (now() - created_at)) / 3600 AS age_hours
  FROM safety_patterns
  WHERE status = 'proposed'

  UNION ALL

  -- Beliefs the agent lost confidence in
  SELECT
    'knowledge_review' AS queue,
    id::text,
    domain || ' / ' || subject || ' / ' || key,
    reasoning,
    CASE WHEN applied_count > 10 THEN 'high' ELSE 'normal' END,
    updated_at,
    EXTRACT(EPOCH FROM (now() - updated_at)) / 3600
  FROM agent_knowledge
  WHERE status = 'needs_review'

  UNION ALL

  -- Agent-proposed scope boundaries awaiting promotion
  SELECT
    'scope_boundary' AS queue,
    slug,
    label,
    canonical_description,
    'normal',
    created_at,
    EXTRACT(EPOCH FROM (now() - created_at)) / 3600
  FROM out_of_scope_categories
  WHERE status = 'testing' AND source = 'agent'

  UNION ALL

  -- Geography users type that we cannot resolve
  SELECT
    'unresolved_geo' AS queue,
    id::text,
    query_original,
    failure_reason,
    CASE WHEN hit_count > 5 THEN 'high' ELSE 'low' END,
    last_hit_at,
    EXTRACT(EPOCH FROM (now() - last_hit_at)) / 3600
  FROM geo_cache
  WHERE resolution_failed = true AND hit_count > 2

  UNION ALL

  -- Near-duplicate categories the taxonomy worker flagged
  SELECT
    'duplicate_category' AS queue,
    id::text,
    (metadata->'categoryA'->>'name') || ' ≈ ' || (metadata->'categoryB'->>'name'),
    'similarity ' || (metadata->>'similarity'),
    'normal',
    created_at,
    EXTRACT(EPOCH FROM (now() - created_at)) / 3600
  FROM events
  WHERE event_type = 'taxonomy_duplicate_detected'
    AND created_at > now() - interval '30 days'

  UNION ALL

  -- Travel rejections a vendor overrode — evidence the model is wrong
  SELECT
    'travel_model_dispute' AS queue,
    id::text,
    'Vendor overrode a travel rejection',
    override_reason,
    'normal',
    created_at,
    EXTRACT(EPOCH FROM (now() - created_at)) / 3600
  FROM travel_rejections
  WHERE vendor_overrode = true AND outcome IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. DROP THE DEAD AUTOMATION SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- vendor_agent_rules and agent_decisions were created in migration 001 for a
-- vendor automation agent that was never built. Nothing reads them. Nothing
-- writes them. They have been sitting there looking like a shipped feature.
--
-- Dropping rather than keeping, because:
--   • Dead schema misleads whoever reads this database next
--   • The automation premise is "manual response is a bottleneck", which is
--     false at zero request volume — building it now means guessing at rules
--     no vendor has asked for
--   • The design is fully recoverable from git history (migration 001) when
--     there is enough volume to justify it
--
-- Bring these back when: a vendor with 20+ requests/week asks for it.
DROP TABLE IF EXISTS agent_decisions;
DROP TABLE IF EXISTS vendor_agent_rules;

-- Leave a marker so the next reader knows this was deliberate, not lost
COMMENT ON TABLE vendor_commitments IS
  'Travel-aware scheduling. Note: vendor_agent_rules and agent_decisions were '
  'dropped in migration 009 as unbuilt dead schema — see that migration for '
  'the reasoning and the conditions for reviving them.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. BACKFILL COMMITMENTS FROM EXISTING CONFIRMED BOOKINGS
-- ═══════════════════════════════════════════════════════════════════════════
-- Uses a default 30-minute buffer since we have no travel estimate for
-- historical rows. Marked estimate_method='default' so it is distinguishable
-- from a real calculation.
INSERT INTO vendor_commitments
  (vendor_id, request_id, service_from, service_until, blocked_period,
   lat, lng, h3_r7, travel_in_minutes, travel_out_minutes, estimate_method)
SELECT
  r.confirmed_vendor_id,
  r.id,
  COALESCE(rs.slot_time, r.expires_at),
  COALESCE(rs.slot_time, r.expires_at) +
    (COALESCE(rs.duration_minutes, 60) || ' minutes')::interval,
  tstzrange(
    COALESCE(rs.slot_time, r.expires_at) - interval '30 minutes',
    COALESCE(rs.slot_time, r.expires_at) +
      (COALESCE(rs.duration_minutes, 60) || ' minutes')::interval + interval '30 minutes'
  ),
  r.lat, r.lng, r.h3_r7,
  30, 30, 'default'
FROM requests r
LEFT JOIN resource_slots rs ON rs.id = r.resource_slot_id
WHERE r.confirmed_vendor_id IS NOT NULL
  AND r.status IN ('confirmed', 'in_progress')
  AND COALESCE(rs.slot_time, r.expires_at) IS NOT NULL
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. OPS REVIEWER FLAG
-- ═══════════════════════════════════════════════════════════════════════════
-- The digest worker needs someone to notify. If nobody has this flag set, the
-- worker logs an error saying so — because "nobody is watching the agentic
-- layer" is itself the most important thing to surface.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_ops_reviewer boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_ops_reviewer ON users (is_ops_reviewer)
  WHERE is_ops_reviewer = true;
