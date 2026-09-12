-- ═══════════════════════════════════════════════════════════════════════════
-- Provider tracking phase
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adds EN_ROUTE and ARRIVED, which the tracking card had no way to express —
-- it could only say "on the way" or "not sharing", with nothing in between.
--
-- ── Why these are NOT request states ────────────────────────────────────────
--
-- The obvious move is to add them to `requests.status`, next to confirmed and
-- in_progress. That would be a mistake, for three reasons:
--
--  1. The request state machine has 13 states, a GENERATED migration (011)
--     and a database trigger enforcing 27 legal transitions. Every new state
--     multiplies the edges through the most safety-critical part of the
--     schema.
--
--  2. A booking is `confirmed` for the entire time this value is changing.
--     The phase is not a different booking state; it is a detail OF the
--     confirmed state.
--
--  3. Request states are durable facts — a completed booking is completed
--     forever. A tracking phase is a claim a phone made ninety seconds ago,
--     and it expires. Storing something that decays alongside things that do
--     not is how a state machine starts lying.
--
-- So the phase lives on `live_locations`, beside the coordinates it belongs
-- with, and goes stale on exactly the same schedule.

ALTER TABLE live_locations
  ADD COLUMN IF NOT EXISTS phase varchar(20) NOT NULL DEFAULT 'not_started'
    CHECK (phase IN ('not_started', 'en_route', 'arrived', 'in_progress', 'finished')),
  -- Separate from updated_at: a provider who arrives and then stops moving
  -- still has a fresh location, but we want to know how long they have been
  -- standing at the door.
  ADD COLUMN IF NOT EXISTS phase_changed_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN live_locations.phase IS
  'Where the provider is in their journey. NOT a request status — the booking '
  'stays `confirmed` throughout. Expires with the location row: a phase from '
  'forty minutes ago is not a phase.';

-- Reading "the current phase for this booking" is the tracking hot path.
CREATE INDEX IF NOT EXISTS idx_live_locations_request_phase
  ON live_locations (request_id, updated_at DESC)
  WHERE request_id IS NOT NULL;

-- ─── Phase history ──────────────────────────────────────────────────────────
--
-- `live_locations` is one mutable row per user, so a phase change overwrites
-- the previous one and the sequence is lost. That sequence is what answers
-- "the provider says they arrived at 5pm, the customer says nobody came" —
-- which is a dispute, and disputes need evidence.
--
-- Append-only, and deliberately NOT joined into the hot read path.
CREATE TABLE tracking_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  vendor_user_id uuid NOT NULL REFERENCES users(id),

  phase varchar(20) NOT NULL
    CHECK (phase IN ('not_started', 'en_route', 'arrived', 'in_progress', 'finished')),

  -- Where they were when they claimed it. Nullable: a provider can mark
  -- themselves arrived with location permission switched off, and refusing
  -- the update would just mean no record at all.
  lat double precision,
  lng double precision,

  -- Straight-line metres from the job at the moment of the claim. Lets an
  -- ops reviewer see that "arrived" was pressed from 4km away.
  distance_from_job_m integer,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tracking_events IS
  'Append-only phase history. live_locations holds only the CURRENT phase; '
  'this is the record that survives to settle a no-show dispute.';

CREATE INDEX idx_tracking_events_request
  ON tracking_events (request_id, created_at DESC);
