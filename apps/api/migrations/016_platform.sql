-- ─── Platform Foundation ─────────────────────────────────────────────────────
--
-- Turns Locogi from a consumer app into a booking/ordering ENGINE that
-- businesses integrate into their own channels.
--
-- Three new tables:
--   1. org_api_keys   — per-org API keys for B2B integration
--   2. webhook_subscriptions — what events each org wants to receive
--   3. webhook_deliveries    — delivery log with retry tracking
--
-- Design decisions:
--   - API keys are scoped to organizations, not users. A salon's Shopify
--     plugin shouldn't break when an employee leaves.
--   - Keys have a prefix (`lok_live_` / `lok_test_`) so they're visually
--     distinguishable and grep-able in logs.
--   - Webhook signatures use HMAC-SHA256 so the business can verify it's
--     from Locogi, not a replay attack.

-- ─── 1. Org API Keys ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_api_keys (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The key itself. Stored hashed (SHA-256) so a DB leak doesn't
  -- compromise every integration. The raw key is shown once at creation.
  key_hash varchar(128) NOT NULL UNIQUE,

  -- Human-readable prefix for the key, stored unhashed for display
  -- e.g. "lok_live_a3f9..." → prefix "lok_live_a3f9"
  key_prefix varchar(20) NOT NULL,

  -- Live keys hit the real booking engine; test keys return sandbox data
  environment varchar(10) NOT NULL DEFAULT 'live'
    CHECK (environment IN ('live', 'test')),

  label varchar(120),  -- "Shopify plugin", "WhatsApp bot", etc.

  -- Permission scopes (which endpoints this key can call)
  scopes text[] NOT NULL DEFAULT ARRAY[
    'bookings:read', 'bookings:write',
    'catalog:read', 'catalog:write',
    'resources:read',
    'availability:read',
    'webhooks:manage'
  ],

  -- Rate limiting
  rate_limit_per_minute integer NOT NULL DEFAULT 120,

  -- Lifecycle
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  expires_at timestamptz,  -- null = never expires
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_org_api_keys_org ON org_api_keys (organization_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_org_api_keys_hash ON org_api_keys (key_hash) WHERE is_active = true;

-- ─── 2. Webhook Subscriptions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The URL we POST to
  url varchar(2000) NOT NULL,

  -- Which events to deliver
  events text[] NOT NULL DEFAULT ARRAY[
    'booking.created',
    'booking.confirmed',
    'booking.cancelled',
    'booking.completed',
    'booking.rescheduled',
    'order.placed',
    'order.ready',
    'order.picked_up',
    'payment.received',
    'payment.refunded'
  ],

  -- HMAC secret for signature verification (generated at creation)
  signing_secret varchar(128) NOT NULL,

  -- Lifecycle
  is_active boolean NOT NULL DEFAULT true,
  description varchar(200),

  -- Health tracking
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_delivery_at timestamptz,
  last_failure_at timestamptz,
  -- Auto-disable after 50 consecutive failures
  disabled_at timestamptz,
  disabled_reason varchar(200),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_subs_org ON webhook_subscriptions (organization_id)
  WHERE is_active = true;

-- ─── 3. Webhook Deliveries ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,

  -- What was sent
  event_type varchar(60) NOT NULL,
  payload jsonb NOT NULL,

  -- Delivery status
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'dead_lettered')),

  -- Response tracking
  http_status integer,
  response_body text,
  response_time_ms integer,
  error_message text,

  -- Retry
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_retry_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending ON webhook_deliveries (next_retry_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub ON webhook_deliveries (subscription_id, created_at DESC);

-- ─── 4. Allowed widget origins per org ───────────────────────────────────────
-- Which domains the embeddable widget can load on (CORS whitelist)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS widget_origins text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS branding jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS platform_fee_percent numeric(5,2) DEFAULT 2.5,
  ADD COLUMN IF NOT EXISTS cancellation_policy varchar(20) DEFAULT 'flexible'
    CHECK (cancellation_policy IS NULL OR cancellation_policy IN (
      'flexible',      -- full refund up to 24h before
      'moderate',      -- full refund up to 5 days before
      'strict',        -- 50% refund up to 7 days before
      'non_refundable' -- no refund
    ));

-- ─── 5. Platform event types we track in the outbox ──────────────────────────
-- The outbox already exists; we just need to recognise more event types.
-- No schema change needed — event_type is a free-form varchar.

COMMENT ON TABLE org_api_keys IS
  'Per-organization API keys for B2B platform integrations. Keys are stored hashed.';
COMMENT ON TABLE webhook_subscriptions IS
  'Webhook endpoints registered by businesses to receive booking/order event callbacks.';
COMMENT ON TABLE webhook_deliveries IS
  'Delivery log and retry queue for webhook POST requests.';
