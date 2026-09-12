-- ─── Organization & Bookable Resource Layer ──────────────────────────────────
--
-- The original model assumed: one vendor = one person doing one kind of work.
-- That holds for a plumber. It breaks completely for a restaurant or hospital:
--
--   Restaurant: 5 staff need access · has a MENU (fixed prices, not quotes)
--               · TABLES with party-size capacity · does dine-in AND takeaway
--               AND catering simultaneously · needs FSSAI/GST, not Aadhaar
--
--   Hospital:   the bookable unit is a DOCTOR, not the hospital · departments
--               · per-doctor consultation fees · medical council registration
--               · and "chest pain" must NEVER enter a negotiation loop
--
-- This migration introduces:
--   organizations       — the business entity (restaurant, hospital, studio)
--   organization_members— many staff per org, with roles and permissions
--   bookable_resources  — the thing actually booked (a table, a doctor, a room)
--   catalog_items       — menu items / fixed-price services
--   resource_slots      — slots belong to a RESOURCE, not to a vendor
--   business_credentials— FSSAI, GST, medical registration (not personal ID)
--
-- A solo plumber still works unchanged: they get an implicit single-member
-- organization with one bookable resource (themselves). Nothing regresses.

-- ─── Organizations ────────────────────────────────────────────────────────────
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id uuid REFERENCES vendors(id) ON DELETE CASCADE,

  legal_name varchar NOT NULL,
  display_name varchar NOT NULL,
  org_type varchar NOT NULL
    CHECK (org_type IN (
      'individual',      -- solo plumber, freelance photographer
      'restaurant',      -- dine-in, takeaway, catering
      'clinic',          -- small practice, 1-5 doctors
      'hospital',        -- multi-department, many doctors
      'salon',           -- multiple chairs / stylists
      'studio',          -- photography / fitness / dance studio
      'agency',          -- staffing, event management
      'retail'           -- shop with a product catalog
    )),

  -- Which booking types this org supports. A restaurant ticks three.
  supported_booking_types text[] NOT NULL DEFAULT ARRAY['quote'],

  address text,
  area varchar,
  lat double precision,
  lng double precision,
  h3_r8 varchar(16),
  h3_r7 varchar(16),

  contact_phone varchar,
  contact_email varchar,
  website varchar,

  -- Verification state — gates going live
  verification_status varchar DEFAULT 'pending'
    CHECK (verification_status IN ('pending','under_review','verified','rejected','suspended')),
  verified_at timestamptz,
  rejection_reason text,

  -- Regulated categories need a human to approve, always
  requires_manual_approval boolean DEFAULT false,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ─── Staff with roles ─────────────────────────────────────────────────────────
CREATE TABLE organization_members (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,

  role varchar NOT NULL DEFAULT 'staff'
    CHECK (role IN ('owner','manager','staff','practitioner')),

  -- Granular permissions so a receptionist can confirm bookings but not
  -- change pricing or invite staff
  can_accept_bookings boolean DEFAULT true,
  can_manage_catalog boolean DEFAULT false,
  can_manage_staff boolean DEFAULT false,
  can_view_earnings boolean DEFAULT false,

  invited_by uuid REFERENCES users(id),
  joined_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT true,

  UNIQUE(organization_id, user_id)
);

