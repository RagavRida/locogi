-- ─── Vertical Expansion ──────────────────────────────────────────────────────
--
-- Adds the categories whose supply is FRAGMENTED and LOCAL — the ones where
-- semantic discovery is genuinely the hard problem.
--
-- Deliberately NOT added, and the reasons matter:
--
--   Train tickets   — IRCTC holds an absolute monopoly on inventory. B2B API
--                     access needs authorised-partner status and a large
--                     security deposit; margins are ~₹20/ticket. That is an
--                     inventory-reseller business, not a marketplace, and
--                     Locogi's matching engine adds nothing to it.
--   Flights         — GDS (Amadeus/Sabre) or direct airline APIs, IATA
--                     accreditation, 1–3% margins. Nobody needs semantic
--                     matching to find a Hyderabad→Delhi flight.
--   Movie tickets   — BookMyShow holds near-exclusive multiplex contracts.
--                     PVR seat maps are simply not obtainable.
--   Government      — Passport Seva, VFS, UIDAI, RTO. Reselling government
--                     appointment slots is what touts do; it is often
--                     explicitly prohibited and carries real legal risk.
--                     This is a deliberate refusal, not an oversight.
--
-- The pattern: high booking volume in India correlates with a solved,
-- centralised, monopolised inventory. The opportunity is the undigitised
-- long tail.

-- ─── 1. New booking type: rental (date ranges, not point-in-time) ────────────
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_booking_type_check;
ALTER TABLE requests ADD CONSTRAINT requests_booking_type_check
  CHECK (booking_type IN (
    'quote',        -- negotiated services
    'appointment',  -- point-in-time slot
    'hiring',       -- application queue
    'order',        -- fixed-price catalog
    'rental',       -- date-range hire with return  ← new
    'venue'         -- multi-day space booking      ← new
  ));

-- ─── 2. New resource types ───────────────────────────────────────────────────
ALTER TABLE bookable_resources DROP CONSTRAINT IF EXISTS bookable_resources_resource_type_check;
ALTER TABLE bookable_resources ADD CONSTRAINT bookable_resources_resource_type_check
  CHECK (resource_type IN (
    'person',      -- doctor, stylist, trainer, CA, lawyer
    'table',       -- restaurant table
    'room',        -- consultation room, meeting room, hotel room
    'equipment',   -- camera kit, sound system, power tools
    'vehicle',     -- self-drive car, bike, truck, tempo
    'property',    -- a flat/plot for site visits
    'venue',       -- banquet hall, lawn, convention space
    'slot_pool'    -- generic capacity, no named resource
  ));

-- Rental / vehicle / venue specific attributes
ALTER TABLE bookable_resources
  ADD COLUMN IF NOT EXISTS specs jsonb,
  -- e.g. vehicle: { make, model, year, fuel, transmission, seats, reg_no }
  --      camera:  { body, lenses[], accessories[] }
  --      venue:   { seating_capacity, floating_capacity, ac, parking, catering_allowed }
  ADD COLUMN IF NOT EXISTS security_deposit integer,
  ADD COLUMN IF NOT EXISTS min_booking_duration_hours integer,
  ADD COLUMN IF NOT EXISTS max_booking_duration_hours integer,
  -- Buffer between bookings — a car needs cleaning, a hall needs resetting
  ADD COLUMN IF NOT EXISTS turnaround_minutes integer DEFAULT 0;

