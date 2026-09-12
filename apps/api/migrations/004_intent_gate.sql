-- ─── Intent Gate ─────────────────────────────────────────────────────────────
--
-- Problem: not every message is a service request. "Find me a library near me
-- and help me make friends" is two non-service intents. Without a gate, the
-- taxonomy auto-creates junk categories ("Library", "Social Networking") that
-- no vendor will ever join, and the user hits a dead end.
--
-- Solution: classify intent BEFORE touching the taxonomy. Only
-- 'service_request' is allowed to create categories. Everything else is
-- either answered directly, redirected, or honestly declined — and logged
-- as unmet demand, which is genuinely valuable product data.

-- ─── Add intent to requests ───────────────────────────────────────────────────
ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS intent varchar DEFAULT 'service_request'
    CHECK (intent IN (
      'service_request',   -- someone to hire → vendor matching
      'place_discovery',   -- "library near me" → POI lookup, no vendor
      'social_community',  -- "make friends" → out of scope
      'information',       -- "how does this work" → answer directly
      'unsupported'        -- anything else
    )),
  ADD COLUMN IF NOT EXISTS intent_confidence numeric,
  ADD COLUMN IF NOT EXISTS intent_reasoning text;

-- Existing rows are all service requests by definition
UPDATE requests SET intent = 'service_request' WHERE intent IS NULL;

-- ─── Unmet demand log ─────────────────────────────────────────────────────────
-- Every non-service request lands here. If 200 people ask for "gym buddy",
-- that is a real product signal — maybe worth building. This table is the
-- highest-signal input to your roadmap.
CREATE TABLE unmet_demand (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES users(id),
  raw_text text NOT NULL,
  intent varchar NOT NULL,
  extracted_topic varchar,          -- 'library', 'friends', 'gym buddy'
  embedding vector(1536),           -- clusters similar unmet asks together
  lat double precision,
  lng double precision,
  h3_r7 varchar(16),                -- where this demand is coming from
  agent_response text,              -- what we told them
  was_resolved boolean DEFAULT false,  -- did we answer it usefully?
  resolution_type varchar
    CHECK (resolution_type IS NULL OR resolution_type IN (
      'answered_directly',   -- we gave them a real answer (POI lookup)
      'redirected',          -- pointed them somewhere useful
      'declined',            -- honestly said we can't help
      'converted'            -- turned into a real service request
    )),
  cluster_id uuid,                  -- assigned by the clustering worker
  created_at timestamptz DEFAULT now()
);

CREATE INDEX ON unmet_demand USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX idx_unmet_intent ON unmet_demand (intent, created_at DESC);
CREATE INDEX idx_unmet_topic ON unmet_demand (extracted_topic);
CREATE INDEX idx_unmet_cluster ON unmet_demand (cluster_id)
  WHERE cluster_id IS NOT NULL;

-- ─── Demand clusters ─────────────────────────────────────────────────────────
-- The clustering worker groups semantically similar unmet asks. When a cluster
-- crosses a threshold, it surfaces as a candidate new vertical.
CREATE TABLE demand_clusters (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  label varchar NOT NULL,            -- 'Study spaces & libraries'
  centroid vector(1536),
  intent varchar NOT NULL,
  request_count integer DEFAULT 1,
  unique_user_count integer DEFAULT 1,
  first_seen timestamptz DEFAULT now(),
  last_seen timestamptz DEFAULT now(),
  -- Product decision tracking
  status varchar DEFAULT 'observing'
    CHECK (status IN ('observing', 'candidate', 'building', 'launched', 'rejected')),
  decision_note text,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX ON demand_clusters USING hnsw (centroid vector_cosine_ops)
  WHERE centroid IS NOT NULL;
CREATE INDEX idx_clusters_status ON demand_clusters (status, request_count DESC);

-- ─── Places (curated POI directory) ──────────────────────────────────────────
-- For place_discovery intent. These are NOT vendors — nobody gets hired, no
-- money changes hands. Just useful local knowledge so the agent can answer
-- "library near me" instead of dead-ending.
CREATE TABLE places (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name varchar NOT NULL,
  place_type varchar NOT NULL,       -- 'library', 'park', 'cafe', 'co-working'
  address text,
  area varchar,                      -- 'Madhapur', 'Kondapur'
  lat double precision,
  lng double precision,
  h3_r8 varchar(16),
  h3_r7 varchar(16),
  phone varchar,
  website varchar,
  opening_hours jsonb,               -- { mon: "9:00-20:00", ... }
  notes text,                        -- 'Free wifi, quiet study zone'
  embedding vector(1536),
  source varchar DEFAULT 'manual'
    CHECK (source IN ('manual', 'google_places', 'user_submitted')),
  is_verified boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX ON places USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX idx_places_h3 ON places (h3_r8);
CREATE INDEX idx_places_type ON places (place_type);
CREATE INDEX idx_places_area ON places (area);

-- ─── Seed a few real Hyderabad libraries and study spaces ────────────────────
-- Enough to make the place_discovery path genuinely useful on day one.
INSERT INTO places (name, place_type, address, area, lat, lng, notes, source, is_verified)
VALUES
  ('State Central Library', 'library',
   'Afzal Gunj, Hyderabad', 'Afzal Gunj', 17.3753, 78.4744,
   'Largest public library in Telangana. Free membership with ID proof.',
   'manual', true),

  ('British Council Library', 'library',
   'Road No. 12, Banjara Hills', 'Banjara Hills', 17.4156, 78.4347,
   'Paid membership. Strong English fiction and exam prep sections.',
   'manual', true),

  ('City Central Library, Chikkadpally', 'library',
   'Chikkadpally, Hyderabad', 'Chikkadpally', 17.3986, 78.4967,
   'Popular with competitive exam aspirants. Opens early.',
   'manual', true),

  ('Krishna Kanth Park Library', 'library',
   'Jubilee Hills', 'Jubilee Hills', 17.4308, 78.4078,
   'Small reading room inside the park. Quiet, free entry.',
   'manual', true),

  ('IIIT Hyderabad Library', 'library',
   'Gachibowli', 'Gachibowli', 17.4456, 78.3497,
   'Academic library. Visitor access needs prior permission.',
   'manual', true),

  ('Lamakaan', 'community_space',
   'Road No. 1, Banjara Hills', 'Banjara Hills', 17.4213, 78.4407,
   'Open cultural space. Free events, talks, film screenings, book clubs. Good place to meet people.',
   'manual', true),

  ('Phoenix Arena Co-working', 'co-working',
   'HITEC City', 'HITEC City', 17.4478, 78.3759,
   'Day passes available. Quiet zones and community events.',
   'manual', true),

  ('91springboard Hyderabad', 'co-working',
   'Gachibowli', 'Gachibowli', 17.4401, 78.3489,
   'Co-working with an active member community and regular meetups.',
   'manual', true)
;
