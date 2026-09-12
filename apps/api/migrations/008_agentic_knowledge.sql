-- ─── Agentic Knowledge Layer ─────────────────────────────────────────────────
--
-- Replaces hardcoded lookups with knowledge the agent acquires, evaluates and
-- revises. Every previously-static table becomes a learned store with
-- provenance, confidence and evidence counts.
--
-- Design principle: BOOTSTRAP PRIORS, NOT HARDCODED TRUTH.
--
-- A system with zero knowledge and zero vendors is useless on day one, so
-- seeded values remain — but they are explicitly marked source='bootstrap',
-- carry low confidence, and are OVERRIDDEN the moment learned evidence
-- outweighs them. The agent is not choosing between "hardcoded" and "nothing";
-- it starts from a weak prior and earns its way past it.
--
-- The one deliberate exception is documented in safety_patterns below.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. GENERAL LEARNED-KNOWLEDGE STORE
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE agent_knowledge (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

  domain varchar NOT NULL,          -- 'kyc_requirement', 'booking_type',
                                     -- 'cancellation_window', 'price_band'
  subject varchar NOT NULL,          -- usually a category slug or id
  key varchar NOT NULL,              -- the specific fact being asserted
  value jsonb NOT NULL,

  -- Provenance: how do we know this?
  source varchar NOT NULL DEFAULT 'learned'
    CHECK (source IN (
      'bootstrap',   -- seeded prior, weak by design
      'learned',     -- inferred from observed behaviour
      'agent',       -- the LLM reasoned it out
      'admin',       -- a human asserted it (highest trust)
      'vendor'       -- a vendor told us directly
    )),

  confidence numeric NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  evidence_count integer NOT NULL DEFAULT 1,
  reasoning text,                    -- why the agent concluded this

  -- Effectiveness feedback: did acting on this knowledge work out?
  applied_count integer DEFAULT 0,
  success_count integer DEFAULT 0,

  status varchar DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'rejected', 'needs_review')),
  superseded_by uuid REFERENCES agent_knowledge(id),

  first_observed timestamptz DEFAULT now(),
  last_observed timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE(domain, subject, key, source)
);

CREATE INDEX idx_knowledge_lookup ON agent_knowledge (domain, subject, key)
  WHERE status = 'active';
CREATE INDEX idx_knowledge_review ON agent_knowledge (status, confidence)
  WHERE status = 'needs_review';

-- Effective knowledge: highest-trust active assertion wins.
-- Source precedence: admin > vendor > learned > agent > bootstrap,
-- with confidence breaking ties within a tier.
CREATE VIEW effective_knowledge AS
SELECT DISTINCT ON (domain, subject, key)
  domain, subject, key, value, source, confidence, evidence_count, reasoning
FROM agent_knowledge
WHERE status = 'active'
ORDER BY domain, subject, key,
  CASE source
    WHEN 'admin' THEN 5
    WHEN 'vendor' THEN 4
    WHEN 'learned' THEN 3
    WHEN 'agent' THEN 2
    WHEN 'bootstrap' THEN 1
  END DESC,
  confidence DESC,
  evidence_count DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. GEOCODING CACHE — replaces the hardcoded HYDERABAD_AREAS map
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Previously 45 area names with coordinates baked into TypeScript. That
-- couldn't handle a 46th area, a misspelling, or a different city. Now:
-- resolve via a geocoding provider, cache the result, and let the cache grow
-- into whatever geography the users actually type.
CREATE TABLE geo_cache (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

  query_normalized varchar UNIQUE NOT NULL,   -- lowercased, trimmed input
  query_original varchar NOT NULL,

  lat double precision,
  lng double precision,
  formatted_address text,
  locality varchar,                            -- the canonical area name
  city varchar,
  h3_r8 varchar(16),
  h3_r7 varchar(16),
  h3_r6 varchar(16),

  -- Semantic fallback: "near the IT park" won't geocode but can be matched
  -- against previously resolved queries by embedding similarity
  embedding vector(1536),

  provider varchar CHECK (provider IN ('google', 'nominatim', 'agent', 'manual')),
  precision_level varchar
    CHECK (precision_level IS NULL OR precision_level IN
      ('rooftop', 'street', 'locality', 'city', 'approximate')),

  -- A failed lookup is worth caching too — don't retry a hopeless query
  resolution_failed boolean DEFAULT false,
  failure_reason text,

  hit_count integer DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  last_hit_at timestamptz DEFAULT now()
);

