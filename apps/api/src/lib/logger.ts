import pino from 'pino'
import { logFields } from './correlation'

/**
 * The application logger.
 *
 * ── The `mixin` line is the whole correlation feature ───────────────────────
 *
 * pino calls it on EVERY log statement and merges the result into the output.
 * That is what lets ~196 existing `logger.info(...)` calls gain a correlation
 * id, a userId and a bookingId without one of them being edited — and, more
 * importantly, what stops the next person having to remember.
 *
 * It returns `{}` outside a request context, so scripts, migrations and tests
 * log exactly as they did before.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  redact: ['req.headers.authorization', 'phone', 'emergencyContactPhone'],
  mixin: logFields,
})
