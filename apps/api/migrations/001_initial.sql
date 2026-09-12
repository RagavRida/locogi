-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone varchar UNIQUE NOT NULL,
  name varchar,
  is_vendor boolean DEFAULT false,
  is_customer boolean DEFAULT true,
  emergency_contact_phone varchar,
  is_banned boolean DEFAULT false,
  banned_at timestamptz,
  ban_reason text,
  consent_given_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- ─── Vendors ─────────────────────────────────────────────────────────────────
CREATE TABLE vendors (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES users(id),
  raw_description text NOT NULL,
  category_tags text[],
  attributes jsonb,
  attribute_schema jsonb,
  embedding vector(1536),
  embedding_generated_at timestamptz,
  service_area_description text,
  service_radius_km integer DEFAULT 10,
  is_priority boolean DEFAULT false,
  is_kyc_verified boolean DEFAULT false,
  rating numeric DEFAULT 0,
  response_rate numeric DEFAULT 0,
  completed_jobs integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE vendor_availability (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id uuid REFERENCES vendors(id),
  day_of_week integer NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  UNIQUE(vendor_id, day_of_week)
);

-- ─── Requests ────────────────────────────────────────────────────────────────
CREATE TABLE requests (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id uuid REFERENCES users(id),
  idempotency_key varchar UNIQUE NOT NULL,
  raw_description text NOT NULL,
  category_tags text[],
  attributes jsonb,
  embedding vector(1536),
  booking_type varchar NOT NULL
    CHECK (booking_type IN ('quote','appointment','hiring','order')),
  status varchar DEFAULT 'open'
    CHECK (status IN ('open','negotiating','confirmed','in_progress',
                      'completed','expired','cancelled','no_match')),
  confirmed_vendor_id uuid REFERENCES vendors(id),
  agreed_price integer,
  rematching_attempt integer DEFAULT 0,
  lead_fee_charged boolean DEFAULT false,
  lead_fee_amount integer,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz
);

-- ─── Request Responses ───────────────────────────────────────────────────────
CREATE TABLE request_responses (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid REFERENCES requests(id),
  vendor_id uuid REFERENCES vendors(id),
  status varchar DEFAULT 'pending'
    CHECK (status IN ('pending','quoted','counter','confirmed','declined',
                      'missed','applied','shortlisted','selected','rejected',
                      'withdrawn','delivered','no_show','cancelled_by_vendor')),
  quoted_price integer CHECK (quoted_price IS NULL OR quoted_price > 0),
  message text,
  notified_at timestamptz DEFAULT now(),
  responded_at timestamptz,
  UNIQUE(request_id, vendor_id)
);

-- ─── Reservation Slots ───────────────────────────────────────────────────────
CREATE TABLE reservation_slots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id uuid REFERENCES vendors(id),
  slot_time timestamptz NOT NULL,
  duration_minutes integer DEFAULT 30,
  capacity_total integer DEFAULT 1,
  capacity_booked integer DEFAULT 0,
  is_cancelled boolean DEFAULT false,
  cancelled_at timestamptz,
  cancel_reason text
);

-- ─── Messages ────────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid REFERENCES requests(id),
  sender_id uuid REFERENCES users(id),
  text text,
  image_url text,
  message_type varchar DEFAULT 'text'
    CHECK (message_type IN ('text','image','quote_offer','quote_counter',
                            'quote_accepted','system')),
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

-- ─── Live Locations ──────────────────────────────────────────────────────────
CREATE TABLE live_locations (
  user_id uuid REFERENCES users(id) PRIMARY KEY,
  request_id uuid REFERENCES requests(id),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  accuracy_meters double precision,
  updated_at timestamptz DEFAULT now()
);

-- ─── Push Tokens ─────────────────────────────────────────────────────────────
CREATE TABLE push_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES users(id),
  token varchar UNIQUE NOT NULL,
  platform varchar CHECK (platform IN ('ios','android')),
  is_active boolean DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- ─── Reviews ─────────────────────────────────────────────────────────────────
CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid REFERENCES requests(id),
  reviewer_id uuid REFERENCES users(id),
  vendor_id uuid REFERENCES vendors(id),
  rating integer CHECK (rating BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(request_id, reviewer_id)
);

-- ─── Vendor Agent Rules ──────────────────────────────────────────────────────
CREATE TABLE vendor_agent_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id uuid REFERENCES vendors(id) UNIQUE,
  rules_plain_text text,
  max_auto_accept_price integer,
  auto_accept_areas text[],
  auto_accept_days integer[],
  gender_filter varchar,
  auto_accept_enabled boolean DEFAULT false,
  updated_at timestamptz DEFAULT now()
);

-- ─── Agent Decisions ─────────────────────────────────────────────────────────
CREATE TABLE agent_decisions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id uuid REFERENCES vendors(id),
  request_id uuid REFERENCES requests(id),
  decision varchar NOT NULL
    CHECK (decision IN ('auto_accepted','auto_quoted','auto_declined',
                        'escalated_to_vendor')),
  reasoning text,
  rules_snapshot jsonb,
  confidence numeric,
  created_at timestamptz DEFAULT now()
);

-- ─── Outbox Events (reliable side effects) ───────────────────────────────────
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type varchar NOT NULL,
  payload jsonb NOT NULL,
  status varchar DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed')),
  retry_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);

-- ─── Events (PostHog analytics) ──────────────────────────────────────────────
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type varchar NOT NULL,
  user_id uuid,
  vendor_id uuid,
  request_id uuid,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

-- ─── Payments ────────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid REFERENCES requests(id),
  vendor_id uuid REFERENCES vendors(id),
  amount integer,
  type varchar CHECK (type IN ('lead_fee','subscription')),
  razorpay_payment_id varchar UNIQUE,
  status varchar DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX ON vendors USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX ON requests USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX ON vendors USING gin (category_tags);
CREATE INDEX ON requests USING gin (category_tags);
CREATE INDEX ON requests (status, created_at);
CREATE INDEX ON reservation_slots (vendor_id, slot_time)
  WHERE is_cancelled = false;
CREATE INDEX ON live_locations (request_id);
CREATE INDEX ON push_tokens (user_id) WHERE is_active = true;
CREATE INDEX ON outbox_events (status, created_at)
  WHERE status = 'pending';
