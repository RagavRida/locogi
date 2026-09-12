-- ═══════════════════════════════════════════════════════════════════════════
-- Correlation id on outbox events
-- ═══════════════════════════════════════════════════════════════════════════
--
-- AsyncLocalStorage carries the correlation id automatically across awaits
-- inside one operation. It does NOT survive a database commit.
--
-- That gap is where traces matter most. The interesting failures are almost
-- never in the HTTP handler — they are in what happened afterwards: the push
-- that never arrived, the waitlist offer that went to the wrong person, the
-- payment webhook that arrived twice. All of that runs in the outbox worker,
-- minutes later, possibly in another process, with no memory of the request
-- that caused it.
--
-- So the id is carried as data. The worker reads it off the row and
-- re-establishes context, and the whole journey — chat message through to
-- push notification — shares one id.

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS correlation_id varchar(140);

COMMENT ON COLUMN outbox_events.correlation_id IS
  'The correlation id of the operation that enqueued this event. Read by the '
  'outbox worker to re-establish log context across the commit boundary, '
  'where AsyncLocalStorage cannot reach.';

-- Finding every event belonging to one journey is the whole point; without an
-- index that is a sequential scan of a table designed to grow forever.
CREATE INDEX IF NOT EXISTS idx_outbox_correlation
  ON outbox_events (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- ─── The same thread through the durable record ─────────────────────────────
--
-- `events` is the append-only audit trail the ops queue and the no-show
-- detector read. Stamping it too means a trace can be reconstructed from the
-- DATABASE, not only from logs — which matters because logs are retained for
-- weeks and disputes surface after months.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS correlation_id varchar(140);

CREATE INDEX IF NOT EXISTS idx_events_correlation
  ON events (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON COLUMN events.correlation_id IS
  'Links this audit row to the operation that produced it. Survives log '
  'retention, which matters when a dispute is raised months later.';
