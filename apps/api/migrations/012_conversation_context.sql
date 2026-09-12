-- ═══════════════════════════════════════════════════════════════════════════
-- Conversational booking retrieval: server-authoritative context + UI recall
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two additions, both driven by the same requirement: the conversation must
-- survive a refresh, a reconnect, and an app restart. Today the only place
-- that knows what the user is talking about is the mobile zustand store, which
-- is in-memory and unpersisted — closing the app loses the thread entirely.

-- ─── 1. Conversation context ────────────────────────────────────────────────
--
-- One row per user, not per conversation.
--
-- That is a deliberate consequence of this product's shape: the chat IS the
-- app. There is no conversation list, no threads, no "new chat" button — the
-- user has one continuous stream. Modelling a conversations table with exactly
-- one row per user forever would be ceremony with no payoff, and a foreign key
-- every query has to carry.
--
-- If threads are ever introduced, this becomes (user_id, conversation_id) and
-- the repository is the only code that changes.
CREATE TABLE conversation_contexts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- The entity the user is implicitly talking about. Each is nullable because
  -- context builds up over turns; a fresh user has none of it.
  active_booking_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  active_service_request_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  active_provider_id uuid REFERENCES vendors(id) ON DELETE SET NULL,

  -- ON DELETE SET NULL rather than CASCADE: losing a referenced booking should
  -- blank the pointer, never delete the user's whole conversation context.

  last_intent varchar(40),

  last_referenced_type varchar(20)
    CHECK (last_referenced_type IN ('booking','provider','quote','service_request')),
  last_referenced_id uuid,

  -- A mutation awaiting the user's "yes". Held server-side because the answer
  -- ("yes") carries no information on its own — the question it answers must
  -- be authoritative, and a client-held pending action is trivially forged.
  pending_intent varchar(40),
  pending_booking_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  -- Confirmations expire. A "yes" typed twenty minutes later, after the user
  -- has moved on, must not cancel a booking.
  pending_expires_at timestamptz,

  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE conversation_contexts IS
  'Server-authoritative conversational state. One row per user; the chat is a '
  'single continuous stream in this product.';

COMMENT ON COLUMN conversation_contexts.pending_expires_at IS
  'A pending confirmation is only valid until this moment. Past it, "yes" is '
  'treated as a fresh message rather than an answer.';

-- Sweeping expired confirmations is a cheap partial-index scan.
CREATE INDEX idx_conversation_pending_expiry
  ON conversation_contexts (pending_expires_at)
  WHERE pending_intent IS NOT NULL;

-- ─── 2. UI schema on messages ───────────────────────────────────────────────
--
-- So a rendered component can be reconstructed after a reload.
--
-- `messages.metadata` already exists and could have carried this, but it is a
-- general-purpose bag written by several unrelated flows (quote offers, system
-- notices). Putting the render contract in its own column means it can be
-- constrained, indexed, and read without guessing which writer produced the
-- row.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ui jsonb;

COMMENT ON COLUMN messages.ui IS
  'UISchema: { type, data }. Data holds IDENTIFIERS only — components re-fetch '
  'live authorized state so replayed history never shows stale prices or '
  'statuses as if current.';

-- messages.request_id is nullable, which matters here: a conversational turn
-- like "show my bookings" belongs to no single request. Nothing to change,
-- but it is load-bearing for this feature and worth stating.

-- Replaying a conversation reads newest-first for one user across all
-- requests, which nothing indexed before.
CREATE INDEX idx_messages_sender_recent
  ON messages (sender_id, created_at DESC);

-- Only rows that actually carry a component, for the replay path.
CREATE INDEX idx_messages_with_ui
  ON messages (sender_id, created_at DESC)
  WHERE ui IS NOT NULL;
