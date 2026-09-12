-- ═══════════════════════════════════════════════════════════════════════════
-- Telegram user mapping
-- ═══════════════════════════════════════════════════════════════════════════
-- Maps Telegram chat IDs to Locogi user IDs so each Telegram user gets
-- a consistent identity across sessions.

CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_id bigint PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name varchar(100),
  username varchar(100),
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_users_user
  ON telegram_users (user_id);