-- ─── 3. Date-range bookings ──────────────────────────────────────────────────
--
-- Point-in-time slots use a capacity counter. Date ranges need something
-- stronger: a native Postgres EXCLUDE constraint, so two overlapping bookings
-- on the same resource are IMPOSSIBLE at the database level — the same rigour
-- as the atomic race-lock, but enforced declaratively.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE resource_bookings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_id uuid NOT NULL REFERENCES bookable_resources(id) ON DELETE CASCADE,
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,

  -- The reserved window, including any turnaround buffer
  period tstzrange NOT NULL,

  -- What the customer actually asked for (excludes buffer), for display
  customer_from timestamptz NOT NULL,
  customer_until timestamptz NOT NULL,

  status varchar DEFAULT 'confirmed'
    CHECK (status IN ('held','confirmed','in_progress','returned','cancelled','overdue')),

  -- Rental specifics
  deposit_amount integer,
  deposit_status varchar
    CHECK (deposit_status IS NULL OR deposit_status IN
      ('pending','held','refunded','forfeited','partially_refunded')),

  -- Handover / return
  handed_over_at timestamptz,
  returned_at timestamptz,
  condition_notes_out text,
  condition_notes_in text,
  damage_reported boolean DEFAULT false,
  damage_charge integer,

  -- Odometer for vehicles, shot count for cameras, etc.
  usage_out numeric,
  usage_in numeric,
  usage_unit varchar,          -- 'km', 'hours', 'shots'
  included_usage numeric,      -- e.g. 200 km free
  excess_usage_rate integer,   -- ₹ per unit beyond included

  created_at timestamptz DEFAULT now(),

  CHECK (customer_until > customer_from),

  -- THE guarantee: no two active bookings may overlap on one resource.
  -- Cancelled bookings are excluded so a cancellation frees the window.
  EXCLUDE USING gist (
    resource_id WITH =,
    period WITH &&
  ) WHERE (status <> 'cancelled')
);

CREATE INDEX idx_resource_bookings_resource ON resource_bookings (resource_id)
  WHERE status <> 'cancelled';
CREATE INDEX idx_resource_bookings_period ON resource_bookings USING gist (period);
CREATE INDEX idx_resource_bookings_overdue ON resource_bookings (customer_until)
  WHERE status IN ('confirmed', 'in_progress');

-- ─── 4. Resource unavailability (maintenance, owner use, festival closure) ───
CREATE TABLE resource_blackouts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_id uuid NOT NULL REFERENCES bookable_resources(id) ON DELETE CASCADE,
  period tstzrange NOT NULL,
  reason varchar,
  created_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now(),

  EXCLUDE USING gist (resource_id WITH =, period WITH &&)
);

CREATE INDEX idx_blackouts_resource ON resource_blackouts USING gist (period);

-- ─── 5. Multi-vendor coordination (weddings, events) ─────────────────────────
--
-- A wedding needs a venue AND photographer AND caterer AND decorator, all on
-- the same date. Today those would be four unlinked requests that could easily
-- end up on different days.
CREATE TABLE booking_bundles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title varchar NOT NULL,              -- "Priya & Arjun wedding"
  event_date date,
  event_end_date date,                 -- multi-day functions
  venue_area varchar,
  total_budget integer,
  guest_count integer,

  status varchar DEFAULT 'planning'
    CHECK (status IN ('planning','partially_booked','fully_booked','completed','cancelled')),

  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE bundle_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  bundle_id uuid NOT NULL REFERENCES booking_bundles(id) ON DELETE CASCADE,
  request_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  category_id uuid REFERENCES service_categories(id),

  role_label varchar NOT NULL,         -- 'Venue', 'Photographer', 'Caterer'
  is_required boolean DEFAULT true,
  budget_allocation integer,

  -- Some items depend on others: you cannot confirm catering before the venue
  depends_on_item_id uuid REFERENCES bundle_items(id),

  status varchar DEFAULT 'pending'
    CHECK (status IN ('pending','searching','quoted','booked','skipped')),

  display_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_bundle_items_bundle ON bundle_items (bundle_id);

ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS bundle_id uuid REFERENCES booking_bundles(id);

-- ─── 6. Category expansion ───────────────────────────────────────────────────
-- Widen the service_categories booking type constraint to match requests (above).
ALTER TABLE service_categories DROP CONSTRAINT IF EXISTS service_categories_default_booking_type_check;
ALTER TABLE service_categories ADD CONSTRAINT service_categories_default_booking_type_check
  CHECK (default_booking_type IN ('quote','appointment','hiring','order','rental','venue'));

