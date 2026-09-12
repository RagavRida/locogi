-- ─────────────────────────────────────────────────────────────────────────────
-- GENERATED FILE — DO NOT EDIT BY HAND
--
-- Source:    src/domain/request-state.ts
-- Regenerate: npm run db:generate-state
--
-- Editing this file directly will be reverted the next time the generator
-- runs, and request-state-sql.test.ts will fail in the meantime.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. The state set ────────────────────────────────────────────────────────
-- Replaces the hand-written constraint from migration 006.
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
  CHECK (status IN ('open', 'negotiating', 'confirmed', 'in_progress', 'completed', 'expired', 'cancelled', 'no_match', 'rescheduled', 'no_show_customer', 'no_show_vendor', 'disrupted', 'waitlisted'));

-- ─── 2. The transition graph, as data ────────────────────────────────────────
-- Kept in a table rather than inlined into the trigger so that operators can
-- ask the database what the rules are ("why was that rejected?") without
-- reading application source.
CREATE TABLE IF NOT EXISTS request_state_transitions (
  from_status varchar NOT NULL,
  to_status   varchar NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

COMMENT ON TABLE request_state_transitions IS
  'Legal request status transitions. Generated from src/domain/request-state.ts '
  'by scripts/generate-state-sql.ts — do not edit rows by hand.';

-- Full replace: the graph in code is authoritative, so stale rows must go.
DELETE FROM request_state_transitions;

INSERT INTO request_state_transitions (from_status, to_status) VALUES
  ('open', 'negotiating'),
  ('open', 'confirmed'),
  ('open', 'waitlisted'),
  ('open', 'no_match'),
  ('open', 'expired'),
  ('open', 'cancelled'),
  ('negotiating', 'confirmed'),
  ('negotiating', 'waitlisted'),
  ('negotiating', 'expired'),
  ('negotiating', 'cancelled'),
  ('confirmed', 'in_progress'),
  ('confirmed', 'completed'),
  ('confirmed', 'rescheduled'),
  ('confirmed', 'no_show_customer'),
  ('confirmed', 'no_show_vendor'),
  ('confirmed', 'disrupted'),
  ('confirmed', 'cancelled'),
  ('in_progress', 'completed'),
  ('in_progress', 'cancelled'),
  ('disrupted', 'confirmed'),
  ('disrupted', 'waitlisted'),
  ('disrupted', 'expired'),
  ('disrupted', 'cancelled'),
  ('waitlisted', 'confirmed'),
  ('waitlisted', 'disrupted'),
  ('waitlisted', 'expired'),
  ('waitlisted', 'cancelled');

-- ─── 3. Enforcement ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_request_transition()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM request_state_transitions
     WHERE from_status = OLD.status
       AND to_status   = NEW.status
  ) THEN
    RAISE EXCEPTION
      'Illegal request transition: % -> % (request %)',
      OLD.status, NEW.status, OLD.id
      USING
        ERRCODE = 'check_violation',
        HINT = 'Go through RequestRepository.transition(); see '
               'src/domain/request-state.ts for the legal graph.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_request_transition ON requests;

-- The WHEN clause means this costs nothing on the many UPDATEs that touch a
-- request without changing its status (rescheduling a slot, storing an
-- embedding, sanitising a description).
CREATE TRIGGER trg_enforce_request_transition
  BEFORE UPDATE ON requests
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION enforce_request_transition();

-- ─── 4. Introspection ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW request_terminal_states AS
  SELECT s.status
    FROM unnest(ARRAY['completed', 'expired', 'cancelled', 'no_match', 'rescheduled', 'no_show_customer', 'no_show_vendor']::varchar[]) AS s(status);

COMMENT ON VIEW request_terminal_states IS
  'Request statuses with no outgoing transitions. Generated.';
