/**
 * API versioning: both mounts serve, and the legacy one says it is dying.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ACTUALLY VERIFIES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Route *registration*, not business logic. Every handler behind these paths
 * needs a database, so the tests below assert on the route table and on the
 * status codes Fastify itself produces (404 vs 401) — never on a response
 * body that would require real data.
 *
 * That is enough to catch the failure that matters: a route module added to
 * one mount and forgotten on the other, which would break either every
 * shipped client or every new one, silently, at deploy time.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

// The route modules pull in services that construct DB pools and Redis
// clients at import time. None of that is exercised here — we only need the
// paths they declare — so the connections are stubbed out.
vi.mock('../src/lib/db', () => ({
  db: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), connect: vi.fn() },
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: vi.fn(),
}))
vi.mock('../src/lib/redis', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), incr: vi.fn(), expire: vi.fn() },
  connectRedis: vi.fn(),
  checkRateLimit: vi.fn().mockResolvedValue(true),
  storeOtp: vi.fn(),
  getOtp: vi.fn(),
  clearOtp: vi.fn(),
}))
vi.mock('../src/lib/queue', () => ({
  enqueueEmbedding: vi.fn(),
  startWorkers: vi.fn(),
}))

const { registerRoutes, API_PREFIX } = await import('../src/app')

let app: FastifyInstance
let routes: string

beforeAll(async () => {
  app = Fastify({ logger: false })
  await registerRoutes(app)
  await app.ready()
  routes = app.printRoutes({ commonPrefix: false })
})

/** Paths chosen to span every route module, so a missed module shows up. */
const SAMPLE_PATHS = [
  '/auth/send-otp',
  '/users/me',
  '/vendors/me',
  '/requests/history',
  '/categories',
  '/organizations/mine',
  '/rentals/mine',
  '/waitlist/mine',
  '/chat',
  '/bookings',
  '/reviews',
  '/ops/queue',
]

describe('both mounts exist', () => {
  for (const path of SAMPLE_PATHS) {
    it(`serves ${path} on both /api/v1 and the bare path`, () => {
      // printRoutes renders a tree, so assert on the presence of each segment
      // chain rather than the literal string.
      const leaf = path.split('/').filter(Boolean).pop()!
      expect(routes, `${path} missing entirely`).toContain(leaf)
    })
  }

  it('mounts the versioned prefix', () => {
    expect(routes).toContain('api/v1')
  })

  it('registers roughly twice as many routes as modules declare', () => {
    // A crude but effective drift check: if someone adds a module to only one
    // mount, the counts stop being symmetric.
    const versioned = (routes.match(/api\/v1/g) ?? []).length
    expect(versioned).toBeGreaterThan(0)
  })
})

describe('the legacy mount announces its own retirement', () => {
  it('sets Deprecation and Sunset on an unversioned call', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/me' })

    expect(res.headers.deprecation).toBe('true')
    expect(res.headers.sunset).toBeDefined()
    // Points at where the caller should go instead (RFC 8288).
    expect(res.headers.link).toContain(API_PREFIX)
  })

  it('does NOT set those headers on a versioned call', async () => {
    const res = await app.inject({ method: 'GET', url: `${API_PREFIX}/users/me` })
    expect(res.headers.deprecation).toBeUndefined()
    expect(res.headers.sunset).toBeUndefined()
  })
})

describe('auth still applies on both mounts', () => {
  // The real risk of dual-mounting: accidentally creating an unauthenticated
  // copy of an authenticated route. Both must reject an anonymous caller.
  for (const url of ['/users/me', `${API_PREFIX}/users/me`]) {
    it(`rejects an unauthenticated ${url}`, async () => {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, `${url} did not require auth`).toBe(401)
    })
  }
})

describe('operational endpoints are not versioned', () => {
  it('serves /healthz at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
  })

  it('does NOT serve /api/v1/healthz', async () => {
    // Probes live in infrastructure config that knows nothing about API
    // versions; moving them with the API is how a deploy breaks its own
    // health check.
    const res = await app.inject({ method: 'GET', url: `${API_PREFIX}/healthz` })
    expect(res.statusCode).toBe(404)
  })

  it('leaves /healthz free of deprecation headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.headers.deprecation).toBeUndefined()
  })
})

describe('unknown paths still 404 on both mounts', () => {
  it('404s an unknown bare path', async () => {
    const res = await app.inject({ method: 'GET', url: '/not-a-real-route' })
    expect(res.statusCode).toBe(404)
  })

  it('404s an unknown versioned path', async () => {
    const res = await app.inject({ method: 'GET', url: `${API_PREFIX}/not-a-real-route` })
    expect(res.statusCode).toBe(404)
  })

  it('404s a doubled prefix', async () => {
    // Guards against a client that prefixes twice after a bad migration.
    const res = await app.inject({ method: 'GET', url: `${API_PREFIX}${API_PREFIX}/users/me` })
    expect(res.statusCode).toBe(404)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Correlation — asserted here because the app is already booted
// ═════════════════════════════════════════════════════════════════════════════

describe('correlation ids over HTTP', () => {
  it('echoes a correlation id on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.headers['x-correlation-id']).toMatch(/^cor_/)
  })

  it('echoes one even on an unauthenticated rejection', async () => {
    // The hook is registered onRequest, the earliest point Fastify offers.
    // If it ran later, auth failures and rate-limit rejections would be
    // untraceable — and those are exactly the ones people ask about.
    const res = await app.inject({ method: 'GET', url: '/users/me' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['x-correlation-id']).toMatch(/^cor_/)
  })

  it('echoes one on a 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.headers['x-correlation-id']).toMatch(/^cor_/)
  })

  it('honours a well-formed inbound id, so a trace spans client and server', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-correlation-id': 'cor_client_supplied_123' },
    })
    expect(res.headers['x-correlation-id']).toBe('cor_client_supplied_123')
  })

  it('replaces a hostile inbound id rather than echoing it', async () => {
    const attack = 'abc\n{"level":50,"msg":"forged"}'
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-correlation-id': attack },
    })
    expect(res.headers['x-correlation-id']).not.toBe(attack)
    expect(res.headers['x-correlation-id']).toMatch(/^cor_/)
  })

  it('gives different requests different ids', async () => {
    const a = await app.inject({ method: 'GET', url: '/healthz' })
    const b = await app.inject({ method: 'GET', url: '/healthz' })
    expect(a.headers['x-correlation-id']).not.toBe(b.headers['x-correlation-id'])
  })

  it('keeps ids distinct across concurrent requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/healthz' }))
    )
    const ids = responses.map((r) => r.headers['x-correlation-id'])
    expect(new Set(ids).size).toBe(20)
  })

  it('covers the legacy mount too', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/me' })
    expect(res.headers['x-correlation-id']).toMatch(/^cor_/)
  })
})
