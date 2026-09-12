import { Queue } from 'bullmq'
import { logger } from './logger'

const connection = { url: process.env.REDIS_URL! }

// ─── Queues ───────────────────────────────────────────────────────────────────
export const embeddingQueue = new Queue('embedding', { connection })
export const expiryQueue = new Queue('expiry', { connection })
export const reminderQueue = new Queue('reminder', { connection })
export const outboxQueue = new Queue('outbox', { connection })

// ─── Job payload types ────────────────────────────────────────────────────────
export interface EmbeddingJob {
  type: 'vendor' | 'request'
  id: string
  text: string
}

export interface ReminderJob {
  requestId: string
  userId: string
  slotTime: string
}

// ─── Enqueue helpers ──────────────────────────────────────────────────────────
export async function enqueueEmbedding(job: EmbeddingJob): Promise<void> {
  await embeddingQueue.add('generate', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: true,
    removeOnFail: 50,
  })
}

export async function enqueueReminder(
  requestId: string,
  userId: string,
  slotTime: string,
  runAt: Date
): Promise<void> {
  const delay = runAt.getTime() - Date.now()
  if (delay <= 0) return

  await reminderQueue.add(
    'appointment',
    { requestId, userId, slotTime } satisfies ReminderJob,
    {
      delay,
      attempts: 2,
      removeOnComplete: true,
      jobId: `reminder-${requestId}`, // idempotent — one reminder per request
    }
  )
}

export async function enqueueNotification(
  payload: Record<string, unknown>,
  delayMs = 0
): Promise<void> {
  await outboxQueue.add('notify', payload, {
    delay: delayMs,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
  })
}

logger.info('BullMQ queues initialized')
