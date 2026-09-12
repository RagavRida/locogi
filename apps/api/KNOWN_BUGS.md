# Known Bugs & Unverified Assumptions

Last updated after **step 2** of the incremental refactor.

---

## Status of "nothing has ever run"

This section used to say the codebase had never been installed, compiled, or
tested. That is no longer true. Current reality:

| Check | Status | Notes |
|---|---|---|
| `npm install` | ✅ passes | required bumping `redis` ^4 → ^5 (bullmq peer conflict) |
| `tsc --noEmit` | ✅ **0 errors** | was 51 on first run |
| `vitest` — medical-safety | ✅ **54/54 pass** | runs against the emergency FLOOR (no DB) |
| `vitest` — race-lock | ⛔ **cannot run here** | needs a live Postgres |
| migrations 001–010 | ⛔ **never applied** | needs a live Postgres |

### Why race-lock cannot run in this environment

It is not a code failure. The sandbox egress firewall permits **HTTP/HTTPS
only** — Postgres wire protocol on 5432 is blocked, and there is no local
Postgres or Docker available. The test fails with
`Client network socket disconnected before secure TLS connection was
established` at pool connect, before any assertion executes.

**This is the single largest remaining risk in the project.** The race-lock is
the guarantee that two vendors cannot both win one request, and it has never
been executed against a real database. Run it first on any machine with
Postgres reachable:

```bash
psql "$DATABASE_URL" -c 'select 1'   # prove connectivity first
npm run db:migrate                    # applies 001..010 in order
npm run test:race
```

---

## Real bugs found by actually compiling and running (step 2)

These were all latent — invisible to reading, immediate on execution.

1. **`withTransaction` typed its client as `void`.**
   `fn: (client: Awaited<ReturnType<typeof db.connect>>)` — `db.connect` is
   overloaded and `ReturnType` selected the *callback* overload, which returns
   `void`. Every `client` inside every transaction in the codebase was typed
   `void`. This alone produced ~30 of the 51 errors. Fixed by naming
   `PoolClient` directly.

2. **`nim.ts` constructed its OpenAI client at import time.**
   Any module transitively importing it needed `NIM_API_KEY` merely to *load*
   — including `safety-ruleset.ts`, whose entire design premise is that it
   never touches the network. This made the safety tests unrunnable without a
   live API key. Now lazily constructed with a clear error at point of use.

3. **Self-harm was routed to the ambulance message.** ⚠️ safety
   Every floor pattern shared one `FLOOR_RESPONSE` leading with "call 108
   (ambulance)". Someone typing "I want to kill myself" got a referral to the
   wrong service. Now has a dedicated `SELF_HARM_RESPONSE` leading with
   Tele-MANAS 14416 and AASRA 9152987821. The DB path's fallback was made
   label-aware too, so the gap cannot reopen via configuration.
   *The test asserting this was already written and had simply never been run.*

4. **`POST /knowledge/assert` accepted assertions with no value.**
   `z.unknown()` infers as **optional**, so `...parsed.data` type-checked while
   permitting `value: undefined`. Admin is the highest source tier, so this
   would write empty knowledge that outranks learned facts. Now rejected with
   400.

5. **N+1 in the no-show detector.** `booking-maintenance.worker` resolved a
   vendor's user_id inside a `for` loop over up to 100 stale bookings — up to
   100 sequential round-trips per tick. Replaced with one bulk lookup.

6. **`redis` ^4 vs `bullmq` peer range.** `npm install` failed outright.
   Bumped to ^5; only `get/set/del/incr/expire` are used and those are
   unchanged across the major.

---

## Step 3 — the request state machine

The transition rules are no longer written per call site. `src/domain/request-state.ts`
holds the graph; every guard is derived from it, and the schema is **generated**
from it by `scripts/generate-state-sql.ts` into `migrations/011`.

### What the audit found

