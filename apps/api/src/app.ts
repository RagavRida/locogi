/**
 * Application composition — routes and their mounts, with no side effects.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS SEPARATE FROM index.ts
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `index.ts` is the entrypoint: it connects to Postgres and Redis, compiles
 * the safety ruleset, starts background workers, and listens on a port — all
 * at module load, because that is what an entrypoint is for.
 *
 * That makes it unimportable. A test that wanted to inspect the route table
 * would boot the entire server as a side effect of the import, including
 * workers and a socket bind. The versioning tests caught exactly that.
 *
 * So composition lives here, where importing it does nothing but define
 * functions.
 */

import type { FastifyInstance } from 'fastify'

import { db } from './lib/db'
import {
  withCorrelation,
  acceptOrCreate,
  enrich,
  CORRELATION_HEADER,
} from './lib/correlation'
import { logger } from './lib/logger'

import { authRoutes } from './routes/auth.routes'
import { socialAuthRoutes } from './routes/social-auth.routes'
import { userRoutes, reviewRoutes } from './routes/user.routes'
import { vendorRoutes } from './routes/vendor.routes'
import { requestRoutes } from './routes/request.routes'
import { categoryRoutes } from './routes/category.routes'
import { insightsRoutes } from './routes/insights.routes'
import { organizationRoutes } from './routes/organization.routes'
import { lifecycleRoutes } from './routes/lifecycle.routes'
import { rentalRoutes } from './routes/rental.routes'
import { knowledgeRoutes } from './routes/knowledge.routes'
import { opsRoutes } from './routes/ops.routes'
import { chatRoutes } from './routes/chat.routes'
import { bookingRoutes } from './routes/booking.routes'
import { wsRoutes } from './routes/ws.routes'
import { searchRoutes } from './routes/search.routes'
import { platformRoutes } from './routes/platform.routes'
import { widgetRoutes } from './routes/widget.routes'
import { telegramRoutes } from './routes/telegram.routes'

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every route module in the API.
 *
 * Listed once so the versioned and unversioned mounts cannot drift — adding a
 * module here mounts it on both, which is the whole point of naming them in
 * one place rather than repeating two register blocks.
 */
const ROUTE_MODULES = [
  authRoutes,
  socialAuthRoutes,
  userRoutes,
  reviewRoutes,
  vendorRoutes,
  requestRoutes,
  categoryRoutes,
  insightsRoutes,
  organizationRoutes,
  lifecycleRoutes,
  rentalRoutes,
  knowledgeRoutes,
  opsRoutes,
  chatRoutes,
  bookingRoutes,
  searchRoutes,
  platformRoutes,
  widgetRoutes,
] as const

/**
 * Routes that are mounted ONCE, unversioned.
 *
 * The WebSocket endpoint is a long-lived connection negotiated at a fixed
 * URL, not a REST resource. Dual-mounting it would register two upgrade
 * handlers for the same protocol and force every client to pick a version for
 * something that has no request/response body to version.
 */
const UNVERSIONED_MODULES = [wsRoutes, telegramRoutes] as const

export const API_VERSION = 'v1'
export const API_PREFIX = `/api/${API_VERSION}`

/**
 * The date after which the unversioned mount stops being served.
 *
 * Advertised in a Sunset header (RFC 8594) rather than kept in a ticket, so a
 * client author discovers the deadline from the response itself. Nothing
 * enforces it automatically — removing the mount is a deliberate act.
 */
const UNVERSIONED_SUNSET = 'Wed, 31 Dec 2026 23:59:59 GMT'

/**
 * Mount every route module twice: once under /api/v1, once at the bare path.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY DUAL-MOUNT INSTEAD OF A REDIRECT OR A REWRITE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A 301 from /requests to /api/v1/requests breaks POST bodies in several HTTP
 * clients, which silently downgrade to GET on redirect. A URL-rewriting hook
 * would work, but it makes the route table lie: /requests would not appear in
 * `app.printRoutes()`, so nobody could see what is actually served.
 *
 * Fastify encapsulates each `register`, so registering the same plugin under
 * two prefixes creates two independent route trees over the same handlers.
 * The cost is a slightly larger router; the benefit is that a shipped mobile
 * build keeps working, unchanged, while new clients move over.
 *
 * The unversioned mount is instrumented, not silent: every hit carries
 * Deprecation and Sunset headers and increments a log counter. You cannot
 * safely delete a compatibility shim you have no traffic data for.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ── Correlation, before anything else ─────────────────────────────────────
  //
  // Registered here rather than inside a route module so it wraps EVERY
  // request, including the legacy mount and /healthz. Anything that runs
  // outside this wrapper logs without a correlation id, which is exactly the
  // hole this feature exists to close.
  //
  // `onRequest` is the earliest hook Fastify offers. Later hooks would leave
  // auth failures and rate-limit rejections untraceable — and those are
  // precisely the ones someone asks about.
  app.addHook('onRequest', (req, reply, done) => {
    const correlationId = acceptOrCreate(req.headers[CORRELATION_HEADER])

    // Echoed so a user reporting a problem can quote the id from their own
    // network tab, and support can find the trace immediately.
    reply.header(CORRELATION_HEADER, correlationId)

    withCorrelation(
      {
        correlationId,
        source: 'http',
        operation: `${req.method} ${req.routeOptions?.url ?? req.url}`,
      },
      done
    )
  })

  // `requireAuth` sets req.user in a preHandler, which runs after the wrapper
  // above — so the userId is added here rather than at creation time.
  app.addHook('preHandler', (req, _reply, done) => {
    if (req.user?.id) enrich({ userId: req.user.id })
    done()
  })

  // ── Versioned mount — the one new clients should use ──────────────────────
  for (const route of ROUTE_MODULES) {
    await app.register(route, { prefix: API_PREFIX })
  }

  // ── Legacy unversioned mount — kept alive during migration ────────────────
  await app.register(async (legacy) => {
    legacy.addHook('onRequest', async (req, reply) => {
      reply.header('Deprecation', 'true')
      reply.header('Sunset', UNVERSIONED_SUNSET)
      reply.header('Link', `<${API_PREFIX}${req.url}>; rel="successor-version"`)

      // Logged at warn so it surfaces without anyone going looking. When this
      // stops appearing, the mount below can be deleted.
      logger.warn(
        { path: req.url, method: req.method, ua: req.headers['user-agent'] },
        'unversioned API call — client should migrate to /api/v1'
      )
    })

    for (const route of ROUTE_MODULES) {
      await legacy.register(route)
    }
  })

  for (const route of UNVERSIONED_MODULES) {
    await app.register(route)
  }

  // ── Operational endpoints stay unversioned, deliberately ──────────────────
  //
  // Liveness probes are configured in infrastructure — Kubernetes manifests,
  // load balancer health checks, uptime monitors. Moving /healthz with an API
  // version would mean an API change silently breaks deployment tooling that
  // knows nothing about API versions.
  app.get('/healthz', async () => {
    const dbOk = await db
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false)
    return {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk,
      ts: new Date().toISOString(),
    }
  })

}
