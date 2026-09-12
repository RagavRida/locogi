# Locogi

Chat-first local services marketplace for Hyderabad. Describe what you need in
plain language — an AI agent extracts the details, finds the right vendor via
semantic matching, and handles the booking end to end.

```
apps/
├── api/      Fastify + PostgreSQL + pgvector + Redis   (REST backend)
└── mobile/   React Native + Expo                        (chat-first app)
packages/
└── types/    Shared TypeScript interfaces
```

---

## Quick start

### 1. Backend

```bash
cd apps/api
npm install
cp ../../.env.example .env      # then fill in your keys
npm run db:migrate
npm run dev
```

See [`apps/api/README.md`](apps/api/README.md) for where to get each key.

### 2. Mobile app

```bash
cd apps/mobile
npm install
# edit app.json → extra.apiUrl = http://<your-lan-ip>:3000
npx expo start
```

Scan the QR code with Expo Go. See [`apps/mobile/README.md`](apps/mobile/README.md).

---

## How it works

```
User types: "need a photographer in Madhapur this Sunday, around 5k"
                              ↓
              POST /requests/extract  (NVIDIA NIM Llama 3.1 70B)
                              ↓
   { categoryTags: ["Photography"], attributes: { area, budget, date },
     attributeSchema: {...}, bookingTypeSuggestion: "quote" }
                              ↓
              ConfirmationCard renders inline in chat
              User edits anything wrong → confirms
                              ↓
                        POST /requests
                              ↓
        ┌─────────────────────┼─────────────────────┐
        ↓                     ↓                     ↓
   H3 geo index      Embedding job (async)    Matching engine
   (Kondapur →       nv-embed-v1 → 1536-dim   H3 tiers + pgvector
    hex cells)                                 cosine similarity
                              ↓
                    Top 5 vendors, fanned out
                    (Expo Push, WhatsApp fallback)
                              ↓
              Vendor quotes → QuoteCard in customer's chat
                              ↓
              Customer accepts → ATOMIC race-lock
              UPDATE requests SET status='confirmed'
              WHERE status IN ('open','negotiating')
                              ↓
              rowCount 1 = won  ·  rowCount 0 = 409 Conflict
                              ↓
              JobTrackerCard → ReviewCard → RebookCard
```

---

## Design decisions

**No home screen.** The app opens directly into a conversation. Vendor lists,
slot pickers, quotes, job trackers, and review prompts all render as cards
inline in that chat. There is no browse tab, no category grid, no bottom nav.

**Semantic matching, not keyword matching.** A vendor who wrote "drone
photography and aerial cinematography" matches a customer asking for "overhead
shots" — because both are embedded into the same 1536-dimensional space and
compared by cosine distance, not string overlap.

**H3 geospatial tiers.** Vendors are indexed into Uber's H3 hexagonal grid at
three resolutions. Matching starts at ~2km and widens automatically (~4km → ~5km
→ ~12km) until it finds at least 3 candidates. This keeps the common case fast
without ever returning an empty list when someone is available slightly further out.

**The atomic race-lock is the whole product.** Everything else can degrade
gracefully. If two vendors both think they won the same job, the platform has
failed in a way no retry can fix. That single `UPDATE ... WHERE status IN (...)`
guard has a dedicated concurrent test suite — run `npm run test:race` before
every deploy.

**Four booking types, four flows.** Quote/negotiation (services, rides),
appointment (slot-based), hiring (application queue), order (fixed price).
Each has different correctness requirements, so each has its own path rather
than one generic flow with conditionals.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| LLM + embeddings | NVIDIA NIM (Llama 3.1 70B, nv-embed-v1) | Free tier, OpenAI-compatible API |
| Database | PostgreSQL + pgvector + PostGIS (Supabase) | Vector search and geo in one place |
| Cache / queue | Redis (Upstash) + BullMQ | Rate limiting, OTP, background jobs |
| Backend | Fastify + TypeScript strict | Fast, typed, small surface |
| Mobile | React Native + Expo | One codebase, OTA updates, Expo Go for testing |
| Notifications | Expo Push → WhatsApp fallback | WhatsApp has far better delivery in India than SMS |
| Auth | Phone OTP + JWT (15m access, 30d refresh) | Familiar to Indian users, no passwords |

---

## Testing

```bash
cd apps/api
npm run test:race     # ⚠️ concurrent booking — run before every deploy
npm test              # full suite
```

---

## Scope

**Built:** chat-first onboarding, LLM extraction with Zod validation, H3 +
pgvector matching, all four booking flows, atomic race-locks, appointment
reminders, reviews with rating recalculation, DPDP-compliant data deletion,
vendor KYC gate for home services, outbox pattern for reliable side effects.

**Deliberately not built yet:** payments (Razorpay wired but flag-gated),
vendor automation agent, ride safety layer (SOS, live location), admin
dashboard, city expansion beyond Hyderabad.