INSERT INTO service_categories
  (slug, canonical_name, description, default_booking_type,
   requires_kyc, is_verified, is_regulated, required_org_type)
VALUES
  -- ── Fitness ──────────────────────────────────────────────────────────────
  ('gym-membership', 'Gym',
   'Gym memberships, day passes and trial sessions',
   'appointment', false, true, false, 'studio'),
  ('personal-training', 'Personal Trainer',
   'One-on-one fitness training, at a gym or at home',
   'appointment', true, true, false, null),
  ('yoga-classes', 'Yoga',
   'Yoga classes, group or personal, studio or home',
   'appointment', true, true, false, null),

  -- ── Vehicle services ─────────────────────────────────────────────────────
  ('car-service', 'Car Service',
   'Car servicing, repair, denting and painting',
   'appointment', false, true, false, 'retail'),
  ('bike-service', 'Bike Service',
   'Two-wheeler servicing and repair',
   'appointment', false, true, false, 'retail'),
  ('vehicle-roadside', 'Roadside Assistance',
   'Breakdown help, jump start, tyre change, towing',
   'quote', false, true, false, null),
  ('ev-charging', 'EV Charging',
   'Electric vehicle charging slot booking',
   'appointment', false, true, false, 'retail'),

  -- ── Rentals ──────────────────────────────────────────────────────────────
  ('rental-selfdrive-car', 'Self-Drive Car Rental',
   'Rent a car to drive yourself, by the day or hour',
   'rental', true, true, true, 'retail'),
  ('rental-bike', 'Bike Rental',
   'Rent a two-wheeler by the hour or day',
   'rental', true, true, true, 'retail'),
  ('rental-camera', 'Camera & Gear Rental',
   'Cameras, lenses, lighting and audio equipment on rent',
   'rental', true, true, false, 'retail'),
  ('rental-equipment', 'Equipment Rental',
   'Power tools, sound systems, generators, furniture on rent',
   'rental', false, true, false, 'retail'),
  ('rental-tempo', 'Tempo & Truck Hire',
   'Goods vehicles with or without a driver',
   'rental', true, true, true, null),

  -- ── Events & venues ──────────────────────────────────────────────────────
  ('venue-banquet', 'Banquet Hall',
   'Banquet halls and party halls for functions',
   'venue', false, true, false, 'agency'),
  ('venue-wedding', 'Wedding Venue',
   'Kalyana mandapams, lawns and wedding resorts',
   'venue', false, true, false, 'agency'),
  ('venue-conference', 'Conference Venue',
   'Conference halls, auditoriums and seminar spaces',
   'venue', false, true, false, 'agency'),
  ('event-planner', 'Event Planner',
   'End-to-end event planning and coordination',
   'quote', false, true, false, 'agency'),

  -- ── Legal & financial ────────────────────────────────────────────────────
  ('ca-accountant', 'CA / Accountant',
   'Chartered accountants for tax filing, audit and GST',
   'appointment', true, true, true, null),
  ('lawyer-consultation', 'Lawyer',
   'Legal consultation — property, family, civil, criminal',
   'appointment', true, true, true, null),
  ('financial-advisor', 'Financial Advisor',
   'Investment planning, insurance and loan advisory',
   'appointment', true, true, true, null),

  -- ── Real estate ──────────────────────────────────────────────────────────
  ('property-visit', 'Property Visit',
   'Site visits to flats, plots and independent houses',
   'appointment', true, true, false, 'agency'),
  ('property-inspection', 'Property Inspection',
   'Pre-purchase structural and legal inspection',
   'quote', true, true, false, null),

  -- ── Co-working ───────────────────────────────────────────────────────────
  ('coworking-desk', 'Co-working Desk',
   'Hot desks and dedicated desks by the day or month',
   'appointment', false, true, false, 'retail'),
  ('meeting-room', 'Meeting Room',
   'Meeting and conference rooms by the hour',
   'appointment', false, true, false, 'retail'),

  -- ── Logistics ────────────────────────────────────────────────────────────
  ('courier-pickup', 'Courier Pickup',
   'Document and parcel pickup and delivery within the city',
   'quote', false, true, false, null),
  ('goods-transport', 'Goods Transport',
   'Truck and tempo hire for goods movement',
   'quote', true, true, true, null),

  -- ── Education (expanding beyond generic tutoring) ────────────────────────
  ('exam-coaching', 'Exam Coaching',
   'JEE, NEET, EAMCET, UPSC and competitive exam coaching',
   'appointment', true, true, false, null),
  ('skill-workshop', 'Workshops',
   'Short courses and workshops — coding, music, art, dance',
   'appointment', false, true, false, 'studio'),
  ('counselling', 'Counselling',
   'Career counselling and academic guidance',
   'appointment', true, true, false, null),

  -- ── Stays (fragmented end only — see note below) ─────────────────────────
  ('homestay-villa', 'Homestay & Villa',
   'Independent homestays, villas and farmhouses for short stays',
   'rental', false, true, false, 'retail')
