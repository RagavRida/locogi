import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'

import { db } from './lib/db'
import { connectRedis } from './lib/redis'
import { logger } from './lib/logger'


import { registerRoutes } from './app'
import { startRealtimeBridge, stopRealtimeBridge } from './services/realtime.service'
import { startWorkers } from './workers'
import { SafetyRulesetService } from './services/safety-ruleset'
import { ScopeService } from './services/scope.service'

const app = Fastify({
  logger: false, // using pino directly
  bodyLimit: 2 * 1024 * 1024, // 2 MB
  trustProxy: true,
})


async function bootstrap() {
  // ── Dependencies ────────────────────────────────────────────────────────────
  await db.connect()
  logger.info('PostgreSQL connected')

  await connectRedis()

  // ── SAFETY RULESET — must be compiled before any request is served ────────
  // Loads emergency patterns from the DB into in-memory regex. If this fails,
  // it falls back to a hardcoded emergency floor rather than starting with
  // zero coverage.
  await new SafetyRulesetService().initialize()

  // Backfill embeddings for scope boundaries and role exemplars seeded by
  // migration 008 (they ship without vectors)
  const scope = new ScopeService()
  scope.embedPendingBoundaries()
    .then((n) => n > 0 && logger.info({ n }, 'Embedded scope boundaries'))
    .catch((err) => logger.warn({ err }, 'Boundary embedding backfill failed'))
  scope.embedPendingExemplars()
    .then((n) => n > 0 && logger.info({ n }, 'Embedded role exemplars'))
    .catch((err) => logger.warn({ err }, 'Exemplar embedding backfill failed'))

  // ── Moss index sync — non-blocking ────────────────────────────────────────
  // Populates Moss semantic search indexes from PostgreSQL. Runs in the
  // background so it never delays server readiness. If Moss is not configured
  // (no API key), this is a no-op.
  import('./services/moss-sync.service').then(({ MossSyncService }) => {
    new MossSyncService().syncAll()
      .catch((err) => logger.warn({ err }, 'Moss index sync failed'))
  })

  // ── Plugins ─────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: true, // Expo dev serves from a random LAN port
    credentials: true,
  })
  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers.authorization ?? req.ip,
  })

  // ── Request logging ─────────────────────────────────────────────────────────
  app.addHook('onRequest', async (req) => {
    ;(req as { startTime?: number }).startTime = Date.now()
  })

  app.addHook('onResponse', async (req, reply) => {
    const start = (req as { startTime?: number }).startTime ?? Date.now()
    logger.info(
      {
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        durationMs: Date.now() - start,
        userId: req.user?.id,
      },
      'request'
    )
  })

  // ── Global error handler ────────────────────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    logger.error(
      { err: err.message, stack: err.stack, url: req.url, userId: req.user?.id },
      'Unhandled route error'
    )
    reply.code(err.statusCode ?? 500).send({
      message:
        err.statusCode && err.statusCode < 500
          ? err.message
          : 'Something went wrong on our side. Please try again.',
    })
  })

  // Must be registered BEFORE the routes that declare `websocket: true`.
  await app.register(websocket, {
    options: {
      // A realtime nudge is a few hundred bytes; anything larger is either a
      // bug or an attack.
      maxPayload: 8 * 1024,
    },
  })

  await registerRoutes(app)

  // Cross-instance fan-out. Degrades to local-only delivery if Redis pub/sub
  // is unavailable, rather than failing startup.
  await startRealtimeBridge()

  // ── Background workers ──────────────────────────────────────────────────────
  await startWorkers()

  // ── Telegram bot — non-blocking ────────────────────────────────────────────
  import('./services/telegram.service').then(({ startTelegramBot }) => {
    startTelegramBot()
      .catch((err) => logger.warn({ err }, 'Telegram bot startup failed'))
  })

  // ── Listen ──────────────────────────────────────────────────────────────────
  const port = parseInt(process.env.PORT ?? '3000')
  await app.listen({ port, host: '0.0.0.0' })

  logger.info({ port }, '🚀 Locogi API listening')
  logger.info(
    `📱 Point your Expo app at: http://<your-lan-ip>:${port}`
  )
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down gracefully')
  const { stopTelegramBot } = await import('./services/telegram.service')
  stopTelegramBot()
  await stopRealtimeBridge()
  await app.close()
  const { closeMoss } = await import('./lib/moss')
  await closeMoss()
  await db.end()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

bootstrap().catch((err) => {
  logger.error({ err }, 'Fatal startup error')
  process.exit(1)
})
