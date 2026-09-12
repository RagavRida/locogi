# Locogi Ops Runbook

Locogi's behaviour comes from learned knowledge, not hardcoded rules. That is
mostly good — the taxonomy self-organises, questions come from real vendor
behaviour, geography grows into whatever users actually type.

It has one specific cost, and this document exists because of it:

> **Hardcoded behaviour shows up in a git diff. Learned behaviour rots invisibly.**

Nobody notices when the agent starts believing something wrong. There is no
commit, no PR, no review. So the discipline has to come from somewhere else.

---

## The one thing to check

```
GET /ops/digest
```

Read `verdict`. If it says `✅ Nothing needs attention`, you are done.

You will also get a **push notification at 9:00 IST daily** — but only when
something actually needs attention. There is deliberately no "all clear"
message, because a daily all-clear trains you to ignore the channel.

**Set at least one reviewer or none of this works:**
```sql
UPDATE users SET is_ops_reviewer = true WHERE phone = '+91XXXXXXXXXX';
```
If nobody has this flag, the digest worker logs an error saying so — because
"nobody is watching the agentic layer" is the most important thing to surface.

---

## The six queues

### 🔴 `safety_pattern` — CRITICAL, review same day

Agent-proposed emergency detection patterns. **They are INERT until you
approve them.**

This means: the semantic second pass believed the deterministic regex missed a
real emergency, wrote a pattern that would catch it, and that pattern is doing
nothing until a human clicks approve. Every day it sits unreviewed is a day
that phrasing stays missed.

```bash
GET  /knowledge/safety/proposed
POST /knowledge/safety/proposed/:id/approve
POST /knowledge/safety/proposed/:id/reject
```

**How to review:** read the regex. Ask "would this also match ordinary
requests?" An over-broad pattern is worse than a missing one — it floods users
with false emergency warnings until they learn to ignore them. When unsure,
reject and write a tighter one yourself.

Approving takes effect immediately; the ruleset recompiles.

Also watch the logs for `emergency_missed_by_regex` — that event fires when the
semantic pass catches something the regex didn't. Those are real.

---

### 🟠 `knowledge_review` — beliefs that lost confidence

A belief got contradicted by evidence, or produced bad outcomes repeatedly, and
dropped below 0.25 confidence.

```bash
GET  /knowledge/needs-review
POST /knowledge/assert   # your assertion overrides the agent permanently
```

**How to review:** look at `appliedCount` and `successRate`. A belief applied
50 times with a 20% success rate is actively harming bookings. Assert the
correct value — admin assertions sit at the top of the trust hierarchy and
supersede everything the agent learns.

Example — the agent decided restaurants need medical registration:
```json
POST /knowledge/assert
{
  "domain": "kyc_requirement",
  "subject": "restaurant-dinein",
  "key": "requires_kyc",
  "value": false,
  "reasoning": "Restaurants need FSSAI, not personal ID verification"
}
```

---

### 🟡 `scope_boundary` — proposed refusals

The agent noticed 15+ users asking for something it believes Locogi
structurally cannot do, and wrote a boundary definition. Status is `testing` —
it matches but is flagged, not enforced.

```bash
GET  /knowledge/scope/testing
POST /knowledge/scope/:slug/activate
```

**How to review:** the question is not "do we have vendors for this" but "is
there a *structural* reason we can never serve it" — monopolised inventory,
required accreditation, regulatory prohibition. If it is just a supply gap,
reject it: that is a recruitment problem, not a boundary.

---

### 🟡 `unresolved_geo` — locations we cannot resolve

Geography users typed that neither Google nor Nominatim could geocode, hit more
than twice.

```bash
GET /knowledge/geo-cache
```

**How to fix:** if it is a real place, insert coordinates manually:
```sql
UPDATE geo_cache
SET lat = 17.4XXX, lng = 78.3XXX, resolution_failed = false,
    provider = 'manual', locality = 'Proper Name'
WHERE query_normalized = 'whatever they typed';
```
Then the semantic cache will match future variants of that phrasing
automatically.

