-- ─── Self-Organizing Category Taxonomy ───────────────────────────────────────
--
-- Problem: the LLM returns freeform category tags. One vendor writes
-- "drone videography", another "aerial cinematography", a third "drone shots".
-- Raw text arrays fragment the vendor pool and break matching.
--
-- Solution: a canonical category registry that grows itself. Every new vendor
-- tag is embedded and compared against existing canonical categories. Above a
-- similarity threshold it becomes an ALIAS of the existing category. Below it,
-- a NEW canonical category is created. The taxonomy self-organizes as vendors
-- join — no manual curation required.

-- ─── Canonical categories ─────────────────────────────────────────────────────
CREATE TABLE service_categories (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug varchar UNIQUE NOT NULL,            -- 'videography', 'home-electrical'
  canonical_name varchar NOT NULL,          -- 'Videography'
  description text,                         -- what this role covers
  embedding vector(1536),                   -- centroid of all member vendors
  parent_id uuid REFERENCES service_categories(id),  -- optional hierarchy

  -- Booking behaviour for this role
  default_booking_type varchar
    CHECK (default_booking_type IN ('quote','appointment','hiring','order')),
  requires_kyc boolean DEFAULT false,       -- vendor enters customer's home
  requires_gender_preference boolean DEFAULT false,  -- personal care roles

  -- Auto-derived stats
  vendor_count integer DEFAULT 0,
  request_count integer DEFAULT 0,
  avg_price integer,                        -- median accepted price
  is_verified boolean DEFAULT false,        -- admin-reviewed canonical entry

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ─── Aliases — every raw tag ever seen, mapped to a canonical category ────────
CREATE TABLE category_aliases (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id uuid REFERENCES service_categories(id) ON DELETE CASCADE,
  alias varchar NOT NULL,                   -- 'drone videography', 'aerial shots'
  alias_normalized varchar NOT NULL,        -- lowercased, trimmed
  embedding vector(1536),
  similarity_score numeric,                 -- how close it was when linked
  source varchar DEFAULT 'vendor'
    CHECK (source IN ('vendor','request','seed','admin')),
  occurrence_count integer DEFAULT 1,       -- how many times this exact tag appeared
  created_at timestamptz DEFAULT now(),
  UNIQUE(alias_normalized)
);

-- ─── Vendor ↔ category membership (replaces raw text array matching) ─────────
CREATE TABLE vendor_categories (
  vendor_id uuid REFERENCES vendors(id) ON DELETE CASCADE,
  category_id uuid REFERENCES service_categories(id) ON DELETE CASCADE,
  is_primary boolean DEFAULT false,         -- their main role
  confidence numeric,                       -- LLM/embedding confidence
  source_tag varchar,                       -- the raw tag that produced this
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (vendor_id, category_id)
);

-- ─── Request ↔ category membership ───────────────────────────────────────────
CREATE TABLE request_categories (
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,
  category_id uuid REFERENCES service_categories(id) ON DELETE CASCADE,
  confidence numeric,
  source_tag varchar,
  PRIMARY KEY (request_id, category_id)
);

-- ─── Schema learning — observe what fields each role actually uses ───────────
-- Every LLM extraction logs its attribute_schema here. When N vendors in the
-- same category converge on the same field, it graduates into the canonical
-- template for that role (see category_field_templates).
CREATE TABLE category_schema_observations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id uuid REFERENCES service_categories(id) ON DELETE CASCADE,
  field_name varchar NOT NULL,              -- 'hourly_rate', 'equipment'
  field_type varchar NOT NULL
    CHECK (field_type IN ('text','number','date','currency','list','boolean')),
  sample_value text,                        -- example, for admin review
  source varchar CHECK (source IN ('vendor','request')),
  entity_id uuid,                           -- which vendor/request produced it
  created_at timestamptz DEFAULT now()
);

-- ─── Graduated field templates per role ──────────────────────────────────────
-- Once a field is observed in >= FIELD_PROMOTION_THRESHOLD entities of the same
-- category, it becomes part of that role's canonical schema. New vendors in
-- that category get prompted for it even if they didn't mention it.
CREATE TABLE category_field_templates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id uuid REFERENCES service_categories(id) ON DELETE CASCADE,
  field_name varchar NOT NULL,
  field_type varchar NOT NULL,
  field_label varchar,                      -- 'Hourly rate' (display)
  is_required boolean DEFAULT false,
  observation_count integer DEFAULT 0,      -- how many entities used this field
  prompt_question text,                     -- 'What is your hourly rate?'
  display_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(category_id, field_name)
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX ON service_categories USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX ON category_aliases USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX idx_alias_normalized ON category_aliases (alias_normalized);
CREATE INDEX idx_vendor_categories_cat ON vendor_categories (category_id);
CREATE INDEX idx_vendor_categories_vendor ON vendor_categories (vendor_id);
CREATE INDEX idx_request_categories_cat ON request_categories (category_id);
CREATE INDEX idx_schema_obs_category ON category_schema_observations (category_id, field_name);
CREATE INDEX idx_field_templates_category ON category_field_templates (category_id);

