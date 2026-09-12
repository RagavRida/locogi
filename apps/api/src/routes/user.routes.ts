import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { query } from '../lib/db'
import { requireAuth } from '../lib/auth'
import { requestRepo } from '../repositories'
import { logger } from '../lib/logger'

const RoleSchema = z.object({
  isVendor: z.boolean(),
  isCustomer: z.boolean(),
})

const ProfileSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  emergencyContactPhone: z
    .string()
    .regex(/^\+91[6-9]\d{9}$/)
    .optional()
    .nullable(),
})

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ─── Set role ───────────────────────────────────────────────────────────────
  app.patch('/users/role', async (req, reply) => {
    const parsed = RoleSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid role' })
    }
    const { isVendor, isCustomer } = parsed.data

    if (!isVendor && !isCustomer) {
      return reply.code(400).send({ message: 'Pick at least one role' })
    }

    await query(
      'UPDATE users SET is_vendor = $1, is_customer = $2 WHERE id = $3',
      [isVendor, isCustomer, req.user!.id]
    )

    logger.info({ userId: req.user!.id, isVendor, isCustomer }, 'Role updated')
    return reply.send({ success: true })
  })

  // ─── Get own profile ───────────────────────────────────────────────────────
  app.get('/users/me', async (req, reply) => {
    const result = await query<{
      id: string
      name: string | null
      phone: string
      is_vendor: boolean
      is_customer: boolean
      emergency_contact_phone: string | null
      created_at: string
    }>(
      `SELECT id, name, phone, is_vendor, is_customer,
              emergency_contact_phone, created_at
       FROM users WHERE id = $1`,
      [req.user!.id]
    )

    const u = result.rows[0]
    if (!u) return reply.code(404).send({ message: 'User not found' })

    return reply.send({
      id: u.id,
      name: u.name,
      phone: u.phone,
      isVendor: u.is_vendor,
      isCustomer: u.is_customer,
      hasEmergencyContact: !!u.emergency_contact_phone,
      createdAt: u.created_at,
    })
  })

  // ─── Update profile ────────────────────────────────────────────────────────
  app.patch('/users/me', async (req, reply) => {
    const parsed = ProfileSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }
    const d = parsed.data

    const updates: string[] = []
    const values: unknown[] = []
    let i = 1

    if (d.name !== undefined) {
      updates.push(`name = $${i++}`)
      values.push(d.name.replace(/<[^>]*>/g, '')) // sanitize
    }
    if (d.emergencyContactPhone !== undefined) {
      updates.push(`emergency_contact_phone = $${i++}`)
      values.push(d.emergencyContactPhone)
    }

    if (updates.length === 0) {
      return reply.send({ success: true })
    }

    values.push(req.user!.id)
    await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i}`,
      values
    )

    return reply.send({ success: true })
  })

  // ─── Register push token ───────────────────────────────────────────────────
  app.post('/push-tokens', async (req, reply) => {
    const { token, platform } = (req.body ?? {}) as {
      token?: string
      platform?: 'ios' | 'android'
    }
    if (!token) return reply.code(400).send({ message: 'Missing token' })

    await query(
      `INSERT INTO push_tokens (user_id, token, platform, last_used_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             is_active = true,
             last_used_at = now()`,
      [req.user!.id, token, platform ?? 'android']
    )

    return reply.send({ success: true })
  })

  // ─── Deregister push token (logout) ────────────────────────────────────────
  app.delete<{ Params: { token: string } }>('/push-tokens/:token', async (req, reply) => {
    await query(
      'UPDATE push_tokens SET is_active = false WHERE token = $1 AND user_id = $2',
      [req.params.token, req.user!.id]
    )
    return reply.send({ success: true })
  })
}

// ─── Reviews ──────────────────────────────────────────────────────────────────
export async function reviewRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  const ReviewSchema = z.object({
    requestId: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(1000).optional(),
  })

  app.post('/reviews', async (req, reply) => {
    const parsed = ReviewSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid review' })
    }
    const { requestId, rating, comment } = parsed.data

    // Verify the request is completed and belongs to this user
    const r = await requestRepo.findForReview(requestId, req.user!.id)
    if (!r) return reply.code(404).send({ message: 'Request not found' })
    if (r.status !== 'completed') {
      return reply.code(409).send({ message: 'Job is not completed yet' })
    }
    if (!r.confirmedVendorId) {
      return reply.code(409).send({ message: 'No vendor to review' })
    }

    // Insert — unique constraint prevents duplicates, so return existing on conflict
    const result = await query<{ id: string }>(
      `INSERT INTO reviews (request_id, reviewer_id, vendor_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (request_id, reviewer_id) DO NOTHING
       RETURNING id`,
      [requestId, req.user!.id, r.confirmedVendorId, rating, comment?.replace(/<[^>]*>/g, '') ?? null]
    )

    if (result.rowCount === 0) {
      return reply.send({ success: true, alreadyReviewed: true })
    }

    // Recalculate the vendor's average rating
    await query(
      `UPDATE vendors SET rating = (
         SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE vendor_id = $1
       ) WHERE id = $1`,
      [r.confirmedVendorId]
    )

    logger.info({ requestId, rating }, 'Review submitted')
    return reply.send({ success: true })
  })
}