- **Two cancel sites disagreed.** Account deletion allowed cancelling an
  `in_progress` request; the per-request cancel did not. Nothing could say
  which was right.
- **`advanceStage` was stricter than the route it served.** Its private map
  allowed `completed` only from `in_progress`, while confirm-attended allowed
  it from `confirmed` too. Short jobs (a haircut, a delivery) never pass
  through `in_progress`, so valid completions were being silently rejected.
- **Two recurring-series sites disagreed.** Pausing skipped only `confirmed`
  occurrences; cancelling killed `confirmed` and `open`.
- **Five transitions had no guard at all** — no-show reporting, waitlist join,
  waitlist claim, rental booking, reschedule. Each could drag a completed or
  cancelled request back into a live state.
- **A read/write pair in account deletion could diverge.** A hardcoded SELECT
  chose which requests to mark responses `missed` for, then a differently
  hardcoded UPDATE cancelled them. Collapsed into one `RETURNING` statement,
  which also closes the TOCTOU window between them.

### Still unverified

⚠️ **`migrations/011` has never been executed.** It is generated and its
*content* is asserted by tests, but no database has parsed it. The trigger
function and the view are the parts most likely to hold a syntax error. Apply
it first on any machine with Postgres reachable, before trusting it.

---

## Step 4 — typed contracts for model calls

Every LLM call now goes through `src/ai/contract.ts`. Prompts, schemas and
policy live per-task in `src/ai/tasks/`.

**Scope decision, stated plainly:** spec section 5 describes a tool-calling
agent (`bookProvider()`, `createPayment()`, …). That was NOT built, because no
model in this system chooses what happens next — the flows are deterministic
and the model is a sub-step that reads text and returns structure. Giving it
tool authority would contradict section 4, which spends its length saying the
LLM must not be trusted for prices, provider selection, or database mutations.
What section 5 requires *underneath* the agent framing — input schema, output
schema, validation, timeout, retry, audit logging, error handling — did not
exist and now does.

### What the audit found

- **No timeout on four of five model calls.** Only the customer extraction
  route had one, as a `Promise.race` in the route. The vendor route called the
  same function with none, so a hung NIM request held that connection until
  the socket died.
- **Two racing 15s deadlines** once the task grew its own: the route could
  return 503 while the task was still retrying, burning quota invisibly.
- **Four hand-rolled copies** of strip-fence → `JSON.parse` → validate, each
  slightly different. None handled a leading `"Here is the JSON:"`, which is
  the most common real failure.
- **`JSON.parse` on unvalidated model output**, in a `try` whose only outcome
  was a silent heuristic fallback — indistinguishable in the logs from the
  model being down.
- **No retry.** One malformed reply meant permanent fallback for that request.
- **No audit trail.** `agentChat` returned only `choices[0]`, discarding
  `usage`, so no call's token cost was ever recorded.
- **Prompt injection surface (section 17).** User and vendor text was
  interpolated as bare instructions. Two paths were worse than the obvious
  one: vendor-authored field samples fed the question generator, whose output
  is *persisted and shown to customers*; and user-authored request samples fed
  the scope-boundary proposer, which writes rows that tell users "we don't do
  that".
- **The model proposes executable code.** `review_safety` returns a regex that,
  once approved, is compiled at boot and run against every message on the
  pre-rate-limit safety path. The old check verified only that it compiled.
  It now also rejects nested quantifiers (catastrophic backtracking — a DoS
  against the emergency check itself), patterns matching the empty string, and
  over-long patterns.

### Still unverified

⚠️ Prompt *quality* is untested. The contracts guarantee shape, timeout and
retry; they say nothing about whether the model classifies well. Every test
here mocks the model deliberately. Section 22's "ambiguous requests" case
needs a live evaluation set against real NIM, which has never been run.

---

## Conversational booking retrieval

Natural-language questions about existing bookings, with server-chosen UI.

### What it reuses rather than rebuilds