-- ─── Seed the taxonomy with known Hyderabad service roles ────────────────────
-- These are starting points. The system will create more as vendors join.
INSERT INTO service_categories
  (slug, canonical_name, description, default_booking_type, requires_kyc,
   requires_gender_preference, is_verified)
VALUES
  ('photography', 'Photography',
   'Event, portrait, product and wedding photography',
   'quote', false, false, true),

  ('videography', 'Videography',
   'Event videography, cinematography, drone and aerial filming',
   'quote', false, false, true),

  ('home-electrical', 'Electrician',
   'Wiring, fixtures, appliance installation and electrical repair',
   'quote', true, false, true),

  ('home-plumbing', 'Plumber',
   'Leak repair, fittings, bathroom and kitchen plumbing',
   'quote', true, false, true),

  ('home-carpentry', 'Carpenter',
   'Furniture repair, modular fittings, woodwork',
   'quote', true, false, true),

  ('home-painting', 'Painter',
   'Interior and exterior painting, wall texturing',
   'quote', true, false, true),

  ('home-cleaning', 'Cleaning',
   'Deep cleaning, housekeeping, sofa and bathroom cleaning',
   'quote', true, false, true),

  ('appliance-repair', 'Appliance Repair',
   'AC, refrigerator, washing machine and TV repair',
   'quote', true, false, true),

  ('pest-control', 'Pest Control',
   'Cockroach, termite, bed bug and rodent treatment',
   'quote', true, false, true),

  ('salon-hair', 'Salon & Hair',
   'Haircut, styling, colouring, grooming',
   'appointment', false, true, true),

  ('massage-wellness', 'Massage & Wellness',
   'Therapeutic massage, spa treatments, physiotherapy',
   'appointment', true, true, true),

  ('beauty-makeup', 'Beauty & Makeup',
   'Bridal makeup, party makeup, mehendi, nail art',
   'appointment', false, true, true),

  ('auto-rickshaw', 'Auto Rickshaw',
   'Point-to-point auto rides within the city',
   'quote', false, false, true),

  ('bike-taxi', 'Bike Taxi',
   'Two-wheeler rides for single passengers',
   'quote', false, false, true),

  ('cab-taxi', 'Cab & Taxi',
   'Car rides, airport transfers, outstation trips',
   'quote', false, false, true),

  ('tutoring', 'Tutoring',
   'School subjects, competitive exams, skills coaching',
   'appointment', true, false, true),

  ('catering', 'Catering',
   'Event catering, tiffin services, party food',
   'quote', false, false, true),

  ('home-cook', 'Home Cook',
   'Daily cooking, meal prep at customer home',
   'quote', true, false, true),

  ('packers-movers', 'Packers & Movers',
   'House shifting, office relocation, transport',
   'quote', false, false, true),

  ('event-decoration', 'Event Decoration',
   'Wedding, birthday and event decor and setup',
   'quote', false, false, true),

  ('event-dj-music', 'DJ & Music',
   'DJ services, live music, sound systems',
   'quote', false, false, true),

  ('interior-design', 'Interior Design',
   'Home and office interior design and consultation',
   'quote', false, false, true),

  ('fitness-trainer', 'Fitness Trainer',
   'Personal training, yoga, home workouts',
   'appointment', true, true, true),

  ('pet-care', 'Pet Care',
   'Dog walking, grooming, pet sitting',
   'quote', true, false, true),

  ('laundry-ironing', 'Laundry & Ironing',
   'Wash, dry clean, ironing pickup and delivery',
   'order', false, false, true),

  ('computer-repair', 'Computer & Mobile Repair',
   'Laptop, desktop and mobile phone repair',
   'quote', false, false, true),

  ('tailoring', 'Tailoring',
   'Stitching, alterations, blouse and suit tailoring',
   'quote', false, true, true),

  ('security-guard', 'Security Services',
   'Security guards, event bouncers',
   'hiring', true, false, true),

  ('driver-hire', 'Driver on Hire',
   'Personal drivers, monthly driver hire',
   'hiring', true, false, true);