CREATE INDEX idx_geo_cache_query ON geo_cache (query_normalized);
CREATE INDEX ON geo_cache USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND resolution_failed = false;
CREATE INDEX idx_geo_cache_locality ON geo_cache (locality)
  WHERE locality IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. LEARNED FOLLOW-UP QUESTIONS — replaces CATEGORY_FOLLOW_UPS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Previously 18 questions hardcoded per category, written by guesswork.
-- Now the agent generates them from fields vendors in that category ACTUALLY
-- use (category_field_templates already observes this), then measures whether
-- each question gets answered and whether asking it improved match quality.
-- Questions that nobody answers get retired automatically.
CREATE TABLE learned_questions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id uuid REFERENCES service_categories(id) ON DELETE CASCADE,

  field_name varchar NOT NULL,          -- which attribute this fills
  question_text text NOT NULL,
  options jsonb,                        -- suggested answers, may be null
  field_type varchar NOT NULL,

  -- Why does this question exist?
  origin varchar NOT NULL DEFAULT 'generated'
    CHECK (origin IN (
      'generated',     -- agent wrote it from observed vendor fields
      'bootstrap',     -- seeded prior
      'admin',         -- a human wrote it
      'vendor_gap'     -- vendors kept asking customers for this in chat
    )),
  generated_from text,                  -- the evidence that prompted it

  -- Effectiveness — the whole point of making this learned
  times_asked integer DEFAULT 0,
  times_answered integer DEFAULT 0,
  times_skipped integer DEFAULT 0,
  -- Did asking it lead to a confirmed booking more often?
  bookings_after_asked integer DEFAULT 0,
  bookings_after_skipped integer DEFAULT 0,

  answer_rate numeric GENERATED ALWAYS AS (
    CASE WHEN times_asked > 0
      THEN times_answered::numeric / times_asked
      ELSE NULL END
  ) STORED,

  status varchar DEFAULT 'active'
    CHECK (status IN ('active', 'testing', 'retired')),
  retired_reason text,

  display_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE(category_id, field_name)
);

CREATE INDEX idx_learned_q_category ON learned_questions (category_id, display_order)
  WHERE status IN ('active', 'testing');

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. SCOPE BOUNDARIES — semantic, replacing substring match_patterns
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Previously: `t.includes('flight ticket')`. That misses "need to fly to
-- Delhi", "book me on the 6am to Mumbai", or anything in Telugu.
-- Now: embed the boundary definition, compare semantically. New boundaries
-- can be proposed by the agent when a demand cluster shows a clear pattern.
ALTER TABLE out_of_scope_categories
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS canonical_description text,
  ADD COLUMN IF NOT EXISTS similarity_threshold numeric DEFAULT 0.78,
  ADD COLUMN IF NOT EXISTS source varchar DEFAULT 'bootstrap'
    CHECK (source IN ('bootstrap', 'agent', 'admin')),
  ADD COLUMN IF NOT EXISTS times_matched integer DEFAULT 0,
  -- Track false positives so thresholds can be tuned from evidence
  ADD COLUMN IF NOT EXISTS false_positive_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status varchar DEFAULT 'active'
    CHECK (status IN ('active', 'testing', 'retired'));

CREATE INDEX ON out_of_scope_categories USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND status = 'active';