-- ─── Staff invitations (phone-based, pre-signup) ──────────────────────────────
CREATE TABLE organization_invites (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  phone varchar NOT NULL,
  role varchar NOT NULL DEFAULT 'staff',
  invite_code varchar UNIQUE NOT NULL,
  invited_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_invites_phone ON organization_invites (phone)
  WHERE accepted_at IS NULL;

-- ─── Bookable resources — THE key abstraction ────────────────────────────────
-- What the customer actually books. For a restaurant it's a table. For a
-- hospital it's a doctor. For a salon it's a chair or a specific stylist.
-- For a solo plumber it's just... them.
CREATE TABLE bookable_resources (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,

  resource_type varchar NOT NULL
    CHECK (resource_type IN (
      'person',        -- doctor, stylist, trainer, the plumber themselves
      'table',         -- restaurant table
      'room',          -- consultation room, studio, hall
      'equipment',     -- specific camera kit, van, machine
      'slot_pool'      -- generic capacity with no named resource
    )),

  name varchar NOT NULL,                  -- 'Dr. Priya Sharma', 'Table 4'
  description text,

  -- For practitioner resources
  member_id uuid REFERENCES organization_members(id) ON DELETE SET NULL,
  specialization varchar,                 -- 'Cardiology', 'Bridal makeup'
  qualification varchar,                  -- 'MBBS, MD (Cardiology)'
  experience_years integer,

  -- For capacity resources (tables, rooms)
  capacity_min integer DEFAULT 1,          -- min party size
  capacity_max integer DEFAULT 1,          -- max party size

  -- Pricing lives on the resource, not the org — every doctor charges
  -- differently, every table has a different minimum spend
  base_price integer,
  price_unit varchar
    CHECK (price_unit IS NULL OR price_unit IN
      ('per_session','per_hour','per_person','per_visit','minimum_spend')),

  is_active boolean DEFAULT true,
  display_order integer DEFAULT 0,

  embedding vector(1536),                  -- so "heart doctor" finds Cardiology
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_resources_org ON bookable_resources (organization_id)
  WHERE is_active = true;
CREATE INDEX idx_resources_type ON bookable_resources (resource_type);
CREATE INDEX ON bookable_resources USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- ─── Resource-level slots (replaces vendor-level reservation_slots) ──────────
-- A restaurant's 7pm slot exists per TABLE. A hospital's 10am slot exists per
-- DOCTOR. Vendor-level slots could never express either.
CREATE TABLE resource_slots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_id uuid REFERENCES bookable_resources(id) ON DELETE CASCADE,

  slot_time timestamptz NOT NULL,
  duration_minutes integer DEFAULT 30,

  capacity_total integer DEFAULT 1,
  capacity_booked integer DEFAULT 0,

  -- Overrides the resource's base price for this specific slot
  -- (peak dinner pricing, weekend consultation surcharge)
  price_override integer,

  is_cancelled boolean DEFAULT false,
  cancelled_at timestamptz,
  cancel_reason text,

  created_at timestamptz DEFAULT now(),
  UNIQUE(resource_id, slot_time)
);

CREATE INDEX idx_resource_slots_lookup
  ON resource_slots (resource_id, slot_time)
  WHERE is_cancelled = false;

-- ─── Catalog — menu items and fixed-price services ───────────────────────────
-- The `order` booking type finally has something to order from.
CREATE TABLE catalog_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,

  name varchar NOT NULL,                   -- 'Hyderabadi Chicken Biryani'
  description text,
  section varchar,                         -- 'Biryani', 'Consultation', 'Hair'

  price integer NOT NULL CHECK (price >= 0),
  price_unit varchar DEFAULT 'per_item',

  -- Food-specific
  is_veg boolean,
  spice_level varchar CHECK (spice_level IS NULL OR spice_level IN ('mild','medium','hot')),
  allergens text[],
  serves_count integer,                    -- 'serves 2'

  -- Availability
  is_available boolean DEFAULT true,
  available_from time,                     -- breakfast-only items
  available_until time,
  available_days integer[],                -- weekend specials

  image_url text,
  display_order integer DEFAULT 0,
  embedding vector(1536),                  -- "spicy rice dish" finds biryani

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_catalog_org ON catalog_items (organization_id)
  WHERE is_available = true;
CREATE INDEX idx_catalog_section ON catalog_items (organization_id, section);
CREATE INDEX ON catalog_items USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- ─── Orders (for catalog-based bookings) ─────────────────────────────────────
CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,
  catalog_item_id uuid REFERENCES catalog_items(id),

  -- Snapshot the name and price AT ORDER TIME. Menus change; a past order
  -- must remain readable under the prices that were actually charged.
  item_name varchar NOT NULL,
  unit_price integer NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  notes text,                              -- 'less spicy', 'no onion'

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_order_items_request ON order_items (request_id);

-- ─── Business credentials (not personal ID) ──────────────────────────────────
CREATE TABLE business_credentials (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,

  credential_type varchar NOT NULL
    CHECK (credential_type IN (
      'gst',                  -- GST registration
      'fssai',                -- food safety licence (restaurants)
      'shop_establishment',   -- shops & establishments act
      'medical_registration', -- state medical council (doctors)
      'clinical_establishment', -- clinical establishments act (hospitals)
      'trade_licence',        -- municipal trade licence
      'pan',                  -- business PAN
      'other'
    )),

  credential_number varchar NOT NULL,
  issuing_authority varchar,
  valid_from date,
  valid_until date,

  document_url text,                       -- uploaded scan (private bucket)

  verification_status varchar DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','rejected','expired')),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  rejection_reason text,

  created_at timestamptz DEFAULT now(),
  UNIQUE(organization_id, credential_type, credential_number)
);

CREATE INDEX idx_credentials_org ON business_credentials (organization_id);
CREATE INDEX idx_credentials_pending ON business_credentials (verification_status)
  WHERE verification_status = 'pending';

-- ─── Which credentials does each org type legally require? ───────────────────
CREATE TABLE org_type_requirements (
  org_type varchar NOT NULL,
  credential_type varchar NOT NULL,
  is_mandatory boolean DEFAULT true,
  note text,
  PRIMARY KEY (org_type, credential_type)
);

INSERT INTO org_type_requirements (org_type, credential_type, is_mandatory, note) VALUES
  ('restaurant', 'fssai', true,
   'FSSAI licence is legally mandatory for any food business in India'),
  ('restaurant', 'gst', false,
   'Required above the turnover threshold'),
  ('restaurant', 'shop_establishment', false, NULL),

  ('clinic', 'medical_registration', true,
   'Every practitioner needs a valid state medical council registration'),
  ('clinic', 'clinical_establishment', true,
   'Clinical Establishments Act registration'),

  ('hospital', 'medical_registration', true,
   'Every practitioner needs a valid state medical council registration'),
  ('hospital', 'clinical_establishment', true,
   'Clinical Establishments Act registration'),
  ('hospital', 'gst', false, NULL),

  ('salon', 'shop_establishment', false, NULL),
  ('salon', 'gst', false, NULL),

  ('agency', 'gst', true, NULL),
  ('agency', 'shop_establishment', true, NULL),

  ('retail', 'gst', true, NULL),
  ('retail', 'trade_licence', false, NULL),

  ('studio', 'shop_establishment', false, NULL),
  ('individual', 'pan', false,
   'Optional for individuals below the tax threshold');

-- ─── Practitioner credentials (per-doctor, not per-org) ─────────────────────
CREATE TABLE practitioner_credentials (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_id uuid REFERENCES bookable_resources(id) ON DELETE CASCADE,

  registration_number varchar NOT NULL,
  council varchar NOT NULL,                -- 'Telangana State Medical Council'
  qualification varchar NOT NULL,
  valid_until date,

  verification_status varchar DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','rejected','expired')),
  verified_at timestamptz,

  created_at timestamptz DEFAULT now(),
  UNIQUE(resource_id, registration_number)
);

-- ─── Link requests to the resource that was booked ──────────────────────────
ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id),
  ADD COLUMN IF NOT EXISTS resource_id uuid REFERENCES bookable_resources(id),
  ADD COLUMN IF NOT EXISTS resource_slot_id uuid REFERENCES resource_slots(id),
  ADD COLUMN IF NOT EXISTS party_size integer;

