import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { auth0Configuration, verifyAuth0AccessToken } from '../lib/auth0'
import { requireAuth, signAccessToken, signRefreshToken } from '../lib/auth'
import { withTransaction } from '../lib/db'
import { checkRateLimit } from '../lib/redis'

const BodySchema = z.object({ locogiAccessToken: z.string().min(1).max(16384).optional() }).strict()
type LocalUser = { id: string; phone: string; name: string | null; is_vendor: boolean; is_customer: boolean; is_banned: boolean }

export async function socialAuthRoutes(app: FastifyInstance) {
  app.post('/auth/social', async (req, reply) => {
    if (!auth0Configuration()) return reply.code(503).send({ code: 'AUTH0_NOT_CONFIGURED', message: 'Auth0 token exchange is not configured on this API.' })
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ') || header.length > 16391) return reply.code(401).send({ message: 'An Auth0 API access token is required.' })
    const parsed = BodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid exchange request.' })
    if (!await checkRateLimit(`auth0_exchange:${req.ip}`, 30, 60)) return reply.code(429).send({ message: 'Too many authentication attempts.' })
    let identity: { issuer: string; subject: string }
    try { identity = await verifyAuth0AccessToken(header.slice(7)) }
    catch { return reply.code(401).send({ message: 'Invalid or expired Auth0 API access token.' }) }

    let linkedUserId: string | undefined
    if (parsed.data.locogiAccessToken) {
      req.headers.authorization = `Bearer ${parsed.data.locogiAccessToken}`
      try {
        await requireAuth(req, reply)
        if (reply.sent || !req.user) return
        linkedUserId = req.user.id
      } finally { req.headers.authorization = header }
    }

    const result = await withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${identity.issuer}|${identity.subject}`])
      const existing = await client.query<{ user_id: string }>('SELECT user_id FROM auth_identities WHERE issuer = $1 AND subject = $2', [identity.issuer, identity.subject])
      const mappedId = existing.rows[0]?.user_id
      if (mappedId && linkedUserId && mappedId !== linkedUserId) return { error: 'ACCOUNT_LINK_CONFLICT' as const }
      const userId = mappedId ?? linkedUserId
      if (!userId) return { error: 'PHONE_LINK_REQUIRED' as const }
      const users = await client.query<LocalUser>('SELECT id, phone, name, is_vendor, is_customer, is_banned FROM users WHERE id = $1 FOR SHARE', [userId])
      const user = users.rows[0]
      if (!user || user.is_banned || user.phone.startsWith('deleted_')) return { error: 'ACCOUNT_UNAVAILABLE' as const }
      if (!mappedId) await client.query('INSERT INTO auth_identities (issuer, subject, user_id) VALUES ($1, $2, $3)', [identity.issuer, identity.subject, user.id])
      await client.query('UPDATE auth_identities SET last_login_at = now() WHERE issuer = $1 AND subject = $2', [identity.issuer, identity.subject])
      return { user }
    })
    if ('error' in result) {
      const status = result.error === 'ACCOUNT_UNAVAILABLE' ? 403 : 409
      return reply.code(status).send({ code: result.error, message: result.error === 'PHONE_LINK_REQUIRED' ? 'Verify your phone once to link your Locogi account.' : 'This account cannot be linked or used.' })
    }
    const user = result.user
    const accessToken = signAccessToken(user.id)
    const refreshToken = await signRefreshToken(user.id)
    return reply.header('Cache-Control', 'no-store').send({ accessToken, refreshToken, userId: user.id, user: { id: user.id, phone: user.phone, name: user.name, isVendor: user.is_vendor, isCustomer: user.is_customer } })
  })
}