-- A canonical natural-language description the agent can embed, instead of
-- a bag of substrings
UPDATE out_of_scope_categories SET canonical_description = CASE slug
  WHEN 'train-tickets' THEN
    'Booking a railway or train ticket, reserving a train seat or berth, ' ||
    'tatkal booking, checking train availability or PNR status'
  WHEN 'flight-tickets' THEN
    'Booking an air ticket or flight, reserving a seat on a plane, ' ||
    'flying to another city, checking airfares'
  WHEN 'movie-tickets' THEN
    'Booking cinema or movie tickets, reserving multiplex seats, ' ||
    'checking movie showtimes'
  WHEN 'government-appointments' THEN
    'Booking a government appointment — passport, visa, Aadhaar update, ' ||
    'driving licence, RTO test, PAN card, voter ID or similar official service'
  WHEN 'food-delivery' THEN
    'Ordering food for delivery to my home, getting a meal delivered'
  WHEN 'bus-tickets' THEN
    'Booking an intercity bus ticket, reserving a seat on a coach or sleeper bus'
  WHEN 'hotel-booking' THEN
    'Booking a hotel room or resort stay at a branded or chain property'
  WHEN 'concert-tickets' THEN
    'Buying tickets to a concert, live show, sports match or comedy event'
  WHEN 'temple-darshan' THEN
    'Booking temple darshan, seva, pooja or abhishekam at a temple'
  ELSE explanation
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. SAFETY PATTERNS — the deliberate exception
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠️  ARCHITECTURAL EXCEPTION, ARGUED DELIBERATELY.
--
-- Everything else in this migration moves from hardcoded to agentic. Emergency
-- detection does NOT — not fully. The reason:
--
--   A person typing "my father can't breathe" must reach the number 108 in
--   milliseconds. An LLM call is 300ms–15s, can rate-limit, can time out, can
--   be down, and can hallucinate. A semantic embedding lookup needs a network
--   round trip. Every one of those is an unacceptable dependency between
--   someone in crisis and an ambulance.
--
-- The resolution is AGENTIC AUTHORING, DETERMINISTIC EXECUTION:
--
--   • The pattern set lives here in the database, so it evolves
--   • The agent PROPOSES new patterns from missed cases (status='proposed')
--   • A human APPROVES them before they go live (status='active')
--   • On boot, active patterns are compiled into in-memory regex
--   • The runtime check is pure CPU, zero I/O, sub-millisecond
--
-- So the ruleset is genuinely learned and improvable. The hot path is not.
-- This is the correct tradeoff, not laziness.
CREATE TABLE safety_patterns (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

  pattern text NOT NULL,               -- regex source
  label varchar NOT NULL,              -- 'cardiac', 'self_harm'
  severity varchar NOT NULL CHECK (severity IN ('critical', 'urgent', 'advice')),
  language varchar DEFAULT 'en',

  -- Which forced response this maps to
  response_key varchar NOT NULL,

  source varchar NOT NULL DEFAULT 'bootstrap'
    CHECK (source IN ('bootstrap', 'agent_proposed', 'admin')),

  -- Agent-proposed patterns are INERT until a human approves them.
  -- A bad regex here could either miss an emergency or spam false alarms.
  status varchar NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'proposed', 'rejected', 'retired')),
  proposed_reasoning text,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,

  times_matched integer DEFAULT 0,
  false_positive_reports integer DEFAULT 0,

  created_at timestamptz DEFAULT now(),
  UNIQUE(pattern, label)
);

CREATE INDEX idx_safety_active ON safety_patterns (severity, status)
  WHERE status = 'active';