CREATE INDEX idx_requests_org ON requests (organization_id)
  WHERE organization_id IS NOT NULL;

-- ─── Regulated category flags on the taxonomy ───────────────────────────────
ALTER TABLE service_categories
  ADD COLUMN IF NOT EXISTS is_regulated boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS regulation_note text,
  -- Health-adjacent categories get emergency interception, always
  ADD COLUMN IF NOT EXISTS is_health_adjacent boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS required_org_type varchar;

-- ─── Seed organization-type service categories ──────────────────────────────
INSERT INTO service_categories
  (slug, canonical_name, description, default_booking_type, requires_kyc,
   is_verified, is_regulated, is_health_adjacent, required_org_type)
VALUES
  ('restaurant-dinein', 'Restaurant (Dine-in)',
   'Table reservations at restaurants and cafes',
   'appointment', false, true, true, false, 'restaurant'),

  ('restaurant-takeaway', 'Restaurant (Takeaway)',
   'Order food for pickup from restaurants',
   'order', false, true, true, false, 'restaurant'),

  ('doctor-consultation', 'Doctor Consultation',
   'Outpatient appointments with registered medical practitioners',
   'appointment', true, true, true, true, 'clinic'),

  ('dental-care', 'Dental Care',
   'Dental checkups, cleaning and treatment',
   'appointment', true, true, true, true, 'clinic'),

  ('diagnostic-lab', 'Diagnostic Lab',
   'Blood tests, scans and sample collection',
   'appointment', true, true, true, true, 'clinic'),

  ('physiotherapy', 'Physiotherapy',
   'Physiotherapy sessions and rehabilitation',
   'appointment', true, true, true, true, 'clinic')