- **No Booking entity was created.** A booking IS a `request` in a committed
  state. A parallel table would have forked the domain — two ids per job, two
  lifecycles, two authorization paths.
- Cancellation goes through `requestRepo.cancelWithinWindow`, so the state
  graph and the 5-minute window are enforced once, not twice.
- Rescheduling calls the existing `BookingLifecycleService`.
- The LLM call runs on the step-4 contract layer, inheriting its timeout,
  retry, audit logging and injection containment.
- The existing 11 card types were kept verbatim and extended; `CardType` now
  aliases the shared `UIComponentType` so client and server cannot disagree.
- `/requests/extract` is untouched. `/chat` returns `handled: false` for
  anything that isn't a booking question and the original flow runs.

### Security properties, and where they are enforced

- The model's `bookingId` is a **claim, never a lookup key**. It selects from a
  candidate list the caller already scoped to the authenticated user
  (`booking-resolution.ts` line ~161). It is never passed to a query — verified
  by grep and by test.
- Ownership lives **inside the SQL** (`WHERE r.id = $1 AND r.customer_id = $2`),
  not as a fetch-then-compare a future edit could drop.
- Another user's id and a nonexistent id return **identical** answers, so the
  endpoint is not an enumeration oracle.
- Destructive actions require an explicit in-window confirmation, consumed by a
  conditional `UPDATE ... RETURNING` so a double-tapped "yes" cannot cancel
  twice.

### Judgement calls worth knowing about

- **"Yes"/"no" is matched deterministically, not by the LLM.** Same argument as
  emergency detection: a timeout must not swallow the answer to a question we
  just asked, and a model reading "no, don't" as consent destroys a booking. An
  unrecognised reply disarms the pending action rather than assuming consent.
- **The resolution ladder is ordered, not scored.** A weighted score would let
  two weak signals outvote an explicitly named booking.
- **Never "the soonest of several".** With three upcoming bookings, "where is
  my booking?" genuinely does not name one, so it asks.
- **UI payloads carry ids, not snapshots.** A persisted `status: CONFIRMED`
  becomes a lie when the booking changes, and scrolling back would present it
  as current.

### Still unverified

⚠️ **Migration 012 has never been executed**, like 010 and 011 — no database
has parsed it.

⚠️ **Intent-detection quality is untested against a live model.** All 71 tests
for this feature mock it. Whether the model reliably separates "where is my
booking" (details) from "where is my photographer" (physical location) needs a
real evaluation set.

⚠️ **Tracking ETA uses straight-line distance ÷ 18 km/h.** The card labels it
as an estimate, but the speed constant is the same unverified assumption
TravelService carries.

---

## Phase 1 — API versioning (done)

Dual-mounted: `/api/v1/*` and the original bare paths, both live. Handlers
untouched — only registration moved.

**Found while doing it:** `src/index.ts` ran `bootstrap()` as a module side
effect, so importing it to inspect routes booted the whole server — DB
connect, workers, socket bind. The versioning test surfaced it as a stray
`db.end is not a function` at teardown. Composition now lives in `src/app.ts`
with no side effects; `index.ts` is purely the entrypoint.

**Retirement is evidence-based, not date-based.** Every unversioned hit logs a
warning with path and user-agent. Delete the legacy mount when that stops
appearing, not when the Sunset date passes.

---

## Phase 2 — weighted matching (done)

Semantic similarity kept as the largest single signal; distance, load,
reliability, response behaviour and (optional) price layered on top.
`src/domain/vendor-ranking.ts` is pure and has 33 tests including an
old-vs-new comparison suite.

### Two things found while building it

**`vendors.response_rate` is dead schema.** It has existed since migration 001
and **nothing has ever written to it** — it is 0 for every vendor. Weighting it
would have added a ranking factor that looks meaningful and contributes a
constant. Migration 013 adds a `vendor_response_stats` view deriving it from
`request_responses` instead. Declining counts as responding: it frees the
customer immediately, which is much better behaviour than silence.

