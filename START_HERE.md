# Start here

Everything in this archive typechecks and its tests pass. Nothing has ever
touched a real database — that is the first thing to fix, and the steps below
are in the order that surfaces problems earliest.

## 1. Credentials

`apps/api/.env` is **deliberately not in this zip**. Copy `.env.example` to
`apps/api/.env` and fill it in.

> **Rotate the keys you shared in chat before using them.** The NVIDIA NIM key,
> Telegram bot token, Supabase service-role key, Upstash token and Firebase
> private key were all pasted into a conversation. Generate new ones from each
> dashboard and treat the old ones as public.

## 2. Install

```bash
cd packages/types && npm install && npx tsc   # build first — the apps import its .d.ts
cd ../../apps/api  && npm install
cd ../mobile       && npm install --legacy-peer-deps
```

`packages/types` must be built before either app typechecks: both resolve
`@locogi/types` to its `dist/index.d.ts`.

## 3. Verify without a database

```bash
cd apps/api
npx tsc --noEmit         # expect 0
npx vitest run           # expect all green except race-lock (needs Postgres)
npm run db:check-state   # migration 011 must match the state graph
```

## 4. Then the database

```bash
psql "$DATABASE_URL" -c 'select 1'   # prove connectivity BEFORE migrating
npm run db:migrate                    # applies 001..012 in order
npm run test:race                     # the test that has never run
```

Migrations **010 through 015 have never been executed.** Between them they
create a trigger function, three views, three tables and a dozen indexes —
the most likely places for a syntax error. Apply them somewhere disposable
first.

## 5. Read this before trusting anything

`KNOWN_BUGS.md` is honest about what is verified and what is not, including the
bugs found by actually compiling the code for the first time. Read it before
planning a launch.

---

## Phases 1–3 (phase 4, payments, is NOT built)

| Phase | What landed |
|---|---|
| 1 — API versioning | `/api/v1/*` and bare paths both served; legacy mount logs every hit |
| 2 — Weighted matching | Distance, load, reliability, response rate layered over semantics |
| 3 — WebSockets | `GET /ws`, Redis fan-out, tracking phases |
| 4 — Payments | **not started** |
| Correlation IDs | Every log line, across workers and processes |

### Realtime

`GET /ws?token=<accessToken>` — deliberately **unversioned** (a long-lived
socket is not a REST resource). Auth is the same JWT plus the ban check;
the token is in the query string because the WebSocket API cannot set
handshake headers.

Messages are **nudges, never state**: `{type:'booking.changed', topic, ts}`.
The client refetches through the normal API. That is why reconnection needs no
replay buffer.

Cross-instance delivery goes through Redis pub/sub, so it works with more than
one API process. Without Redis it degrades to local-only delivery rather than
failing.

### Tracking phases

`POST /api/v1/bookings/:id/phase` with `en_route` / `arrived` / `in_progress` /
`finished`. These are **not** request statuses — the 13-state machine is
untouched. They live on `live_locations`, with an append-only `tracking_events`
history that records how far from the job the provider was when they claimed
it.

### Tracing a problem

Every response carries `X-Correlation-Id`. Ask a user for it, then:

```
grep 'cor_abc123' logs          # the whole journey, in order
```

```sql
-- Survives log retention; disputes surface months later
SELECT * FROM outbox_events WHERE correlation_id = 'cor_abc123';
SELECT * FROM events        WHERE correlation_id = 'cor_abc123';
```

It reaches across the commit boundary: the outbox worker re-establishes
context from the row, so "chat message → booking → push notification" is one
searchable id, not three unrelated sets of log lines.

Logging needs no changes — pino's `mixin` attaches the context to every
`logger.*` call automatically. Adding a new outbox event does need
`enqueueOutbox()` from `lib/outbox.ts` rather than a raw INSERT, or the trace
stops there.

### Tuning the matching weights

```sql
UPDATE ranking_weights SET distance = 0.35, semantic = 0.25 WHERE profile = 'default';
```

Takes effect within 60s, no deploy. Weights need not sum to 1 — the ranker
renormalises over whichever signals each vendor actually has.

## What changed most recently

| Area | Change |
|---|---|
| `redis` | bumped ^4 → ^5; `bullmq` refuses to install otherwise |
| `src/domain/request-state.ts` | the request lifecycle as one graph; every status guard derives from it |
| `migrations/011` | **generated** from that graph — `npm run db:generate-state`, never edit by hand |
| `src/ai/` | every model call behind a typed contract with timeout, retry, audit logging |
| `src/domain/booking-resolution.ts` | which booking "cancel it" means — pure, and the most-tested file here |
| `POST /chat` | conversational booking retrieval; returns `handled: false` for anything else |
| `apps/mobile/src/components/registry.tsx` | server-chosen components, closed set, unknown types render nothing |

## API versioning

Every route is served on **two mounts**:

| Mount | Status |
|---|---|
| `/api/v1/...` | current — use this |
| `/...` | deprecated, still served |

The legacy mount sets `Deprecation: true`, a `Sunset` date, and a `Link` header
pointing at the successor — and logs a **warning on every hit**. That log is
the retirement signal: when it goes quiet, delete the `legacy` block in
`src/app.ts`. Don't remove it on a date; remove it on evidence.

`/healthz` is deliberately **not** versioned. Liveness probes live in
infrastructure config that knows nothing about API versions, and moving the
path with an API bump is how a deploy breaks its own health check.

`src/app.ts` holds route composition with no side effects; `src/index.ts` is
the entrypoint that connects, migrates, starts workers and listens. Importing
`app.ts` in a test does not boot a server — that split was forced by the
versioning tests, which were silently booting one.

## The two commands worth remembering

```bash
npm run db:generate-state   # after ANY edit to the state graph
npm run db:check-state      # CI guard; fails if the migration drifted
```