ON CONFLICT (slug) DO NOTHING;

UPDATE service_categories
SET regulation_note =
  'Health category. Emergency interception is enforced. Practitioner ' ||
  'registration is verified manually before going live. Booking is limited ' ||
  'to scheduling only — no diagnosis, advice, or triage.'
WHERE is_health_adjacent = true;

-- Register aliases for the new org categories
INSERT INTO category_aliases (category_id, alias, alias_normalized, source, similarity_score)
SELECT c.id, a.alias, lower(trim(a.alias)), 'seed', 1.0
FROM service_categories c
JOIN (VALUES
  ('restaurant-dinein', 'restaurant'),
  ('restaurant-dinein', 'table booking'),
  ('restaurant-dinein', 'table reservation'),
  ('restaurant-dinein', 'cafe'),
  ('restaurant-dinein', 'dine in'),
  ('restaurant-takeaway', 'takeaway'),
  ('restaurant-takeaway', 'food pickup'),
  ('restaurant-takeaway', 'parcel'),
  ('doctor-consultation', 'doctor'),
  ('doctor-consultation', 'physician'),
  ('doctor-consultation', 'gp'),
  ('doctor-consultation', 'general physician'),
  ('doctor-consultation', 'clinic'),
  ('doctor-consultation', 'hospital'),
  ('doctor-consultation', 'consultation'),
  ('dental-care', 'dentist'),
  ('dental-care', 'dental'),
  ('diagnostic-lab', 'blood test'),
  ('diagnostic-lab', 'lab test'),
  ('diagnostic-lab', 'diagnostic'),
  ('diagnostic-lab', 'scan'),
  ('physiotherapy', 'physio'),
  ('physiotherapy', 'physiotherapist')
) AS a(cat_slug, alias) ON c.slug = a.cat_slug
ON CONFLICT (alias_normalized) DO NOTHING;

-- ─── Backfill: give every existing vendor an implicit organization ───────────
-- A solo plumber becomes an 'individual' org with one 'person' resource.
-- Nothing about their experience changes.
INSERT INTO organizations
  (vendor_id, legal_name, display_name, org_type, supported_booking_types,
   area, lat, lng, h3_r8, h3_r7, verification_status, verified_at)
SELECT
  v.id,
  COALESCE(u.name, 'Individual Vendor'),
  COALESCE(u.name, 'Individual Vendor'),
  'individual',
  ARRAY['quote'],
  v.service_area_description,
  v.lat, v.lng, v.h3_r8, v.h3_r7,
  CASE WHEN v.is_kyc_verified THEN 'verified' ELSE 'pending' END,
  CASE WHEN v.is_kyc_verified THEN now() ELSE NULL END
FROM vendors v
JOIN users u ON u.id = v.user_id
WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.vendor_id = v.id);

INSERT INTO organization_members
  (organization_id, user_id, role, can_accept_bookings,
   can_manage_catalog, can_manage_staff, can_view_earnings)
SELECT o.id, v.user_id, 'owner', true, true, true, true
FROM organizations o
JOIN vendors v ON v.id = o.vendor_id
WHERE NOT EXISTS (
  SELECT 1 FROM organization_members m
  WHERE m.organization_id = o.id AND m.user_id = v.user_id
);

INSERT INTO bookable_resources
  (organization_id, resource_type, name, member_id, embedding)
SELECT o.id, 'person', o.display_name, m.id, v.embedding
FROM organizations o
JOIN vendors v ON v.id = o.vendor_id
JOIN organization_members m ON m.organization_id = o.id AND m.role = 'owner'
WHERE o.org_type = 'individual'
  AND NOT EXISTS (
    SELECT 1 FROM bookable_resources r WHERE r.organization_id = o.id
  );