**Widening the pool nearly caused notification spam.** All seven queries did
`LIMIT 5` in SQL, so reranking would have been theatre — the better candidate
was discarded by Postgres before the ranker saw them. Widening to 30 fixed
that, but `rematch()` returned its pool raw to `expiry.worker`, which
push-notifies everything it receives. That would have notified 30 vendors
instead of 5. All seven pools now rank-and-trim; there is a grep in the
verification that asserts pools == rank calls.

### Design decisions worth knowing

- **Missing signals are excluded, not scored zero.** Weights renormalise over
  whatever is actually known per vendor. Scoring an absent signal 0 means
  "worst possible", which would permanently bury every new vendor for having
  no reviews yet.
- **Ratings are shrunk toward a prior.** One 5-star review must not outrank
  fifty averaging 4.8.
- **`is_priority` stays a hard partition, not a weighted term.** It is a
  commercial commitment; folding it into the score would let a nearer
  competitor quietly cost someone their paid placement. Ranking runs *within*
  each priority group.
- **Price weight defaults to 0.** No vendor price list exists before a quote,
  and ranking local services by price selects for corner-cutting.
- **Weights live in `ranking_weights`** with a code-level fallback. Failure to
  read the table falls back to defaults, never to "no ranking".

### Still unverified

⚠️ **The weights are a considered guess, not a measurement.** Nothing has
ranked real traffic. The numbers are tunable without a deploy precisely
because they are expected to be wrong at first.

⚠️ **Migration 013 has never been executed** (like 010–012).

⚠️ The enrichment query adds a per-match round trip over ≤30 vendors. Not
profiled against a real dataset.

---

## Phase 3 — WebSockets (done)

Delivery mechanism only. Postgres stays the source of truth, the outbox stays
the event backbone, and the 13-state machine is untouched.

### The design rule everything follows from

**A realtime message is a nudge, never state.** It says "booking X changed";
the client refetches through the normal authorized API. Three reasons:
delivery is not guaranteed, a payload describes the past by the time it
renders, and authorization is already enforced on the REST read.

That is also what makes reconnection trivial — there is no missed-event
problem, no replay cursor, no sequence numbers. A client offline for an hour
refetches and is correct.

### Cross-instance correctness

A socket lives in ONE process; the outbox worker may run in another. Every
publish goes through **Redis pub/sub** and comes back to the origin instance
like everyone else. Publishing locally *as well* would double-deliver whenever
publisher and subscriber shared an instance — a bug invisible on a
single-instance dev box. There is a test asserting publish does **not** send
locally.

The subscriber is `redis.duplicate()`: node-redis puts a connection into
subscriber mode exclusively, so sharing the main client would break every
rate-limit check and OTP read in the process.

### Authorization, in two places

- **On subscribe** — ownership checked in SQL before the subscription is
  recorded.
- **On publish** — the audience is resolved from the database, and the hub
  delivers only to users in it.

Both are needed. A subscription outlives the check that created it, and a
receiving instance cannot re-check without a query per delivery. There is a
test proving a client subscribed to a *guessed* booking id receives nothing.

### PROVIDER_EN_ROUTE / ARRIVED — tracking sub-states, not booking states

On `live_locations` (migration 014), not `requests.status`. A booking is
`confirmed` for the entire time the phase changes; request states are durable
facts while a phase is a claim a phone made ninety seconds ago. Adding them to
the state machine would mean new edges through the trigger-enforced graph for
data that expires.

`tracking_events` is an append-only history, because `live_locations` is one
mutable row and overwrites the sequence — and that sequence is the evidence
that settles "the provider says they arrived, the customer says nobody came".
It records **distance from the job at the moment of the claim**, so an
"arrived" pressed from 4km away is visible.

### Polling

The tracking card's 20s poll is now a **120s fallback** for when the socket is
down or the network blocks WebSockets. Not removed — degraded gracefully.

