import { Worker } from 'bullmq'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { NotificationService } from '../services/notification.service'
import type { ReminderJob } from '../lib/queue'

const notifications = new NotificationService()

export const reminderWorker = new Worker<ReminderJob>(
  'reminder',
  async (job) => {
    const { requestId, userId, slotTime } = job.data

    // Only remind if the booking is still active
    const result = await query<{
      status: string
      vendor_name: string | null
      service_area: string | null
    }>(
      `SELECT r.status, u.name AS vendor_name, v.service_area_description AS service_area
       FROM requests r
       LEFT JOIN vendors v ON v.id = r.confirmed_vendor_id
       LEFT JOIN users u ON u.id = v.user_id
       WHERE r.id = $1`,
      [requestId]
    )

    const row = result.rows[0]
    if (!row || row.status !== 'confirmed') {
      logger.debug({ requestId }, 'Skipping reminder — booking no longer confirmed')
      return
    }

    const timeStr = new Date(slotTime).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    })

    await notifications.deliver(
      userId,
      {
        title: '⏰ Appointment in 1 hour',
        body: `${row.vendor_name ?? 'Your vendor'} at ${timeStr}${
          row.service_area ? ` · ${row.service_area}` : ''
        }`,
        data: { type: 'reminder', requestId, deepLink: `locogi://chat/${requestId}` },
      },
      true
    )

    await query(
      `INSERT INTO events (event_type, request_id, user_id, metadata)
       VALUES ('appointment_reminder_sent', $1, $2, $3)`,
      [requestId, userId, JSON.stringify({ slotTime })]
    )

    logger.info({ requestId }, 'Appointment reminder sent')
  },
  { connection: { url: process.env.REDIS_URL! } }
)
