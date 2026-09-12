import { Queue } from 'bullmq'
import { logger } from '../lib/logger'
import { embeddingWorker } from './embedding.worker'
import { expiryWorker } from './expiry.worker'
import { reminderWorker } from './reminder.worker'
import { outboxWorker } from './outbox.worker'
import { taxonomyWorker } from './taxonomy.worker'
import { demandWorker } from './demand.worker'
import { bookingMaintenanceWorker } from './booking-maintenance.worker'
import { opsDigestWorker } from './ops-digest.worker'
import { webhookWorker } from './webhook.worker'

const connection = { url: process.env.REDIS_URL! }

export async function startWorkers(): Promise<void> {
  // Repeatable job: expire stale requests every 5 minutes
  const expiryQueue = new Queue('expiry', { connection })
  await expiryQueue.add(
    'sweep',
    {},
    {
      repeat: { every: 5 * 60 * 1000 },
      removeOnComplete: true,
      jobId: 'expiry-sweep', // prevents duplicate repeatable jobs on restart
    }
  )

  // Repeatable job: process the outbox every 10 seconds
  const outboxQueue = new Queue('outbox', { connection })
  await outboxQueue.add(
    'drain',
    {},
    {
      repeat: { every: 10 * 1000 },
      removeOnComplete: true,
      jobId: 'outbox-drain',
    }
  )

  // Repeatable job: taxonomy maintenance hourly
  const taxonomyQueue = new Queue('taxonomy', { connection })
  await taxonomyQueue.add(
    'maintain',
    {},
    {
      repeat: { every: 60 * 60 * 1000 },
      removeOnComplete: true,
      jobId: 'taxonomy-maintain',
    }
  )

  // Repeatable job: cluster unmet demand every 6 hours
  const demandQueue = new Queue('demand', { connection })
  await demandQueue.add(
    'cluster',
    {},
    {
      repeat: { every: 6 * 60 * 60 * 1000 },
      removeOnComplete: true,
      jobId: 'demand-cluster',
    }
  )

  // Repeatable job: booking maintenance hourly.
  // Rolls the slot window forward (prevents silent slot exhaustion),
  // materialises recurring bookings, detects no-shows, manages the waitlist.
  const maintenanceQueue = new Queue('booking-maintenance', { connection })
  await maintenanceQueue.add(
    'maintain',
    {},
    {
      repeat: { every: 60 * 60 * 1000 },
      removeOnComplete: true,
      jobId: 'booking-maintenance',
    }
  )

  // Repeatable job: ops digest daily at 9:00 IST (03:30 UTC).
  // Pushes the review queue instead of waiting for someone to open a dashboard.
  const digestQueue = new Queue('ops-digest', { connection })
  await digestQueue.add(
    'digest',
    {},
    {
      repeat: { pattern: '30 3 * * *' }, // 03:30 UTC = 09:00 IST
      removeOnComplete: true,
      jobId: 'ops-digest-daily',
    }
  )

  // Repeatable job: deliver webhooks every 5 seconds
  const webhookQueue = new Queue('webhooks', { connection })
  await webhookQueue.add(
    'deliver',
    {},
    {
      repeat: { every: 5 * 1000 },
      removeOnComplete: true,
      jobId: 'webhook-deliver',
    }
  )

  const workers = [
    embeddingWorker,
    expiryWorker,
    reminderWorker,
    outboxWorker,
    taxonomyWorker,
    demandWorker,
    bookingMaintenanceWorker,
    opsDigestWorker,
    webhookWorker,
  ]

  workers.forEach((w) => {
    w.on('failed', (job, err) => {
      logger.error({ worker: w.name, jobId: job?.id, err: err.message }, 'Job failed')
    })
    w.on('completed', (job) => {
      logger.debug({ worker: w.name, jobId: job.id }, 'Job completed')
    })
  })

  logger.info({ count: workers.length }, 'Background workers started')
}
