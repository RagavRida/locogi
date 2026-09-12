# Locogi web

A Next.js 14 App Router frontend in `apps/web`, with React 18, TypeScript,
vanilla CSS, and the workspace `@locogi/types` package. It does not replace
`apps/mobile`, `apps/dashboard`, or the API. It has no database or AI client.

## Run locally

From the workspace root:

```sh
pnpm --filter @locogi/web install --ignore-scripts
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @locogi/web dev
```

Open `http://localhost:3002`. Start the existing backend separately on port 3001. Do not run the existing dashboard on that same port simultaneously.
The website can render without the API; live flows show errors or sign-in
gates rather than invented data. `.env` and `.env.local` remain gitignored.

For a production build:

```sh
pnpm --filter @locogi/web build
pnpm --filter @locogi/web start
```

Serve production over HTTPS, set `APP_ORIGIN` to the exact public origin, and
use `wss:` for `NEXT_PUBLIC_WS_URL`. Cookie `Secure` is enabled in production.
Next.js 14 was selected to match the requested stack; check its security and
support status before a public deployment.

## How a request actually works

1. The browser opens a Next.js page on port 3002. Components call the same-origin
   `/api/backend/*` route, not the database.
2. Next.js checks its closed route allowlist, the session, and the origin for
   writes. Business operations additionally verify membership against
   `/organizations/mine`. Next forwards the request to port 3001 under `/api/v1`
   with `Authorization: Bearer …`.
3. The backend owns AI reasoning, pricing, ranking, availability, and all status
   transitions. The web app displays responses; it does not recreate these rules.
4. Chat replies contain text and optional `{ type, data }` UI instructions. The
   closed registry chooses an already-compiled React component. Unknown types
   render nothing. Cards extract identifiers, then read current REST data rather
   than rendering historical prices, totals, or statuses from `ui.data`.
5. The WebSocket connection uses `/ws?token=…`. Frames only invalidate data;
   their state or price fields are never rendered. The client refetches on events,
   reconnects with bounded exponential backoff/jitter, pings every 30 seconds,
   and closes a connection silent for 75 seconds. Shared subscriptions are
   reference-counted and re-established after reconnecting.
6. For cancellation, the UI sends the request to chat, renders the backend’s
   pending-confirmation card, and waits for an explicit separate `yes` or `no`.
   Confirmation is sent through chat, not a bypassing direct cancel endpoint.
   The backend remains responsible for expiry and single-use enforcement.

## Authentication

- `/login` and `/register` use the same phone/OTP API. Verification creates an
  account if the API supports it. The development screen explicitly says OTP is
  **logged to the API console, not sent by SMS**.
- Access and refresh tokens are kept in HTTP-only, SameSite=Lax cookies. The
  frontend never stores them in localStorage. Refresh uses only the cookie,
  never a refresh token supplied in a browser request body.
- Access-cookie lifetime is 15 minutes; refresh-cookie lifetime is 30 days.
  A single in-tab refresh promise prevents concurrent refresh calls.
- The socket bootstrap endpoint returns the access token to authenticated
  same-origin JavaScript only, because browser WebSockets cannot set an
  Authorization header. It is used in memory for the handshake, never rendered
  in the UI or debug panel. Token-bearing socket URLs should be redacted in
  infrastructure logs.
- Sign-out clears local session cookies. It does not revoke all devices; no
  global logout action is silently performed.
- Browser form validation is only input assistance. API authorization and
  validation remain authoritative.

## Backend contract differences

The checkout inspected here differs from the requested description. The web
app does not silently modify the backend to reconcile those differences.

| Configuration               | Default                  | Purpose                                                                                                    |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `API_URL`                   | `http://localhost:3001`  | Server-side API origin                                                                                     |
| `API_PREFIX`                | `/api/v1`                | Versioned REST prefix                                                                                      |
| `API_CHAT_FIELD`            | `text`                   | Actual checkout expects `{ text, orgId? }`; set to `message` only for a backend that expects that contract |
| `API_OTP_PATH`              | `/auth/send-otp`         | Actual route; set to `/auth/request-otp` for a backend exposing the described route                        |
| `NEXT_PUBLIC_WS_URL`        | `ws://localhost:3001/ws` | Public socket endpoint, unversioned                                                                        |
| `APP_ORIGIN`                | empty                    | Exact trusted web origin behind a reverse proxy; defaults to the incoming Next.js URL’s origin             |
| `API_VENDOR_BOOKINGS_PATH`  | empty                    | Optional verified, JWT-authorized, org-scoped booking-list endpoint                                        |
| `API_VENDOR_ANALYTICS_PATH` | empty                    | Optional verified, JWT-authorized, org-scoped analytics endpoint                                           |
| `COPILOTKIT_URL`            | empty                    | Reserved forwarding target for a separately security-reviewed CopilotKit runtime                           |

