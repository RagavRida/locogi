/**
 * NotificationService — Expo Push with WhatsApp/SMS fallback.
 *
 * Channels are tried in priority order. Each implements NotificationChannel
 * so adding a new one (e.g. email) means a new class, not editing this file.
 */

import { query } from '../lib/db'
import { enqueueNotification, enqueueReminder } from '../lib/queue'
import { logger } from '../lib/logger'
import { enqueueOutbox } from '../lib/outbox'
import type { Vendor } from '@locogi/types'

// ─── Channel abstraction (Dependency Inversion) ───────────────────────────────
export interface NotificationPayload {
  title: string
  body: string
  data?: Record<string, unknown>
}

export interface NotificationChannel {
  readonly name: string
  send(userId: string, payload: NotificationPayload): Promise<boolean>
}

// ─── Expo Push ────────────────────────────────────────────────────────────────
class ExpoPushChannel implements NotificationChannel {
  readonly name = 'expo'

  async send(userId: string, payload: NotificationPayload): Promise<boolean> {
    const tokens = await query<{ token: string }>(
      'SELECT token FROM push_tokens WHERE user_id = $1 AND is_active = true',
      [userId]
    )
    if (tokens.rows.length === 0) return false

    const messages = tokens.rows.map((t) => ({
      to: t.token,
      sound: 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      priority: 'high',
    }))

    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(messages),
      })

      if (!res.ok) {
        logger.warn({ status: res.status }, 'Expo push request failed')
        return false
      }

      const result = (await res.json()) as {
        data?: Array<{ status: string; details?: { error?: string } }>
      }

      // Deactivate dead tokens
      let anyDelivered = false
      result.data?.forEach((r, i) => {
        if (r.status === 'ok') {
          anyDelivered = true
        } else if (r.details?.error === 'DeviceNotRegistered') {
          const deadToken = tokens.rows[i]?.token
          if (deadToken) {
            query(
              'UPDATE push_tokens SET is_active = false WHERE token = $1',
              [deadToken]
            ).catch(() => {})
            logger.info({ deadToken: deadToken.slice(-8) }, 'Deactivated dead push token')
          }
        }
      })

      return anyDelivered
    } catch (err) {
      logger.error({ err }, 'Expo push send threw')
      return false
    }
  }
}

// ─── WhatsApp via MSG91 (fallback for critical events) ────────────────────────
class WhatsAppChannel implements NotificationChannel {
  readonly name = 'whatsapp'

  async send(userId: string, payload: NotificationPayload): Promise<boolean> {
    const authKey = process.env.MSG91_AUTH_KEY
    if (!authKey) return false

    const user = await query<{ phone: string }>(
      'SELECT phone FROM users WHERE id = $1',
      [userId]
    )
    const phone = user.rows[0]?.phone
    if (!phone || phone.startsWith('deleted_')) return false

    try {
      const res = await fetch('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authkey: authKey },
        body: JSON.stringify({
          integrated_number: process.env.MSG91_WA_NUMBER,
          content_type: 'text',
          payload: {
            to: phone.replace('+', ''),
            type: 'text',
            text: { body: `${payload.title}\n\n${payload.body}` },
          },
        }),
      })
      return res.ok
    } catch (err) {
      logger.error({ err }, 'WhatsApp send failed')
      return false
    }
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────
export class NotificationService {
  private channels: NotificationChannel[] = [
    new ExpoPushChannel(),
    new WhatsAppChannel(),
  ]

  /** Try each channel in order until one succeeds. */
  async deliver(
    userId: string,
    payload: NotificationPayload,
    critical = false
  ): Promise<void> {
    for (const channel of this.channels) {
      const ok = await channel.send(userId, payload)
      if (ok) {
        logger.debug({ userId, channel: channel.name }, 'Notification delivered')
        return
      }
      // Only fall through to the next channel for critical events
      if (!critical) break
    }

    // Nothing worked — write to outbox for retry
    await enqueueOutbox('notification_failed', { userId, payload })
    logger.warn({ userId, title: payload.title }, 'All notification channels failed')
  }

  // ─── Fan out a new request to matched vendors ──────────────────────────────
  async notifyVendorsOfRequest(
    vendors: Vendor[],
    requestId: string,
    description: string,
    bookingType: string
  ): Promise<void> {
    const preview = description.length > 90 ? `${description.slice(0, 90)}…` : description

    await Promise.all(
      vendors.map((v) =>
        this.deliver(v.userId, {
          title: bookingType === 'hiring' ? '📋 New opportunity' : '📬 New job request',
          body: preview,
          data: { type: 'new_request', requestId, deepLink: `locogi://chat/${requestId}` },
        })
      )
    )

    await this.logEvent('vendor_notified', { requestId, count: vendors.length })
  }

  // ─── Notify customer that a quote arrived ──────────────────────────────────
  async notifyCustomerOfQuote(
    requestId: string,
    vendorId: string,
    price: number
  ): Promise<void> {
    const result = await query<{ customer_id: string; vendor_name: string | null }>(
      `SELECT r.customer_id, u.name AS vendor_name
       FROM requests r
       LEFT JOIN vendors v ON v.id = $2
       LEFT JOIN users u ON u.id = v.user_id
       WHERE r.id = $1`,
      [requestId, vendorId]
    )
    const row = result.rows[0]
    if (!row) return

    await this.deliver(
      row.customer_id,
      {
        title: '💰 New quote received',
        body: `${row.vendor_name ?? 'A vendor'} quoted ₹${price.toLocaleString('en-IN')}`,
        data: { type: 'quote', requestId, deepLink: `locogi://chat/${requestId}` },
      },
      true // critical
    )

    await this.logEvent('quote_sent', { requestId, vendorId, price })
  }

