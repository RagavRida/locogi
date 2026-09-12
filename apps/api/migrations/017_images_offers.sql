-- ─── Minimal Postgres additions for Images + Offers ─────────────────────────
--
-- Rich data (images, descriptions, offer details) lives in Moss.
-- Postgres only stores what's needed for TRANSACTIONS:
--   - image_url on catalog_items (returned in API responses)
--   - offers table: minimal — just enough to validate discounts
--   - applied_offers: tracks what was used per booking
--
-- The Moss sync service pushes ALL rich content (images, offers, descriptions)
-- into Moss indexes for semantic search.

-- ─── 1. Image URLs (minimal — just a column, not a separate table) ──────────

ALTER TABLE catalog_items
  ADD COLUMN IF NOT EXISTS image_url text;

ALTER TABLE bookable_resources
  ADD COLUMN IF NOT EXISTS image_url text;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS banner_url text;

-- ─── 2. Offers (minimal for validation — rich content goes to Moss) ─────────

CREATE TABLE IF NOT EXISTS offers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Validation fields (code checks these, AI cannot override)
  offer_type varchar(20) NOT NULL CHECK (offer_type IN (
    'flat_discount', 'percent_discount', 'bogo', 'combo', 'happy_hour'
  )),
  discount_value numeric(10,2),
  discount_type varchar(10) CHECK (discount_type IN ('flat', 'percent')),
  min_order_value numeric(10,2),
  max_discount numeric(10,2),
  combo_price numeric(10,2),

  -- What it applies to
  applicable_item_ids uuid[] DEFAULT '{}',

  -- Schedule (code validates current time)
  start_date date NOT NULL DEFAULT CURRENT_DATE,
  end_date date,
  start_time time,
  end_time time,
  active_days integer[] DEFAULT '{0,1,2,3,4,5,6}',

  -- Usage limits (code enforces)
  max_uses integer,
  current_uses integer NOT NULL DEFAULT 0,
  promo_code varchar(30),

  -- Rich content synced TO Moss (stored here as source of truth)
  title varchar(200) NOT NULL,
  description text,
  image_url text,
  badge_text varchar(30),

  is_active boolean NOT NULL DEFAULT true,
  is_featured boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offers_org ON offers (organization_id) WHERE is_active = true;

-- ─── 3. Track applied offers per booking ────────────────────────────────────

CREATE TABLE IF NOT EXISTS applied_offers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL REFERENCES offers(id),
  discount_amount numeric(10,2) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, offer_id)
);

-- ─── 4. Discount tracking on requests ───────────────────────────────────────

ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS subtotal numeric(10,2),
  ADD COLUMN IF NOT EXISTS discount_total numeric(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_total numeric(10,2);
