# Locogi API

Fastify + PostgreSQL backend. Pure REST — serves the Expo mobile app.

## Setup (5 minutes)

### 1. Install

```bash
cd apps/api
npm install
```

### 2. Configure

```bash
cp ../../.env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string |
| `REDIS_URL` | upstash.com → Create Database (ap-south-1) → Redis URL |
| `NIM_API_KEY` | build.nvidia.com → Get API Key |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | `openssl rand -base64 48` (different value) |

`MSG91_*` is optional in development — OTPs are printed to the console.

### 3. Enable Postgres extensions

In the Supabase SQL editor:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS postgis;
```

### 4. Run migrations

```bash
npm run db:migrate
```

### 5. Start

```bash
npm run dev
```

```
🚀 Locogi API listening on 3000
📱 Point your Expo app at: http://<your-lan-ip>:3000
```

---

## Logging in during development

There is no SMS provider in dev. Request an OTP and read it from the terminal:

```
INFO: 📱 DEV OTP — use this code to log in
    phone: "+919876543210"
    otp: "482915"
```

---

## API surface

### Auth
| Method | Route | Purpose |
|---|---|---|
| POST | `/auth/send-otp` | Send OTP (rate limited 3/10min) |
| POST | `/auth/verify-otp` | Verify + issue JWT pair |
| POST | `/auth/refresh` | Rotate refresh token |
| POST | `/auth/logout` | Revoke all tokens |
| DELETE | `/auth/account` | DPDP deletion (cancels active bookings) |

### Users
| Method | Route | Purpose |
|---|---|---|
| GET | `/users/me` | Own profile |
| PATCH | `/users/me` | Update name, emergency contact |
| PATCH | `/users/role` | Set customer/vendor/both |
| POST | `/push-tokens` | Register Expo push token |
| DELETE | `/push-tokens/:token` | Deregister on logout |

### Requests (customer side)
| Method | Route | Purpose |
|---|---|---|
| POST | `/requests/extract` | LLM extraction, no DB write |
| POST | `/requests` | Create + H3 index + match + fan out |
| GET | `/requests/:id` | Detail + job stages |
| GET | `/requests/:id/quotes` | Incoming quotes |
| POST | `/requests/:id/quote/accept` | **Atomic race-lock** |
| POST | `/requests/:id/quote/counter` | Counter-offer |
| POST | `/requests/:id/book-slot` | **Atomic slot lock** |
| PATCH | `/requests/:id/status` | Advance in_progress / completed |
| POST | `/requests/:id/cancel` | Cancel (5-minute window) |
| GET | `/requests/history` | Past requests |
| GET/POST | `/requests/:id/messages` | Chat |

### Vendors
| Method | Route | Purpose |
|---|---|---|
| POST | `/vendors/extract` | LLM extraction |
| POST | `/vendors` | Create/update profile (KYC gate) |
| GET | `/vendors/me` | Own profile |
| GET | `/vendors/inbox` | Incoming job requests |
| POST | `/requests/:id/quote` | Send a quote |
| POST | `/requests/:id/apply` | Apply to a hiring post |
| POST | `/vendors/decline/:id` | Decline a request |
| PUT | `/vendors/availability` | Set working hours |
| GET/POST | `/vendors/slots` | Appointment calendar |
| GET | `/vendors/stats` | Own performance metrics |

### Reviews
| Method | Route | Purpose |
|---|---|---|
| POST | `/reviews` | Submit (unique per request) |
| GET | `/vendors/:id/reviews` | Vendor's reviews |

---

## Architecture

```
src/
├── index.ts              Fastify bootstrap, plugins, error handler
├── routes/               HTTP layer only — parse, delegate, respond
│   ├── auth.routes.ts
│   ├── user.routes.ts
│   ├── vendor.routes.ts
│   └── request.routes.ts
├── services/             Business logic
│   ├── matching.service.ts       4-path H3 + pgvector matching
│   ├── booking.service.ts        Atomic race-locks
│   ├── location.service.ts       H3 indexing
│   └── notification.service.ts   Channel abstraction + fallback
├── lib/
│   ├── db.ts             Pool + withTransaction helper
│   ├── auth.ts           JWT + ban check middleware
│   ├── redis.ts          Rate limiting, OTP, cache
│   ├── nim.ts            NVIDIA NIM (LLM + embeddings)
│   ├── h3.ts             Hexagonal geo indexing
│   ├── queue.ts          BullMQ queues
│   └── logger.ts         pino with PII redaction
├── workers/
│   ├── embedding.worker.ts   Generates 1536-dim vectors
│   ├── expiry.worker.ts      Rematch → expire sweep
│   ├── reminder.worker.ts    Appointment reminders
│   └── outbox.worker.ts      Reliable side effects
├── migrations/
└── tests/
    └── race-lock.test.ts     ⚠️ CRITICAL PATH
```

---

## The critical test

The atomic booking confirmation is the highest-risk code in the system.
Run this before every deploy:

```bash
npm run test:race
```

It fires 10 parallel confirmations at the same request and asserts:
- Exactly 1 succeeds, 9 get a conflict
- Exactly 1 `confirmed_vendor_id` in the DB
- All 9 losers marked `missed`
- Retrying with the same idempotency key returns success (not a 409)

Plus the same for slot booking, including capacity limits, past slots,
and cancelled slots.

**Point `DATABASE_URL` at a staging database, not production.**

---

## Matching engine

Four fallback paths, tried in order:

| Path | Condition | Query |
|---|---|---|
| A | Location + embedding | H3 tiered geo pre-filter → pgvector cosine rank |
| B | Location only | H3 geo pre-filter → rating rank |
| C | Embedding only | pgvector cosine, category-filtered |
| D | Neither | Category + rating |

H3 tiers widen automatically when fewer than 3 vendors are found:
~2km → ~4km → ~5km → ~12km → give up and drop the geo filter.

---

## Deploy (Railway)

```bash
railway login
railway init
railway up
```

Set the same env vars in the Railway dashboard. Then in your Expo app's
`app.json`, point `extra.apiUrl` at the Railway URL.
