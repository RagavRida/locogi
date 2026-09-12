/**
 * Generates the database half of the request state machine FROM the graph.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS SOLVES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * After step 3 the transition rules lived in one place in the application —
 * good — but the database still had its own hand-written copy of the state
 * list in a CHECK constraint, written by hand in migration 006. Two hand-
 * maintained lists that must agree is the exact shape of the bug step 3 set
 * out to remove; moving it from "six WHERE clauses" to "code and schema" made
 * it rarer, not impossible.
 *
 * So the schema is no longer written by hand. This script reads TRANSITIONS
 * and emits the migration. Adding a state is now:
 *
 *   1. add it to REQUEST_STATUSES in packages/types   (compiler then fails)
 *   2. add its row to TRANSITIONS                     (compiler now passes)
 *   3. npm run db:generate-state                      (schema catches up)
 *
 * Step 3 is mechanical and verified — `request-state-sql.test.ts` regenerates
 * the file and fails if the checked-in copy differs, so a forgotten step 3
 * breaks CI rather than production.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE DATABASE ENFORCES IT TOO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The repository guard protects transitions that go through the repository.
 * It cannot protect against a migration, an ops script, a psql session at 2am,
 * or a service someone adds next year that reaches for `query()` directly.
 * The application layer is where illegal transitions are *reported nicely*;
 * the database is where they are *impossible*. That is the same split already
 * used for overlapping bookings (EXCLUDE constraints) and for the race-lock.
 *
 * The trigger does NOT change the race-lock semantics. It fires only on rows
 * actually being updated, and our guarded UPDATEs never match an illegal row,
 * so a lost race still returns rowCount 0 rather than raising. The trigger
 * exists for the writer who skipped the guard entirely.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { REQUEST_STATUSES, TRANSITIONS } from '../src/domain/request-state'

const MIGRATION = '011_request_state_machine.sql'

/** Single-quote a literal for SQL. States are `[a-z_]+`, but never assume. */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function buildSql(): string {
  const states = [...REQUEST_STATUSES]

  const edges: Array<[string, string]> = []
  for (const from of states) {
    for (const to of TRANSITIONS[from]) edges.push([from, to])
  }

  const terminal = states.filter((s) => TRANSITIONS[s].length === 0)

  const stateList = states.map(lit).join(', ')
  const edgeValues = edges
    .map(([from, to]) => `  (${lit(from)}, ${lit(to)})`)
    .join(',\n')

  return `-- ─────────────────────────────────────────────────────────────────────────────
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
  CHECK (status IN (${stateList}));

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
${edgeValues};

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
    FROM unnest(ARRAY[${terminal.map(lit).join(', ')}]::varchar[]) AS s(status);

COMMENT ON VIEW request_terminal_states IS
  'Request statuses with no outgoing transitions. Generated.';
`
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const path = join(__dirname, '..', 'migrations', MIGRATION)
  const next = buildSql()

  const check = process.argv.includes('--check')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null

  if (check) {
    if (current !== next) {
      console.error(
        `❌ ${MIGRATION} is out of date with src/domain/request-state.ts.\n` +
          '   Run: npm run db:generate-state'
      )
      process.exit(1)
    }
    console.log(`✅ ${MIGRATION} matches the graph`)
    return
  }

  if (current === next) {
    console.log(`✅ ${MIGRATION} already up to date`)
    return
  }

  writeFileSync(path, next)
  const edgeCount = REQUEST_STATUSES.reduce(
    (n, s) => n + TRANSITIONS[s].length,
    0
  )
  console.log(
    `✅ wrote ${MIGRATION} — ${REQUEST_STATUSES.length} states, ${edgeCount} edges`
  )
}

if (require.main === module) main()