-- Seed aliases so common phrasings resolve immediately without an LLM call
INSERT INTO category_aliases (category_id, alias, alias_normalized, source, similarity_score)
SELECT c.id, a.alias, lower(trim(a.alias)), 'seed', 1.0
FROM service_categories c
JOIN (VALUES
  ('photography', 'photographer'),
  ('photography', 'wedding photographer'),
  ('photography', 'event photography'),
  ('photography', 'product photography'),
  ('photography', 'portrait photography'),
  ('videography', 'videographer'),
  ('videography', 'drone photography'),
  ('videography', 'aerial photography'),
  ('videography', 'drone videography'),
  ('videography', 'cinematographer'),
  ('videography', 'video editing'),
  ('home-electrical', 'electrician'),
  ('home-electrical', 'electrical work'),
  ('home-electrical', 'wiring'),
  ('home-plumbing', 'plumber'),
  ('home-plumbing', 'plumbing'),
  ('home-carpentry', 'carpenter'),
  ('home-carpentry', 'carpentry'),
  ('home-carpentry', 'furniture repair'),
  ('home-painting', 'painter'),
  ('home-painting', 'painting'),
  ('home-painting', 'wall painting'),
  ('home-cleaning', 'cleaning'),
  ('home-cleaning', 'deep cleaning'),
  ('home-cleaning', 'house cleaning'),
  ('home-cleaning', 'housekeeping'),
  ('home-cleaning', 'maid'),
  ('appliance-repair', 'ac repair'),
  ('appliance-repair', 'ac service'),
  ('appliance-repair', 'fridge repair'),
  ('appliance-repair', 'washing machine repair'),
  ('appliance-repair', 'appliance repair'),
  ('pest-control', 'pest control'),
  ('salon-hair', 'salon'),
  ('salon-hair', 'haircut'),
  ('salon-hair', 'barber'),
  ('salon-hair', 'hair stylist'),
  ('massage-wellness', 'massage'),
  ('massage-wellness', 'spa'),
  ('massage-wellness', 'massage therapist'),
  ('massage-wellness', 'physiotherapy'),
  ('beauty-makeup', 'makeup artist'),
  ('beauty-makeup', 'bridal makeup'),
  ('beauty-makeup', 'mehendi'),
  ('beauty-makeup', 'beautician'),
  ('auto-rickshaw', 'auto'),
  ('auto-rickshaw', 'auto rickshaw'),
  ('auto-rickshaw', 'auto driver'),
  ('bike-taxi', 'bike ride'),
  ('bike-taxi', 'bike taxi'),
  ('bike-taxi', 'two wheeler'),
  ('cab-taxi', 'cab'),
  ('cab-taxi', 'taxi'),
  ('cab-taxi', 'car ride'),
  ('tutoring', 'tutor'),
  ('tutoring', 'tuition'),
  ('tutoring', 'teacher'),
  ('tutoring', 'coaching'),
  ('catering', 'caterer'),
  ('catering', 'catering'),
  ('catering', 'tiffin service'),
  ('home-cook', 'cook'),
  ('home-cook', 'home cook'),
  ('home-cook', 'chef'),
  ('packers-movers', 'packers and movers'),
  ('packers-movers', 'house shifting'),
  ('packers-movers', 'movers'),
  ('event-decoration', 'decorator'),
  ('event-decoration', 'event decoration'),
  ('event-decoration', 'flower decoration'),
  ('event-dj-music', 'dj'),
  ('event-dj-music', 'sound system'),
  ('interior-design', 'interior designer'),
  ('interior-design', 'interior design'),
  ('fitness-trainer', 'gym trainer'),
  ('fitness-trainer', 'personal trainer'),
  ('fitness-trainer', 'yoga instructor'),
  ('pet-care', 'dog walker'),
  ('pet-care', 'pet grooming'),
  ('laundry-ironing', 'laundry'),
  ('laundry-ironing', 'dry cleaning'),
  ('laundry-ironing', 'ironing'),
  ('computer-repair', 'laptop repair'),
  ('computer-repair', 'mobile repair'),
  ('computer-repair', 'computer repair'),
  ('tailoring', 'tailor'),
  ('tailoring', 'stitching'),
  ('tailoring', 'boutique'),
  ('security-guard', 'security guard'),
  ('security-guard', 'watchman'),
  ('driver-hire', 'driver'),
  ('driver-hire', 'car driver')
) AS a(cat_slug, alias) ON c.slug = a.cat_slug
ON CONFLICT (alias_normalized) DO NOTHING;

-- Also register each canonical name as its own alias
INSERT INTO category_aliases (category_id, alias, alias_normalized, source, similarity_score)
SELECT id, canonical_name, lower(trim(canonical_name)), 'seed', 1.0
FROM service_categories
ON CONFLICT (alias_normalized) DO NOTHING;