  // ─── Notify both parties on confirmation ───────────────────────────────────
  async notifyBookingConfirmed(requestId: string): Promise<void> {
    const result = await query<{
      customer_id: string
      vendor_user_id: string | null
      agreed_price: number | null
      customer_name: string | null
      vendor_name: string | null
    }>(
      `SELECT r.customer_id, v.user_id AS vendor_user_id, r.agreed_price,
              cu.name AS customer_name, vu.name AS vendor_name
       FROM requests r
       LEFT JOIN vendors v ON v.id = r.confirmed_vendor_id
       LEFT JOIN users vu ON vu.id = v.user_id
       LEFT JOIN users cu ON cu.id = r.customer_id
       WHERE r.id = $1`,
      [requestId]
    )
    const row = result.rows[0]
    if (!row) return

    const price = row.agreed_price
      ? `₹${row.agreed_price.toLocaleString('en-IN')}`
      : ''

    // Customer
    await this.deliver(
      row.customer_id,
      {
        title: '✅ Booking confirmed',
        body: `${row.vendor_name ?? 'Your vendor'} is confirmed ${price}`.trim(),
        data: { type: 'confirmed', requestId, deepLink: `locogi://chat/${requestId}` },
      },
      true
    )

    // Vendor
    if (row.vendor_user_id) {
      await this.deliver(
        row.vendor_user_id,
        {
          title: '🎉 You got the job!',
          body: `${row.customer_name ?? 'A customer'} accepted your quote ${price}`.trim(),
          data: { type: 'won_job', requestId, deepLink: `locogi://chat/${requestId}` },
        },
        true
      )
    }

    // Notify the vendors who lost — soft message, no mention of who won
    const missed = await query<{ user_id: string }>(
      `SELECT v.user_id
       FROM request_responses rr
       JOIN vendors v ON v.id = rr.vendor_id
       WHERE rr.request_id = $1 AND rr.status = 'missed'`,
      [requestId]
    )
    await Promise.all(
      missed.rows.map((m) =>
        this.deliver(m.user_id, {
          title: 'Request closed',
          body: 'This job has been filled. More requests coming your way.',
          data: { type: 'request_closed', requestId },
        })
      )
    )

    await this.logEvent('request_confirmed', { requestId })
  }

  // ─── Notify vendor of a counter-offer ──────────────────────────────────────
  async notifyVendorOfCounter(responseId: string, counterPrice: number): Promise<void> {
    const result = await query<{ user_id: string; request_id: string }>(
      `SELECT v.user_id, rr.request_id
       FROM request_responses rr
       JOIN vendors v ON v.id = rr.vendor_id
       WHERE rr.id = $1`,
      [responseId]
    )
    const row = result.rows[0]
    if (!row) return

    await this.deliver(row.user_id, {
      title: '💬 Counter offer',
      body: `The customer countered with ₹${counterPrice.toLocaleString('en-IN')}`,
      data: {
        type: 'counter',
        requestId: row.request_id,
        deepLink: `locogi://chat/${row.request_id}`,
      },
    })
  }

  // ─── Appointment reminder (1 hour before) ──────────────────────────────────
  async scheduleAppointmentReminder(
    requestId: string,
    userId: string,
    slotTime: string
  ): Promise<void> {
    const runAt = new Date(new Date(slotTime).getTime() - 60 * 60 * 1000)
    if (runAt <= new Date()) return // slot is within the hour already

    await enqueueReminder(requestId, userId, slotTime, runAt)
    logger.info({ requestId, runAt }, 'Appointment reminder scheduled')
  }

  // ─── Request expired ───────────────────────────────────────────────────────
  async notifyRequestExpired(requestId: string, customerId: string): Promise<void> {
    await this.deliver(customerId, {
      title: '⏰ No response yet',
      body: 'No vendor responded in time. Try again with a wider area or budget.',
      data: { type: 'expired', requestId, deepLink: `locogi://chat/${requestId}` },
    })
    await this.logEvent('request_expired', { requestId })
  }

  // ─── A new vendor joined that matches a previously unmatched request ───────
  async notifyNoMatchResolved(requestId: string, customerId: string): Promise<void> {
    await this.deliver(customerId, {
      title: '🎉 A vendor is now available',
      body: 'Someone just joined who can help with your request. Tap to book.',
      data: { type: 'no_match_resolved', requestId, deepLink: `locogi://chat/${requestId}` },
    })
  }

  // ─── Analytics event log ───────────────────────────────────────────────────
  private async logEvent(
    eventType: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO events (event_type, request_id, metadata)
         VALUES ($1, $2, $3)`,
        [eventType, metadata.requestId ?? null, JSON.stringify(metadata)]
      )
    } catch (err) {
      logger.error({ err, eventType }, 'Event log failed')
    }
  }
}