ON CONFLICT (slug) DO NOTHING;

-- Mental-health counselling is health-adjacent — emergency interception applies
UPDATE service_categories
SET is_health_adjacent = true,
    regulation_note = 'Counselling is health-adjacent. Emergency interception ' ||
      'is enforced and no advice is ever given — scheduling only.'
WHERE slug = 'counselling';

-- Regulated professions need credential verification before going live
UPDATE service_categories
SET regulation_note = 'Regulated profession. Practitioner registration ' ||
      '(ICAI / Bar Council / SEBI as applicable) is verified manually before ' ||
      'the vendor can accept bookings. No advice is given by the platform.'
WHERE slug IN ('ca-accountant', 'lawyer-consultation', 'financial-advisor');

-- Vehicle rentals need a driving licence check on the CUSTOMER, not the vendor
UPDATE service_categories
SET regulation_note = 'Customer driving licence verification is required ' ||
      'before handover. Vendor needs commercial vehicle permits where applicable.'
WHERE slug IN ('rental-selfdrive-car', 'rental-bike', 'rental-tempo');

-- ─── 7. Aliases for the new categories ───────────────────────────────────────
INSERT INTO category_aliases (category_id, alias, alias_normalized, source, similarity_score)
SELECT c.id, a.alias, lower(trim(a.alias)), 'seed', 1.0
FROM service_categories c
JOIN (VALUES
  ('gym-membership', 'gym'), ('gym-membership', 'fitness centre'),
  ('personal-training', 'personal trainer'), ('personal-training', 'fitness trainer'),
  ('yoga-classes', 'yoga'), ('yoga-classes', 'yoga teacher'),
  ('car-service', 'car service'), ('car-service', 'car repair'),
  ('car-service', 'car mechanic'), ('car-service', 'denting painting'),
  ('bike-service', 'bike service'), ('bike-service', 'bike repair'),
  ('bike-service', 'two wheeler service'),
  ('vehicle-roadside', 'towing'), ('vehicle-roadside', 'breakdown'),
  ('vehicle-roadside', 'jump start'), ('vehicle-roadside', 'puncture'),
  ('ev-charging', 'ev charging'), ('ev-charging', 'car charging'),
  ('rental-selfdrive-car', 'self drive car'), ('rental-selfdrive-car', 'car rental'),
  ('rental-selfdrive-car', 'rent a car'), ('rental-selfdrive-car', 'zoomcar'),
  ('rental-bike', 'bike rental'), ('rental-bike', 'rent a bike'),
  ('rental-bike', 'scooter rental'),
  ('rental-camera', 'camera rental'), ('rental-camera', 'lens rental'),
  ('rental-camera', 'camera on rent'), ('rental-camera', 'dslr rent'),
  ('rental-equipment', 'equipment rental'), ('rental-equipment', 'generator rent'),
  ('rental-equipment', 'sound system rent'), ('rental-equipment', 'chairs on rent'),
  ('rental-tempo', 'tempo'), ('rental-tempo', 'truck rental'),
  ('rental-tempo', 'goods vehicle'),
  ('venue-banquet', 'banquet hall'), ('venue-banquet', 'party hall'),
  ('venue-banquet', 'function hall'),
  ('venue-wedding', 'wedding venue'), ('venue-wedding', 'kalyana mandapam'),
  ('venue-wedding', 'marriage hall'), ('venue-wedding', 'wedding lawn'),
  ('venue-conference', 'conference hall'), ('venue-conference', 'auditorium'),
  ('event-planner', 'event planner'), ('event-planner', 'wedding planner'),
  ('ca-accountant', 'ca'), ('ca-accountant', 'chartered accountant'),
  ('ca-accountant', 'accountant'), ('ca-accountant', 'tax filing'),
  ('ca-accountant', 'gst filing'),
  ('lawyer-consultation', 'lawyer'), ('lawyer-consultation', 'advocate'),
  ('lawyer-consultation', 'legal help'),
  ('financial-advisor', 'financial advisor'), ('financial-advisor', 'investment advisor'),
  ('property-visit', 'property visit'), ('property-visit', 'site visit'),
  ('property-visit', 'flat viewing'), ('property-visit', 'apartment tour'),
  ('property-inspection', 'property inspection'), ('property-inspection', 'home inspection'),
  ('coworking-desk', 'coworking'), ('coworking-desk', 'co-working'),
  ('coworking-desk', 'hot desk'), ('coworking-desk', 'shared office'),
  ('meeting-room', 'meeting room'), ('meeting-room', 'conference room'),
  ('courier-pickup', 'courier'), ('courier-pickup', 'parcel pickup'),
  ('courier-pickup', 'document pickup'),
  ('goods-transport', 'goods transport'), ('goods-transport', 'loading unloading'),
  ('exam-coaching', 'jee coaching'), ('exam-coaching', 'neet coaching'),
  ('exam-coaching', 'eamcet'), ('exam-coaching', 'upsc coaching'),
  ('exam-coaching', 'competitive exam'),
  ('skill-workshop', 'workshop'), ('skill-workshop', 'coding class'),
  ('skill-workshop', 'music class'), ('skill-workshop', 'dance class'),
  ('counselling', 'career counselling'), ('counselling', 'counsellor'),
  ('homestay-villa', 'homestay'), ('homestay-villa', 'villa booking'),
  ('homestay-villa', 'farmhouse'), ('homestay-villa', 'guest house')
) AS a(cat_slug, alias) ON c.slug = a.cat_slug
ON CONFLICT (alias_normalized) DO NOTHING;

