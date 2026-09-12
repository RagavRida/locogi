/**
 * Telegram webhook route.
 *
 * In production, Telegram sends updates to POST /telegram/webhook.
 * In development, the bot uses long-polling (no route needed).
 *
 * Setup webhook:
 *   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *     -d '{"url": "https://your-api.railway.app/telegram/webhook"}'
 */

import type { FastifyInstance } from 'fastify'
import { getTelegramBot } from '../services/telegram.service'
import { logger } from '../lib/logger'

export async function telegramRoutes(app: FastifyInstance) {
  // Telegram sends webhook updates here
  app.post('/telegram/webhook', async (req, reply) => {
    const bot = getTelegramBot()
    if (!bot) {
      return reply.code(503).send({ message: 'Telegram bot not configured' })
    }

    try {
      // Pass the update to Telegraf for processing
      await bot.handleUpdate(req.body as any)
      return reply.code(200).send({ ok: true })
    } catch (err) {
      logger.error({ err }, 'Telegram webhook error')
      return reply.code(200).send({ ok: true }) // Always 200 to prevent retries
    }
  })

  // Health check for Telegram bot
  app.get('/telegram/status', async (_req, reply) => {
    const bot = getTelegramBot()
    return reply.send({
      enabled: !!bot,
      mode: process.env.TELEGRAM_WEBHOOK_URL ? 'webhook' : 'polling',
    })
  })
}
