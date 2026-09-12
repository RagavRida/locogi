# Known Bugs

Found by static audit. **None of this code has ever executed**, so this list is
certainly incomplete — it is what a read-through caught, not what running it
would reveal.

---

## 🔴 BLOCKER — Split-brain slot tables

**Status:** not fixed. Needs a decision about which table wins.

### The problem

Two slot tables exist. The booking path writes to one; every downstream feature
reads the other.

```
reservation_slots   (migration 001)  ← vendor-level, older, simpler
resource_slots      (migration 005)  ← resource-level, richer, has price_override
requests.resource_slot_id  →  FK to resource_slots
```

| Code | Table it uses |
|---|---|
| `GET /vendors/:id/slots` (vendor.routes.ts:327) | `reservation_slots` |
| `BookingService.bookSlot()` | `reservation_slots` |
| `BookingLifecycleService` (reschedule, waitlist, disruption) | `resource_slots` |
| `booking-maintenance.worker` (no-show detection) | `resource_slots` |
| `TravelService.checkFeasibility()` | `resource_slots` |
| `reminder.worker` | `resource_slots` |

`BookingService.bookSlot()` **never sets `requests.resource_slot_id`**, so it
stays NULL after every appointment booking.

### Blast radius

Every feature that joins `requests.resource_slot_id → resource_slots` returns
zero rows. Silently. No error anywhere.

| Feature | Actual behaviour |
|---|---|
| Appointment reminders | Never sent |
| No-show detection | Never fires — the `no_show` path is dead |
| Reschedule | Claims the new slot, releases nothing |
| Waitlist auto-offer | Freed slots are never offered to anyone |
| Travel feasibility | **The buffer check never runs for appointments** |

A customer books, gets no reminder, no-shows, nobody is penalised, and the logs
show nothing wrong.

### Recommended fix

Consolidate on `resource_slots` — it is the richer model and the newer services
already use it. Roughly:

1. Rewrite `BookingService.bookSlot()` to operate on `resource_slots` and set
   `requests.resource_slot_id` in the same transaction
2. Rewrite `GET /vendors/:id/slots` to read `resource_slots` via
   `bookable_resources` (join on `organization_id → vendor_id`)
3. Add a migration that backfills `reservation_slots` rows into
   `resource_slots` against each vendor's `person` resource, then drops
   `reservation_slots`
4. Re-run `npm run test:race` — the slot-booking race tests currently target
   `reservation_slots` and will need updating

Estimated: half a day, mostly the backfill and re-testing.

### Why it happened

Migration 005 introduced the resource abstraction for restaurants and
hospitals. New services were wired to it. `BookingService` — written before 005
— was never migrated. Each file reviews as correct in isolation.

---

## ✅ FIXED — Migration 009 JSON operator chain

`metadata->>'categoryA'->>'name'` cannot chain — `->>` returns `text`, not
`jsonb`. Migration 009 would have failed to apply.

Fixed to `(metadata->'categoryA'->>'name')`.

---

## ⚠️ UNVERIFIED — assumptions stated as fact elsewhere in the docs

These are asserted in comments and READMEs but were never measured:

| Claim | Where | Status |
|---|---|---|
| Kondapur → LB Nagar ≈ 20 hex hops at r7 | `travel.service.ts` | Never checked against real coordinates. If wrong, every travel rejection is wrong. |
| Semantic scope threshold 0.78 catches "need to fly to Delhi" | `scope.service.ts` | Guessed. Needs tuning against real queries. |
| Matching p95 < 300ms with HNSW | `README.md` | Never benchmarked. |
| NIM free tier handles ~9 calls per vendor onboarding | design assumption | Rate limits never measured. Onboarding may throttle. |
| Hyderabad traffic speeds (18 km/h car, 22 two-wheeler) | migration 009 | Plausible, unmeasured. |

---

## 🔍 Not yet audited

The audit that found the slot split-brain covered import resolution and one
table cross-reference. It did **not** cover:

- TypeScript type errors (`tsc --noEmit` has never run)
- Whether every column referenced in SQL actually exists in a migration
- Migration ordering — whether 002–009 apply cleanly against a fresh 001
- Zod schema vs actual request body shape from the mobile app
- Whether `effective_knowledge` view's `DISTINCT ON` + `CASE` in `ORDER BY`
  is valid as written
- Mobile app: `apps/mobile` has never been type-checked or run

Expect more bugs of the same character — individually plausible code, wrong at
the seams.
