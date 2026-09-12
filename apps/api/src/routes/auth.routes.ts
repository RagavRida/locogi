import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { query } from '../lib/db'
import { checkRateLimit, storeOTP, getOTP, deleteOTP, redis } from '../lib/redis'
import {
  signAccessToken,
  signRefreshToken,
  rotateRefreshToken,
  revokeAllTokens,
  requireAuth,
} from '../lib/auth'
import { logger } from '../lib/logger'
import { requestRepo } from '../repositories'

const PhoneSchema = z.object({
  phone: z.string().regex(/^\+91[6-9]\d{9}$/, 'Invalid Indian mobile number'),
})

const VerifySchema = PhoneSchema.extend({
  otp: z.string().length(6).regex(/^\d{6}$/),
})

function generateOTP(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

export async function authRoutes(app: FastifyInstance) {
  // ─── Send OTP ───────────────────────────────────────────────────────────────
  app.post('/auth/send-otp', async (req, reply) => {
    const parsed = PhoneSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }
    const { phone } = parsed.data

    // Rate limit: 3 per 10 minutes per phone
    const allowed = await checkRateLimit(`otp_send:${phone}`, 3, 600)
    if (!allowed) {
      return reply.code(429).send({
        message: 'Too many attempts. Please wait 10 minutes.',
      })
    }

    // Prevent duplicate sends on double-tap (Redis NX lock, 30s)
    const lockKey = `otp_lock:${phone}`
    const lock = await redis.set(lockKey, '1', { NX: true, EX: 30 })
    if (!lock) {
      return reply.send({ success: true }) // idempotent — already sent
    }

    const otp = generateOTP()
    await storeOTP(phone, otp)

    // In production: send via MSG91 / Firebase
    // For dev: log it so you can test without SMS costs
    if (process.env.NODE_ENV !== 'production') {
      logger.info({ phone, otp }, '📱 DEV OTP — use this code to log in')
    } else {
      await sendOTPviaMSG91(phone, otp)
    }

    return reply.send({ success: true })
  })

  // ─── Verify OTP ─────────────────────────────────────────────────────────────
  app.post('/auth/verify-otp', async (req, reply) => {
    const parsed = VerifySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid phone or OTP format' })
    }
    const { phone, otp } = parsed.data

    // Rate limit failed attempts: 5 per 10 min
    const allowed = await checkRateLimit(`otp_verify:${phone}`, 5, 600)
    if (!allowed) {
      return reply.code(429).send({
        message: 'Too many failed attempts. Locked for 10 minutes.',
      })
    }

    const stored = await getOTP(phone)
    if (!stored || stored !== otp) {
      return reply.code(401).send({ message: 'Incorrect or expired code' })
    }

    await deleteOTP(phone)

    // Upsert user
    const result = await query<{
      id: string
      is_vendor: boolean
      is_customer: boolean
      name: string | null
    }>(
      `INSERT INTO users (phone, consent_given_at)
       VALUES ($1, now())
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING id, is_vendor, is_customer, name`,
      [phone]
    )

    const user = result.rows[0]
    if (!user) return reply.code(500).send({ message: 'Could not create account' })

    const accessToken = signAccessToken(user.id)
    const refreshToken = await signRefreshToken(user.id)

    // Determine if they've already picked a role
    const hasRole = user.is_vendor || user.is_customer
    const role = user.is_vendor && user.is_customer
      ? 'both'
      : user.is_vendor
      ? 'vendor'
      : user.is_customer
      ? 'customer'
      : null

    logger.info({ userId: user.id }, 'User authenticated')

    return reply.send({
      accessToken,
      refreshToken,
      userId: user.id,
      name: user.name,
      role: hasRole ? role : null,
    })
  })

  // ─── Refresh token ──────────────────────────────────────────────────────────
  app.post('/auth/refresh', async (req, reply) => {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: string }
    if (!refreshToken) {
      return reply.code(400).send({ message: 'Missing refresh token' })
    }

    const rotated = await rotateRefreshToken(refreshToken)
    if (!rotated) {
      return reply.code(401).send({ message: 'Invalid refresh token' })
    }

    return reply.send(rotated)
  })

  // ─── Logout ─────────────────────────────────────────────────────────────────
  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await revokeAllTokens(req.user!.id)
    return reply.send({ success: true })
  })

  // ─── Delete account (DPDP compliance) ──────────────────────────────────────
  app.delete('/auth/account', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user!.id

    // 1. Cancel active bookings, and learn which ones those were.
    //
    // This was a SELECT with a hardcoded status list followed by an UPDATE
    // with a different hardcoded list. Two problems: the lists could drift
    // (and had), and a request could change state between the read and the
    // write, so responses were marked missed for bookings that were never
    // cancelled. RETURNING collapses both into one statement.
    const cancelled = await requestRepo.cancelAllActiveForCustomer(userId)

    if (cancelled.length > 0) {
      await query(
        `UPDATE request_responses SET status = 'missed'
         WHERE request_id = ANY($1::uuid[])`,
        [cancelled.map((r) => r.id)]
      )
      logger.info(
        { userId, cancelled: cancelled.length },
        'Cancelled active bookings for account deletion'
      )
    }

    // 2. Nullify personal data (retain anonymized records for audit)
    await query(
      `UPDATE users
       SET name = NULL,
           phone = 'deleted_' || id::text,
           emergency_contact_phone = NULL
       WHERE id = $1`,
      [userId]
    )
    await query(
      `UPDATE vendors SET raw_description = '[deleted]' WHERE user_id = $1`,
      [userId]
    )
    await query(
      `UPDATE requests SET raw_description = '[deleted]' WHERE customer_id = $1`,
      [userId]
    )

    // 3. Revoke all tokens
    await revokeAllTokens(userId)

    logger.info({ userId }, 'Account deleted (DPDP request)')
    return reply.send({ success: true, cancelledBookings: cancelled.length })
  })
}

// ─── MSG91 SMS/WhatsApp sender ────────────────────────────────────────────────
async function sendOTPviaMSG91(phone: string, otp: string): Promise<void> {
  const authKey = process.env.MSG91_AUTH_KEY
  const templateId = process.env.MSG91_OTP_TEMPLATE_ID
  if (!authKey || !templateId) {
    logger.error('MSG91 not configured — cannot send OTP in production')
    throw new Error('SMS provider not configured')
  }

  const res = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authkey: authKey,
    },
    body: JSON.stringify({
      template_id: templateId,
      recipients: [{ mobiles: phone.replace('+', ''), OTP: otp }],
    }),
  })

  if (!res.ok) {
    logger.error({ status: res.status }, 'MSG91 OTP send failed')
    throw new Error('Could not send OTP')
  }
}
