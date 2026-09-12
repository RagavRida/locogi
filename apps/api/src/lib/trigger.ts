/**
 * Trigger.dev — Reliable background jobs for Locogi.
 *
 * Replaces BullMQ for critical workflows that need:
 * - Guaranteed delivery (order confirmations)
 * - Built-in retries (payment follow-ups)
 * - Observability dashboard (see all jobs)
 * - No self-managed Redis required
 *
 * Jobs defined here:
 *   1. orderConfirmation  — send Telegram + SMS confirmation after booking
 *   2. vendorNotification — alert business owner of new order
 *   3. paymentFollowUp    — retry failed payments
 *   4. reviewRequest      — ask for review 24h after service
 */

import { logger } from './logger'

// ─── Trigger.dev client ─────────────────────────────────────────────────────

interface TriggerJob {
  id: string
  name: string
  payload: Record<string, unknown>
}

const pendingJobs: TriggerJob[] = []

/**
 * Queue a background job via Trigger.dev.
 * Falls back to in-process execution if TRIGGER_API_KEY is not set.
 */
export async function triggerJob(
  jobId: string,
  jobName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const apiKey = process.env.TRIGGER_API_KEY
  const apiUrl = process.env.TRIGGER_API_URL ?? 'https://api.trigger.dev'

  if (!apiKey) {
    // Fallback: execute in-process (dev mode)
    logger.info({ jobId, jobName }, '[trigger] No API key — running job in-process')
    await executeJobLocally(jobId, jobName, payload)
    return
  }

  try {
    const response = await fetch(`${apiUrl}/api/v1/tasks/${jobId}/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ payload }),
    })

    if (!response.ok) {
      throw new Error(`Trigger.dev API error: ${response.status}`)
    }

    logger.info({ jobId, jobName }, '[trigger] Job queued successfully')
  } catch (err) {
    logger.warn({ err, jobId }, '[trigger] Failed to queue — falling back to in-process')
    await executeJobLocally(jobId, jobName, payload)
  }
}

// ─── Job implementations ────────────────────────────────────────────────────

async function executeJobLocally(
  jobId: string,
  jobName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  switch (jobId) {
    case 'order-confirmation':
      await handleOrderConfirmation(payload)
      break
    case 'vendor-notification':
      await handleVendorNotification(payload)
      break
    case 'payment-followup':
      await handlePaymentFollowUp(payload)
      break
    case 'review-request':
      await handleReviewRequest(payload)
      break
    default:
      logger.warn({ jobId }, '[trigger] Unknown job type')
  }
}

async function handleOrderConfirmation(payload: Record<string, unknown>) {
  const { orderId, customerTelegramId, orgName, items, total } = payload as any
  logger.info({ orderId, orgName }, '[trigger] Sending order confirmation')

  // Send Telegram confirmation to customer
  if (customerTelegramId && process.env.TELEGRAM_BOT_TOKEN) {
    const message = [
      `✅ *Booking Confirmed!*`,
      ``,
      `📋 *Order #${orderId}*`,
      `🏪 ${orgName}`,
      ``,
      ...(items ?? []).map((i: any) => `• ${i.name} × ${i.quantity} — ₹${i.price * i.quantity}`),
      ``,
      `💰 *Total: ₹${total}*`,
      ``,
      `Thank you for booking with Locogi! 🎉`,
    ].join('\n')

    try {
      await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: customerTelegramId,
            text: message,
            parse_mode: 'Markdown',
          }),
        },
      )
    } catch (err) {
      logger.warn({ err }, '[trigger] Failed to send Telegram confirmation')
    }
  }
}

async function handleVendorNotification(payload: Record<string, unknown>) {
  const { orgId, orderId, customerName, items, total } = payload as any
  logger.info({ orgId, orderId }, '[trigger] Notifying vendor of new order')
  // TODO: Send push notification to vendor dashboard via WebSocket
  // TODO: Send SMS/WhatsApp to vendor phone
}

async function handlePaymentFollowUp(payload: Record<string, unknown>) {
  const { orderId, attempt } = payload as any
  logger.info({ orderId, attempt }, '[trigger] Payment follow-up')
  // TODO: Retry payment collection
  // TODO: Send reminder to customer if payment pending
}

async function handleReviewRequest(payload: Record<string, unknown>) {
  const { customerTelegramId, orgName, orderId } = payload as any
  logger.info({ orderId }, '[trigger] Sending review request')

  if (customerTelegramId && process.env.TELEGRAM_BOT_TOKEN) {
    const message = [
      `Hi! 👋`,
      ``,
      `How was your experience with ${orgName}?`,
      `We'd love to hear your feedback!`,
      ``,
      `Rate: ⭐⭐⭐⭐⭐`,
    ].join('\n')

    try {
      await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: customerTelegramId,
            text: message,
          }),
        },
      )
    } catch (err) {
      logger.warn({ err }, '[trigger] Failed to send review request')
    }
  }
}

// ─── Convenience wrappers ───────────────────────────────────────────────────

export const triggerOrderConfirmation = (payload: {
  orderId: string
  customerTelegramId?: string
  orgName: string
  items: Array<{ name: string; quantity: number; price: number }>
  total: number
}) => triggerJob('order-confirmation', 'Send Order Confirmation', payload)

export const triggerVendorNotification = (payload: {
  orgId: string
  orderId: string
  customerName: string
  items: Array<{ name: string; quantity: number; price: number }>
  total: number
}) => triggerJob('vendor-notification', 'Notify Vendor', payload)

export const triggerReviewRequest = (payload: {
  customerTelegramId: string
  orgName: string
  orderId: string
}) => triggerJob('review-request', 'Request Review', payload)