A high failure rate usually means users are typing landmarks
("behind Inorbit Mall") rather than areas. That is worth knowing.

---

### 🟡 `duplicate_category` — taxonomy drift

Two categories with >0.90 embedding similarity, at least one auto-created.

```bash
POST /categories/merge   { sourceId, targetId }
```
The event metadata includes a `suggestedMerge` — it moves the smaller category
into the larger. Merging carries over vendors, aliases, schema observations and
requests.

---

### 🟡 `travel_model_dispute` — vendors say our estimates are wrong

A vendor overrode a travel-time rejection. We need to know if they were right.

```bash
GET /ops/travel-model
```

Read `verdict`:

- **"TOO PESSIMISTIC"** — vendors override and arrive on time >70% of the
  time. We are blocking legitimate bookings. Raise the speed:
  ```json
  POST /knowledge/assert
  { "domain": "travel_speed", "subject": "two_wheeler", "key": "kmph",
    "value": 26, "reasoning": "Overrides succeed 78% of the time at 22 kmph" }
  ```
- **"correct or too optimistic"** — overrides mostly ended in lateness or
  no-shows. **Do not loosen the model.**

The asymmetry matters: an optimistic estimate causes double-bookings (two
customers harmed, vendor's reliability score damaged). A pessimistic one
declines a job, which the vendor can override. Bias toward pessimism.

---

## Weekly checks

| Check | Endpoint | Looking for |
|---|---|---|
| Is the agent learning? | `/ops/digest` → `learningHealth` | `learnedBeliefs` should be climbing. Zero after a week of traffic means the loops are broken. |
| Question quality | `/knowledge/questions` | `origin: bootstrap` questions should be getting replaced by `generated` ones |
| Supply gaps | `/insights/supply-gaps` | `severity: critical` = where to recruit vendors |
| Unmet demand | `/insights/unmet-demand` | Clusters at `candidate` status = possible new verticals |
| Safety ruleset | `/knowledge/safety/status` | `usingFloor: true` means **DEGRADED** — DB load failed, only 7 emergency patterns active |

---

## Alarms that should page someone

These log at `error` level. Wire them to Sentry or your log alerting.

| Log message | Meaning |
|---|---|
| `SAFETY DEGRADED: running on the hardcoded emergency floor` | The DB safety ruleset failed to load. Only 7 patterns active. Fix now. |
| `MISSED EMERGENCY: semantic pass caught what the regex did not` | A real emergency phrasing got through. Review the proposal today. |
| `OPS ESCALATION: critical review items unattended for over 24 hours` | Safety patterns sitting inert. |
| `Agent has learned NOTHING despite real traffic` | Learning loops broken. Check embedding jobs and the taxonomy worker. |
| `NO user has is_ops_reviewer = true` | Nobody is watching. |
| `Safety ruleset load produced ZERO critical patterns` | Migration or data problem. The previous ruleset is retained, but investigate. |

---

## What is deliberately NOT automated

**Safety pattern approval.** A wrong regex here either misses an emergency or
floods users with false alarms. The agent proposes; a human decides. This will
not be automated.

**Category merges.** Merging is destructive and hard to reverse. The agent
flags candidates with a suggested direction; a human confirms.

**Admin knowledge assertions.** These sit above everything the agent learns, by
design. If the agent could write at admin tier, the tier would be meaningless.

---

## Things that are known-missing

Documented so nobody assumes they exist:

- **Vendor automation agent** — `vendor_agent_rules` and `agent_decisions` were
  dropped in migration 009 as unbuilt dead schema. Revive when a vendor with
  20+ requests/week asks for it. Design is in migration 001's git history.
- **Travel time uses H3 hex distance, not real routing.** Zero API cost, roughly
  ±30% accurate. Swap to a Distance Matrix API if the model verdict says
  pessimistic and raising the speed constants doesn't fix it.
- **No dispute resolution beyond no-shows.** A vendor claiming completion while
  the customer disagrees has no flow. Support handles it manually.
- **Payments are wired but flag-gated off.** `payments_enabled` in PostHog.