-- Forced response templates, editable without a deploy
CREATE TABLE safety_responses (
  response_key varchar PRIMARY KEY,
  body text NOT NULL,
  -- Emergency numbers change; these should be updatable by ops, not devs
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. SERVICE-ROLE PLAUSIBILITY — replaces the NON_SERVICE_CONCEPTS blocklist
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Previously an 18-term substring blocklist that would reject "cook" if it
-- contained "book". Now: exemplars on both sides of the boundary, compared
-- semantically. The agent adds exemplars as it encounters edge cases.
CREATE TABLE role_exemplars (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

  text varchar NOT NULL,
  is_service_role boolean NOT NULL,     -- true = hireable, false = not
  embedding vector(1536),

  reasoning text,
  source varchar DEFAULT 'bootstrap'
    CHECK (source IN ('bootstrap', 'agent', 'admin', 'observed')),

  -- Observed exemplars come from real outcomes: a category that attracted
  -- vendors was a real role; one that stayed empty for 90 days was not
  times_referenced integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(text)
);

CREATE INDEX ON role_exemplars USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. MIGRATE HARDCODED VALUES IN AS WEAK BOOTSTRAP PRIORS
-- ═══════════════════════════════════════════════════════════════════════════

-- KYC requirements: currently a boolean column set by a hardcoded keyword list
INSERT INTO agent_knowledge (domain, subject, key, value, source, confidence, reasoning)
SELECT 'kyc_requirement', slug, 'requires_kyc',
       to_jsonb(requires_kyc), 'bootstrap', 0.4,
       'Seeded prior. Should be revised from whether vendors in this category ' ||
       'actually enter customer premises, and from any incident history.'
FROM service_categories
ON CONFLICT DO NOTHING;

-- Booking type per category
INSERT INTO agent_knowledge (domain, subject, key, value, source, confidence, reasoning)
SELECT 'booking_type', slug, 'default_booking_type',
       to_jsonb(default_booking_type), 'bootstrap', 0.4,
       'Seeded prior. Should be revised from which booking type customers in ' ||
       'this category actually complete.'
FROM service_categories
WHERE default_booking_type IS NOT NULL
ON CONFLICT DO NOTHING;

-- Cancellation windows (were a CASE WHEN slug LIKE ladder)
INSERT INTO agent_knowledge (domain, subject, key, value, source, confidence, reasoning)
SELECT 'cancellation_policy', sc.slug, 'free_cancellation_hours',
       to_jsonb(cp.free_cancellation_hours), 'bootstrap', 0.35,
       'Seeded prior from category type. Should be revised from observed ' ||
       'cancellation timing and vendor complaints.'
FROM cancellation_policies cp
JOIN service_categories sc ON sc.id = cp.category_id
ON CONFLICT DO NOTHING;

-- Follow-up questions, carried in as bootstrap so cold start still works
INSERT INTO learned_questions
  (category_id, field_name, question_text, options, field_type, origin, generated_from)
SELECT c.id, q.field_name, q.question_text, q.options::jsonb, q.field_type,
       'bootstrap',
       'Migrated from the hardcoded CATEGORY_FOLLOW_UPS map. Weak prior — ' ||
       'expected to be replaced by generated questions once vendor field ' ||
       'observations accumulate.'
FROM service_categories c
JOIN (VALUES
  ('massage-wellness', 'gender_preference',
   'Do you have a preference for your therapist''s gender?',
   '["Female only","Male only","No preference"]', 'text'),
  ('salon-hair', 'gender_preference',
   'Do you prefer a female or male stylist?',
   '["Female","Male","No preference"]', 'text'),
  ('photography', 'venue_type', 'Will this be indoors or outdoors?',
   '["Indoors","Outdoors","Both"]', 'text'),
  ('photography', 'duration_hours', 'Roughly how many hours do you need?',
   '["1-2 hours","3-4 hours","Full day","Not sure yet"]', 'text'),
  ('home-electrical', 'premises_type',
   'Is this for a home or a commercial space?',
   '["Home","Office / Commercial"]', 'text'),
  ('home-cleaning', 'property_size', 'How many BHK?',
   '["1 BHK","2 BHK","3 BHK","Villa / larger"]', 'text'),
  ('catering', 'guest_count', 'How many people?',
   '["Under 20","20-50","50-100","100+"]', 'number'),
  ('catering', 'food_preference', 'Veg, non-veg, or both?',
   '["Veg only","Non-veg","Both"]', 'text'),
  ('tutoring', 'subject', 'Which subject or skill?',
   '["Maths","Science","English","Coding"]', 'text'),
  ('auto-rickshaw', 'trip_type', 'One-way or round trip?',
   '["One-way","Round trip","Need to wait there"]', 'text')
) AS q(cat_slug, field_name, question_text, options, field_type)
  ON c.slug = q.cat_slug
ON CONFLICT (category_id, field_name) DO NOTHING;

-- Safety patterns migrated in as ACTIVE bootstrap — these must work from
-- minute one, they cannot wait for learning
INSERT INTO safety_patterns (pattern, label, severity, response_key, source, status)
VALUES
  ('\b(chest pain|chest tightness|heart attack|cardiac arrest)\b', 'cardiac', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(can''?t breathe|cannot breathe|not breathing|struggling to breathe|breathless)\b', 'respiratory', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(unconscious|unresponsive|passed out|fainted and not waking)\b', 'unconscious', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(stroke|face drooping|slurred speech|sudden paralysis)\b', 'stroke', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(severe bleeding|heavy bleeding|bleeding a lot|blood loss|haemorrhage|hemorrhage)\b', 'bleeding', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(suicide|kill myself|end my life|want to die|self harm)\b', 'self_harm', 'critical', 'emergency_self_harm', 'bootstrap', 'active'),
  ('\b(overdose|poisoned|swallowed pills|drank poison)\b', 'poisoning', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(seizure|convulsion|fitting|having a fit)\b', 'seizure', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(accident|hit by (a )?(car|bus|bike|truck)|road accident)\b', 'trauma', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(severe burn|third degree burn|electrocuted|electric shock)\b', 'burns', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(labour pain|labor pain|water broke|going into labour)\b', 'obstetric', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(snake bite|snakebite|scorpion sting)\b', 'envenomation', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(choking|something stuck in throat)\b', 'choking', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(saans nahi|dam ghut|bachao|madad karo)\b', 'distress_hi', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(gundelo noppi|shwasa andaledu)\b', 'distress_te', 'critical', 'emergency_medical', 'bootstrap', 'active'),
  ('\b(high fever|fever 10[3-9]|very high temperature)\b', 'high_fever', 'urgent', 'urgent_medical', 'bootstrap', 'active'),
  ('\b(severe pain|unbearable pain|excruciating)\b', 'severe_pain', 'urgent', 'urgent_medical', 'bootstrap', 'active'),
  ('\b(vomiting blood|blood in stool|blood in urine)\b', 'gi_bleed', 'urgent', 'urgent_medical', 'bootstrap', 'active'),
  ('\b(broken bone|fracture|dislocated)\b', 'fracture', 'urgent', 'urgent_medical', 'bootstrap', 'active'),
  ('\b(deep cut|needs stitches|wound not closing)\b', 'laceration', 'urgent', 'urgent_medical', 'bootstrap', 'active'),
  ('\b(allergic reaction|swelling of (face|lips|tongue)|hives all over)\b', 'allergy', 'urgent', 'urgent_medical', 'bootstrap', 'active'),
  ('\b(what medicine|which tablet|what should i take|dosage|how much.*mg)\b', 'advice_medication', 'advice', 'advice_refusal', 'bootstrap', 'active'),
  ('\b(is it serious|do i have|am i suffering from|what disease)\b', 'advice_diagnosis', 'advice', 'advice_refusal', 'bootstrap', 'active'),
  ('\b(diagnose|diagnosis|treatment for)\b', 'advice_treatment', 'advice', 'advice_refusal', 'bootstrap', 'active')
ON CONFLICT (pattern, label) DO NOTHING;

INSERT INTO safety_responses (response_key, body) VALUES
  ('emergency_medical',
   E'🚨 **This sounds like an emergency. Please get help right now.**\n\n' ||
   E'**Call immediately:**\n' ||
   E'• **108** — Ambulance (free, 24×7)\n' ||
   E'• **112** — All emergencies\n' ||
   E'• **102** — Medical helpline\n\n' ||
   E'**Nearest emergency rooms in Hyderabad:**\n' ||
   E'• Apollo Hospitals, Jubilee Hills — 040 2360 7777\n' ||
   E'• Osmania General Hospital (govt, free) — 040 2460 0146\n' ||
   E'• NIMS, Punjagutta — 040 2348 9000\n\n' ||
   E'**If someone is with you, ask them to call now while you stay with the person.**\n\n' ||
   E'I''m a booking app — I can''t help with emergencies, and I don''t want to delay you. Please call 108.'),

  ('emergency_self_harm',
   E'🫂 **Please talk to someone right now. You matter.**\n\n' ||
   E'**Free, confidential, 24×7:**\n' ||
   E'• **Tele-MANAS: 14416** — government mental health helpline\n' ||
   E'• **AASRA: 9820466726**\n' ||
   E'• **Vandrevala Foundation: 9999666555**\n' ||
   E'• **112** — if you are in immediate danger\n\n' ||
   E'These are real people who want to listen. Please call one of them.\n\n' ||
   E'I''m only a booking app, and you deserve much better support than I can give.'),

  ('urgent_medical',
   E'⚠️ **That needs a doctor soon — sooner than an app booking.**\n\n' ||
   E'Please either:\n' ||
   E'• Visit the nearest hospital casualty/OPD directly\n' ||
   E'• Call **108** if it gets worse\n' ||
   E'• Call **102** for the medical helpline\n\n' ||
   E'If it''s already been seen and you just need a follow-up consultation, tell me the speciality and I can book an appointment.'),

  ('advice_refusal',
   E'I can''t give medical advice — I''m a booking app, not a doctor, and getting that wrong could genuinely harm you.\n\n' ||
   E'What I *can* do is book you an appointment with a registered doctor. Tell me the speciality (or just describe who you need to see) and your preferred area, and I''ll find available slots.\n\n' ||
   E'If it feels urgent, please call **102** or visit a hospital OPD directly.')
ON CONFLICT (response_key) DO NOTHING;

-- Role exemplars — both sides of the boundary, as weak priors
INSERT INTO role_exemplars (text, is_service_role, reasoning, source) VALUES
  ('plumber who fixes leaking taps', true, 'A person paid for labour', 'bootstrap'),
  ('wedding photographer', true, 'A person paid for a service', 'bootstrap'),
  ('maths tutor for grade 10', true, 'A person paid for teaching', 'bootstrap'),
  ('auto rickshaw driver', true, 'A person paid for transport', 'bootstrap'),
  ('camera rental shop', true, 'A business hiring out equipment', 'bootstrap'),
  ('banquet hall for functions', true, 'A venue hired for money', 'bootstrap'),
  ('chartered accountant for tax filing', true, 'A professional paid for expertise', 'bootstrap'),
  ('public library', false, 'A place, not a person you hire', 'bootstrap'),
  ('making new friends', false, 'A social outcome, not a paid service', 'bootstrap'),
  ('a park to walk in', false, 'A place, not a hireable service', 'bootstrap'),
  ('finding a life partner', false, 'Not a service Locogi provides', 'bootstrap'),
  ('a job for myself', false, 'Employment for the user, not a service to buy', 'bootstrap'),
  ('buying groceries', false, 'A product purchase, not a booked service', 'bootstrap'),
  ('legal advice on my case', false, 'Advice content, not a booking — book a lawyer instead', 'bootstrap'),
  ('government passport appointment', false, 'A regulated official process we must not intermediate', 'bootstrap'),
  ('feeling lonely and want to talk', false, 'Emotional support, not a paid service', 'bootstrap')
ON CONFLICT (text) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. AGENT DECISION AUDIT (extends the existing agent_decisions table)
-- ═══════════════════════════════════════════════════════════════════════════
-- Now that knowledge is learned rather than hardcoded, every use of it needs
-- to be traceable — "why did the agent ask that question / require KYC here?"
CREATE TABLE knowledge_applications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  knowledge_id uuid REFERENCES agent_knowledge(id) ON DELETE CASCADE,
  request_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,

  applied_value jsonb,
  outcome varchar CHECK (outcome IS NULL OR outcome IN
    ('success', 'failure', 'unknown')),
  outcome_note text,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_knowledge_apps ON knowledge_applications (knowledge_id, outcome);