`API_CATEGORY_SEARCH_PATH` defaults to `/search/categories`, the route exposed
by this checkout. The Next.js adapter converts its `{ results }` envelope into
the composer's `{ suggestions }` envelope without inventing or ranking results.
Set it to `/categories/search` only if your API exposes the described route;
an existing `{ suggestions }` response is passed through unchanged.

The chat adapter strips browser-supplied `userId`, role, and session identifiers;
the current backend derives identity and conversation state from its bearer
token. It does not retry a mutation with a second, guessed request shape.

Optional workspace endpoints must enforce organization membership, permissions,
and practitioner row scope themselves. They receive the verified selected
`orgId` plus filters. Empty settings return an explicit unavailable response,
not customer data mislabeled as organization data.

## What is implemented

- Landing page, responsive dark visual system, CSS conversation preview, service
  categories, and business/customer navigation. The preview is labeled
  illustrative; the testimonial section does not fabricate endorsements.
- Natural-language search, category filters, opt-in browser geolocation, and
  business cards hydrated from current widget config/catalog endpoints. Search
  ranking is preserved; missing ratings/photos are not invented.
- Business profiles, sectioned catalogs, resources, date/slot availability,
  business-scoped chat links, and explicit appointment submission via
  `/widget/book` when the API advertises appointment support.
- OTP auth, account chat/history, typeahead, server-chosen cards, customer
  bookings/detail/tracking, explicit chat confirmation, and realtime invalidation.
- Membership-gated dashboard pages for overview, catalog, bookings, resources,
  schedule, analytics, and settings. Supported actions include adding catalog
  items/sections, inviting staff, and generating availability slots.
- Unit and browser tests, API-down states, and a dev-only diagnostics panel
  containing only correlation ID, socket state, last intent, and component type.

## Deliberately unavailable, not fake success

- **Vendor booking management:** `/bookings` in this checkout returns customer
  bookings and ignores organization filtering. `/platform/bookings` requires
  API-key authorization, not the JWT role flow requested. The web does not
  expose API keys or silently substitute customer bookings. Its observed
  platform mutation route also does not demonstrate safe organization-scoped
  ownership checks, so accept/reject is not wired to it.
- **Catalog edits/delete/reorder/images/availability:** the verified JWT routes
  only expose list/add. These controls are not implemented as browser-only state.
- **General staff/resource creation:** the existing creation route is specialized
  for clinicians. Membership invitations are implemented; creating a member is
  not presented as creating a bookable resource.
- **Analytics:** `/vendors/stats` is displayed explicitly as vendor-account totals,
  not today’s organization KPIs. `/ops/digest` is platform-wide operations data,
  not a revenue series, funnel, or organization analytics source. No charts or
  percentages are fabricated to fill those gaps.
- **Settings/webhooks:** profile and policies remain read-only where no verified
  JWT write API exists. A public profile link can be copied. A working hosted
  widget script and origin configuration are needed before generating embed code.
- **CopilotKit:** the existing dashboard runtime accepts role headers/defaults
  and exposes a dynamic SQL tool without demonstrated organization scoping.
  It has not been connected or copied into this app. The sidebar states this
  limitation. The forwarding route validates membership and derives identity
  headers server-side, but is disabled by default and does not repair the
  upstream SQL boundary. Enabling its URL alone does not add a CopilotKit UI.
- **Cart UI:** the backend emits snapshots but has no verified authorized cart
  GET route. The cart card refetches context and explains the missing read
  capability rather than trusting saved quantities or totals.
- **Tracking:** this checkout’s GET route exposes coordinates and ETA but no
  phase/history. A timeline is rendered only if supplied by REST; progress is
  never inferred from coordinates, elapsed time, or WebSocket hints.
- **Business history:** `/chat/history` does not provide verified organization
  scoping. Business conversations start with a fresh local view rather than
  relabeling the entire account history as that business’s conversation.

## Verification

```sh
pnpm typecheck
pnpm --filter @locogi/web test
pnpm --filter @locogi/web test:e2e
pnpm --filter @locogi/web build
```

Browser tests use an installed Google Chrome (`channel: 'chrome'`) and start
port 3002 when needed. Test fixtures only exist in the test harness; they are
never used as runtime fallback data. The tests exercise UI behavior against
controlled responses, not the actual backend/LLM/database.

Workspace `typecheck` runs only packages that define that script; the existing
dashboard and widget do not define one. Its dependency tasks may rebuild
`@locogi/types` generated output. The web tsconfig pins React type resolution
locally to avoid React 19 types in other apps leaking into this React 18 app.

The real API on port 3001 was unavailable during implementation, including a
check outside the filesystem/network sandbox. Live OTP delivery, real database
bookings, role permissions, AI-generated commerce variants, refresh rotation,
and real WebSocket events must still be exercised with that API running.
