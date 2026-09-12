# Locogi website deployment

## Project

- GitHub: `RagavRida/locogi` (private).
- Vercel project: `locogi`, under the existing account team.
- Root directory: `apps/web`; include workspace source outside the root.
- Node: 22.x.
- Install: `pnpm --filter @locogi/web... install --frozen-lockfile`.
- Build: `pnpm --filter @locogi/types build && pnpm --filter @locogi/web build`.

The public website and vendor dashboard are both in `apps/web`. The older
standalone `apps/dashboard` is not the Vercel application for this deployment.
The persistent backend and WebSocket server are not deployed by this project.

## Required production settings

Configure these in Vercel, never in committed source:

| Variable                                   | Purpose                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `API_URL`                                  | Public HTTPS origin of the separately hosted Locogi backend; never localhost |
| `API_PREFIX`                               | `/api/v1`                                                                    |
| `NEXT_PUBLIC_WS_URL`                       | Public WSS endpoint of that backend                                          |
| `AUTH0_SECRET`                             | Random session-encryption secret, at least 32 bytes                          |
| `AUTH0_BASE_URL`                           | This website's production origin                                             |
| `AUTH0_ISSUER_BASE_URL`                    | Auth0 tenant HTTPS origin                                                    |
| `AUTH0_CLIENT_ID`                          | Auth0 Regular Web Application client ID                                      |
| `AUTH0_CLIENT_SECRET`                      | Auth0 application secret                                                     |
| `AUTH0_AUDIENCE`                           | Registered Locogi API identifier                                             |
| `NEXT_PUBLIC_COPILOT_CLOUD_PUBLIC_API_KEY` | Copilot Cloud public key; intentionally available to browser code            |

Register `<website-origin>/api/auth/callback` in Auth0's allowed callback URLs
and the website origin in allowed logout URLs. The backend also needs the
Auth0 issuer, client ID, and audience. Migration `019_auth0_identities.sql`
adds identity mappings without changing Telegram OTP tables or handlers.
Existing phone accounts are explicitly linked after Auth0 login using a
one-time phone verification; no account is linked just by matching an email.

The supplied Copilot key has been stored as an environment variable, not in
source. Its read-only Cloud metadata check returned HTTP 401. Verify the key,
project permissions, allowed origins, and the `locogi-vendor-assistant` agent
before treating the copilot as operational.

## Vendor-only copilot

`CopilotKit` wraps the vendor workspace, not the root consumer layout.
`CopilotSidebar` is present on dashboard pages. Page hooks register current
API data using `useCopilotReadable`, with role-appropriate actions through
`useCopilotAction`:

- Catalog: add an item, update its price, pause/enable availability.
- Bookings: owner-confirmed status changes after API ownership checks.
- Overview/analytics: query available metrics without relabeling lifetime
  totals as weekly sales.
- Messages: show authorized context when an endpoint exists and draft replies
  locally. Drafts are not automatically sent.

Mutations require a visible confirmation before the authenticated API call.
Owners manage bookings and catalog; managers edit catalog and view analytics;
staff/practitioners must not receive organization-wide revenue or bookings.
The current backend has no assigned-booking endpoint, so those reads fail
closed rather than returning everyone else's bookings.

The Cloud proxy never forwards Locogi bearer credentials to Copilot Cloud.
A separately configured custom runtime requires `COPILOTKIT_URL` and
`COPILOTKIT_REVIEWED=true`; it must independently enforce permissions.

## Known backend-dependent limits

- The local API cannot be reached by a hosted Vercel function. Set a real
  backend URL and WSS endpoint before testing live bookings.
- Auth0 tenant credentials have not been supplied; hosted login cannot be
  validated until configured.
- Organization analytics/messages require verified scoped endpoints via
  `API_VENDOR_ANALYTICS_PATH` and `API_VENDOR_MESSAGES_PATH`.
- Platform integration keys currently live in development server memory or
  `LOCOGI_ORG_API_KEYS` server configuration. Serverless cold starts do not
  preserve that memory. Production onboarding needs a durable secret store
  or backend JWT support for platform operations.
- Catalog durations, deletion/reordering, message sending, and automation
  delivery telemetry are not exposed by the verified APIs. They are not
  simulated by the frontend.

## Checks

```sh
pnpm typecheck
pnpm --filter @locogi/web test
pnpm --filter @locogi/web build
```

Environment files, build output, local logs, screenshots, and Vercel credentials
are excluded from Git and CLI uploads. The original API/mobile code belongs
in the private repository but is excluded from this frontend CLI deployment.
