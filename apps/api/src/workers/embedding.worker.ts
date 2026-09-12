import { Worker } from 'bullmq'
import { generateEmbedding } from '../lib/nim'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import type { EmbeddingJob } from '../lib/queue'

export const embeddingWorker = new Worker<EmbeddingJob>(
  'embedding',
  async (job) => {
    const { type, id, text } = job.data
    logger.info({ type, id }, 'Generating embedding')

    const embedding = await generateEmbedding(text)
    if (!embedding.length) throw new Error('Empty embedding returned')

    const table = type === 'vendor' ? 'vendors' : 'requests'
    await query(
      `UPDATE ${table}
       SET embedding = $1::vector, embedding_generated_at = now()
       WHERE id = $2`,
      [`[${embedding.join(',')}]`, id]
    )

    logger.info({ type, id }, 'Embedding stored')
  },
  {
    connection: { url: process.env.REDIS_URL! },
    concurrency: 5,
  }
)

embeddingWorker.on('failed', (job, err) => {
  logger.error({ job: job?.id, err }, 'Embedding job failed')
})