INSERT INTO category_aliases (category_id, alias, alias_normalized, source, similarity_score)
SELECT id, canonical_name, lower(trim(canonical_name)), 'seed', 1.0
FROM service_categories
ON CONFLICT (alias_normalized) DO NOTHING;

-- ─── 8. Out-of-scope registry ────────────────────────────────────────────────
--
-- When someone asks for a flight or a passport appointment, the agent should
-- say so honestly and point them somewhere useful — not create an orphan
-- category, and not pretend it can help.
CREATE TABLE out_of_scope_categories (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug varchar UNIQUE NOT NULL,
  label varchar NOT NULL,
  reason varchar NOT NULL
    CHECK (reason IN (
      'centralised_monopoly',   -- IRCTC, BookMyShow — inventory is not obtainable
      'regulatory_prohibition', -- government slots — reselling is not permitted
      'requires_accreditation', -- flights need IATA/GDS
      'different_product'       -- food delivery is a logistics company
    )),
  explanation text NOT NULL,
  redirect_to text,             -- where the user should actually go
  match_patterns text[] NOT NULL,
  created_at timestamptz DEFAULT now()
);

INSERT INTO out_of_scope_categories
  (slug, label, reason, explanation, redirect_to, match_patterns)
VALUES
  ('train-tickets', 'Train tickets', 'centralised_monopoly',
   'Indian Railways ticketing runs entirely through IRCTC. Only authorised ' ||
   'partners can issue tickets, and Locogi is not one.',
   'IRCTC app or website, or ixigo / ConfirmTkt',
   ARRAY['train ticket','irctc','railway ticket','train booking','tatkal',
         'train seat','rail ticket']),

  ('flight-tickets', 'Flight tickets', 'requires_accreditation',
   'Airline ticketing needs IATA accreditation and GDS connectivity. ' ||
   'Locogi is built for local services, not air travel.',
   'MakeMyTrip, Cleartrip, ixigo, or the airline directly',
   ARRAY['flight','flight ticket','air ticket','plane ticket','airfare',
         'book a flight','indigo','air india','vistara']),

  ('movie-tickets', 'Movie tickets', 'centralised_monopoly',
   'Multiplex seat inventory is contracted exclusively to BookMyShow and ' ||
   'similar platforms. We cannot access real-time seat maps.',
   'BookMyShow or the cinema''s own app',
   ARRAY['movie ticket','cinema ticket','pvr','inox','book my show',
         'movie booking','film ticket','multiplex']),

  ('government-appointments', 'Government appointments', 'regulatory_prohibition',
   'Passport, visa, Aadhaar and RTO appointments must be booked directly by ' ||
   'you on the official portal. Third parties reselling these slots is how ' ||
   'touts operate, and we will not do it.',
   'Passport Seva, VFS Global, UIDAI, or your state RTO portal — all free',
   ARRAY['passport appointment','passport seva','visa appointment','vfs',
         'aadhaar appointment','aadhaar update','driving licence','rto',
         'driving test','learner licence','pan card apply','voter id']),

  ('food-delivery', 'Food delivery', 'different_product',
   'Food delivery needs a rider fleet, live order routing and packaging ' ||
   'logistics — a fundamentally different business from matching vendors.',
   'Swiggy or Zomato',
   ARRAY['food delivery','order food','deliver food','swiggy','zomato',
         'food order','biryani delivery']),

  ('bus-tickets', 'Bus tickets', 'centralised_monopoly',
   'Intercity bus inventory sits with RedBus and operator systems. We do not ' ||
   'have that connectivity.',
   'RedBus, AbhiBus, or the operator directly',
   ARRAY['bus ticket','bus booking','redbus','volvo bus','sleeper bus',
         'intercity bus']),

  ('hotel-booking', 'Hotel booking', 'centralised_monopoly',
   'Branded hotel inventory sits behind channel managers and OTA contracts. ' ||
   'We do cover independent homestays, villas and farmhouses, which are ' ||
   'genuinely fragmented.',
   'MakeMyTrip, Booking.com, or Agoda for hotels',
   ARRAY['hotel booking','book a hotel','hotel room','resort booking',
         'oyo','taj hotel','marriott']),

  ('concert-tickets', 'Concert & event tickets', 'centralised_monopoly',
   'Ticketed entertainment inventory is contracted to BookMyShow, Zomato ' ||
   'District and similar. We book venues, not seats at someone else''s event.',
   'BookMyShow or Zomato District',
   ARRAY['concert ticket','music show ticket','sports ticket','ipl ticket',
         'stand up comedy ticket','event ticket']),

  ('temple-darshan', 'Temple darshan booking', 'centralised_monopoly',
   'Major temple darshan and seva bookings run through each temple trust''s ' ||
   'own system (TTD, for instance). These are religious services where ' ||
   'mishandling causes real harm, so we do not intermediate them.',
   'The temple trust''s official website — TTD, for example, at tirupatibalaji.ap.gov.in',
   ARRAY['darshan','darshan ticket','ttd','tirupati','seva booking',
         'pooja booking','temple ticket','abhishekam']);

CREATE INDEX idx_out_of_scope_patterns ON out_of_scope_categories USING gin (match_patterns);