### Still unverified

⚠️ **No integration test against a real socket.** The hub has 26 tests against
fakes covering fan-out, leaks, authorization and reaping; the *route* — the
handshake, token-in-query auth, ping/pong — has never run against a real
WebSocket connection.

⚠️ **Migration 014 has never been executed** (like 010–013).

⚠️ Token travels in the query string, because the browser/RN WebSocket API
cannot set handshake headers. Query strings reach access logs more readily
than headers do. Mitigated by these being short-lived access tokens, never
refresh tokens.

---

## Correlation IDs (done)

Answers "why did this customer's booking fail?" — previously unanswerable,
because ~196 log statements each carried whichever ids their author happened
to have in scope, with nothing joining them.

### Zero call sites edited

`AsyncLocalStorage` + pino's `mixin` hook. Every existing `logger.info(...)`
gained a correlation id, userId, requestId and bookingId without one of them
being touched — and, more importantly, without the next person having to
remember.

The alternative — threading a context parameter through every service and
repository — is hundreds of signature changes, and it is contagious: one
un-threaded function silently breaks the chain.

### Where ALS does NOT reach, and what carries the id instead

ALS follows awaits inside one process. It does not survive a database commit,
a BullMQ job, or a Redis hop — which is exactly where work becomes invisible
and a trace is worth most.

- `outbox_events.correlation_id` (migration 015); the worker reads it off the
  row and re-establishes context, so "chat message → booking → push" is one
  journey rather than two unrelated sets of log lines.
- `events.correlation_id`, so a trace survives **log retention**. Logs last
  weeks; disputes surface after months.

### enqueueOutbox() instead of four edited INSERTs

There were four `INSERT INTO outbox_events` sites. Editing all four is a fix
that lasts until the fifth is written — by someone who has not read this file,
who would get a working event and a silently broken trace. All four now go
through `lib/outbox.ts`, which stamps the id. A grep in verification asserts
zero raw inserts remain.

### Inbound ids are untrusted

A client-supplied id is echoed only if it matches `[A-Za-z0-9_\-.]{8,128}`.
Without that, a caller could put a newline in the header and forge log
entries for the whole request — or send 100KB and have it repeated on every
log line.

### The hook is `onRequest`, deliberately

The earliest point Fastify offers. Any later and auth failures and rate-limit
rejections would be untraceable — exactly the ones people ask about. Tested.

### Client side

`ApiError.correlationId` is read from the response header, so a user reporting
a problem can quote one string that finds the whole server-side trace.

### Still unverified

⚠️ **Migration 015 has never been executed** (like 010–014).

⚠️ No distributed tracing (OpenTelemetry) — this is log correlation only.
Enough to answer "what happened to this booking", not "which span was slow".

---

## Deliberately left alone

Two `SELECT id FROM vendors WHERE user_id = $2` occurrences remain outside the
repository layer:

- `lifecycle.routes.ts` — inside the `confirm-attended` UPDATE
- `booking-lifecycle.service.ts` — inside a larger authorization predicate

Both are **subqueries within a single larger statement**, not standalone
lookups. Extracting them would mean two round-trips where there is now one, and
would break the atomicity of the enclosing statement. They are dealt with in
**step 3**, when those direct `status = '...'` writes move behind the state
machine.

---

## Unverified assumptions (unchanged — all need production data)

1. **H3 hex distance ≈ real road distance.** `gridDistance × 1.22km × 1.35`
   winding factor. Untested against a real Kondapur → LB Nagar trip.
2. **0.78 scope threshold.** The intent gate's cutoff is a guess.
3. **p95 < 300ms matching.** Never measured; no load test exists.
4. **NIM free-tier rate limits.** Unknown ceiling; no backpressure designed.
5. **Hyderabad traffic speeds.** 18 km/h for cars is deliberately pessimistic
   but arbitrary.
