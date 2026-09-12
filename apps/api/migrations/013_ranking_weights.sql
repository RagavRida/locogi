-- ═══════════════════════════════════════════════════════════════════════════
-- Configurable vendor ranking weights
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Matching previously ordered by embedding similarity with rating as a
-- tie-break. The weighted ranker in src/domain/vendor-ranking.ts adds
-- distance, load, reliability and response behaviour — and the balance
-- between those is a product decision that will need tuning against real
-- traffic, repeatedly, before it is right.
--
-- Tuning that requires a deploy will not happen often enough. So the weights
-- live here.
--
-- The application ships with DEFAULT_WEIGHTS as a code-level fallback, used
-- when this table is empty or unreachable. That matters: a ranking that fails
-- closed to "no ranking at all" would silently return vendors in whatever
-- order Postgres felt like.

CREATE TABLE ranking_weights (
  -- One active row per named profile. A profile lets different verticals rank
  -- differently later (rides care about distance far more than a wedding
  -- photographer does) without another schema change.
  profile varchar(40) PRIMARY KEY,

  semantic        numeric NOT NULL DEFAULT 0.30 CHECK (semantic        BETWEEN 0 AND 1),
  distance        numeric NOT NULL DEFAULT 0.25 CHECK (distance        BETWEEN 0 AND 1),
  availability    numeric NOT NULL DEFAULT 0.15 CHECK (availability    BETWEEN 0 AND 1),
  rating          numeric NOT NULL DEFAULT 0.10 CHECK (rating          BETWEEN 0 AND 1),
  response_rate   numeric NOT NULL DEFAULT 0.10 CHECK (response_rate   BETWEEN 0 AND 1),
  completion_rate numeric NOT NULL DEFAULT 0.10 CHECK (completion_rate BETWEEN 0 AND 1),
  price           numeric NOT NULL DEFAULT 0.00 CHECK (price           BETWEEN 0 AND 1),

  -- Distance at which the distance score halves. Smaller punishes travel
  -- harder; 3km suits dense Hyderabad neighbourhoods.
  distance_half_life_km numeric NOT NULL DEFAULT 3.0
    CHECK (distance_half_life_km > 0),

  -- Overlapping commitments at which a vendor counts as fully booked.
  capacity_per_window integer NOT NULL DEFAULT 4
    CHECK (capacity_per_window > 0),

  -- Why this profile is tuned the way it is. Future-you will want to know
  -- whether a weight was measured or guessed.
  notes text,

  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ranking_weights IS
  'Tunable vendor ranking weights. Weights need NOT sum to 1 — the ranker '
  'renormalises over whichever signals are actually present for each vendor, '
  'so a missing signal is excluded rather than scored zero.';

COMMENT ON COLUMN ranking_weights.price IS
  'Defaults to 0. Most verticals here have no price before a quote exists, '
  'and ranking local services by price alone selects for corner-cutting. '
  'Raise it deliberately, per profile.';

-- The profile every request uses until per-vertical tuning is introduced.
INSERT INTO ranking_weights (profile, notes) VALUES (
  'default',
  'Initial weights are a considered guess, NOT a measurement — no traffic has '
  'been ranked yet. Semantic stays largest because it is the only signal that '
  'speaks to whether the vendor can do the job at all; the rest decide who is '
  'the better choice among those who can. Revisit once real match outcomes '
  'exist.'
);

-- ─── Response rate, which the vendors column never carried ──────────────────
--
-- `vendors.response_rate` has existed since migration 001 and NOTHING has
-- ever written to it — it is 0 for every vendor in the system. Ranking on it
-- would add a factor that looks meaningful and contributes nothing.
--
-- The data to compute it does exist, in request_responses. This view derives
-- it, so the ranker reads something true.
CREATE OR REPLACE VIEW vendor_response_stats AS
  SELECT
    rr.vendor_id,
    COUNT(*) AS notified_count,
    COUNT(*) FILTER (
      WHERE rr.status IN ('quoted', 'counter', 'declined', 'applied')
    ) AS answered_count,
    -- Declining IS a response: it frees the customer to look elsewhere
    -- quickly, which is far better behaviour than silence. Only 'pending'
    -- and 'missed' count against a vendor.
    ROUND(
      COUNT(*) FILTER (
        WHERE rr.status IN ('quoted', 'counter', 'declined', 'applied')
      )::numeric / NULLIF(COUNT(*), 0),
      4
    ) AS response_rate
  FROM request_responses rr
  GROUP BY rr.vendor_id;

COMMENT ON VIEW vendor_response_stats IS
  'Derived response behaviour. Replaces vendors.response_rate, which is dead '
  'schema — never written since migration 001.';

CREATE INDEX IF NOT EXISTS idx_request_responses_vendor_status
  ON request_responses (vendor_id, status);
