import jwt from 'jsonwebtoken'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { query } from './db'
import { redis } from './redis'
import { logger } from './logger'
import type { OrgRole } from './permissions'

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'dev_access_secret_change_me'
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'dev_refresh_secret_change_me'
const ACCESS_TTL = '15m'
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

export interface AuthUser {
  id: string
  phone: string
  isVendor: boolean
  isCustomer: boolean
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
  }
}

// ─── Token issuing ────────────────────────────────────────────────────────────
export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, ACCESS_SECRET, { expiresIn: ACCESS_TTL })
}

export async function signRefreshToken(userId: string): Promise<string> {
  const token = jwt.sign({ sub: userId, typ: 'refresh' }, REFRESH_SECRET, {
    expiresIn: REFRESH_TTL_SECONDS,
  })
  // Store in Redis so we can revoke on ban / logout / deletion
  await redis.setEx(`refresh:${userId}:${token.slice(-16)}`, REFRESH_TTL_SECONDS, '1')
  return token
}

export async function rotateRefreshToken(
  oldToken: string
): Promise<{ accessToken: string; refreshToken: string; userId: string } | null> {
  try {
    const decoded = jwt.verify(oldToken, REFRESH_SECRET) as { sub: string; typ: string }
    if (decoded.typ !== 'refresh') return null

    // Verify it wasn't revoked
    const exists = await redis.get(`refresh:${decoded.sub}:${oldToken.slice(-16)}`)
    if (!exists) return null

    // Revoke the old one
    await redis.del(`refresh:${decoded.sub}:${oldToken.slice(-16)}`)

    return {
      accessToken: signAccessToken(decoded.sub),
      refreshToken: await signRefreshToken(decoded.sub),
      userId: decoded.sub,
    }
  } catch {
    return null
  }
}

export async function revokeAllTokens(userId: string): Promise<void> {
  const keys = await redis.keys(`refresh:${userId}:*`)
  if (keys.length > 0) await redis.del(keys)
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return reply.code(401).send({ message: 'Missing authorization header' })
  }

  const token = header.slice(7)
  let userId: string

  try {
    const decoded = jwt.verify(token, ACCESS_SECRET) as { sub: string }
    userId = decoded.sub
  } catch {
    return reply.code(401).send({ message: 'Invalid or expired token' })
  }

  // CRITICAL: check ban status on EVERY request, not just at login
  const result = await query<{
    id: string
    phone: string
    is_vendor: boolean
    is_customer: boolean
    is_banned: boolean
  }>(
    'SELECT id, phone, is_vendor, is_customer, is_banned FROM users WHERE id = $1',
    [userId]
  )

  const user = result.rows[0]
  if (!user) return reply.code(401).send({ message: 'User not found' })

  if (user.is_banned) {
    logger.warn({ userId }, 'Banned user attempted access')
    return reply.code(403).send({
      message: 'Your account has been suspended. Contact support.',
    })
  }

  req.user = {
    id: user.id,
    phone: user.phone,
    isVendor: user.is_vendor,
    isCustomer: user.is_customer,
  }
}

// ─── Role-based middleware ────────────────────────────────────────────────────

/**
 * Require the user to be a member of the org with one of the specified roles.
 * Must be used AFTER requireAuth.
 *
 * Usage:
 *   app.post('/api/catalog', {
 *     preHandler: [requireAuth, requireRole(['owner', 'manager'])]
 *   }, handler)
 */
export function requireRole(allowedRoles: OrgRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.user?.id
    const orgId = (req.params as { orgId?: string })?.orgId
      ?? (req.body as { orgId?: string })?.orgId
      ?? req.headers['x-org-id'] as string

    if (!userId) return reply.code(401).send({ message: 'Not authenticated' })
    if (!orgId) return reply.code(400).send({ message: 'Organization ID required' })

    const { getOrgMember } = await import('./permissions')
    const member = await getOrgMember(userId, orgId)

    if (!member) {
      return reply.code(403).send({ message: 'You are not a member of this organization' })
    }

    if (!member.isActive) {
      return reply.code(403).send({ message: 'Your membership has been deactivated' })
    }

    if (!allowedRoles.includes(member.role)) {
      logger.warn({ userId, orgId, role: member.role, required: allowedRoles }, 'Role check failed')
      return reply.code(403).send({
        message: `This action requires one of: ${allowedRoles.join(', ')}. You are: ${member.role}`,
      })
    }

    // Attach member + permissions to request for downstream use
    const { buildPermissions } = await import('./permissions')
    ;(req as any).orgMember = member
    ;(req as any).permissions = buildPermissions(member)
  }
}

/**
 * Require org access with a specific permission check.
 * More granular than requireRole — checks individual permission flags.
 *
 * Usage:
 *   app.put('/api/catalog/:id', {
 *     preHandler: [requireAuth, requirePermission('editCatalog')]
 *   }, handler)
 */
export function requirePermission(permission: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.user?.id
    const orgId = (req.params as { orgId?: string })?.orgId
      ?? (req.body as { orgId?: string })?.orgId
      ?? req.headers['x-org-id'] as string

    if (!userId) return reply.code(401).send({ message: 'Not authenticated' })
    if (!orgId) return reply.code(400).send({ message: 'Organization ID required' })

    const { getPermissions, can } = await import('./permissions')
    const { permissions, member } = await getPermissions(userId, orgId)

    if (!member) {
      return reply.code(403).send({ message: 'You are not a member of this organization' })
    }

    if (!can(permissions, permission as any)) {
      logger.warn({ userId, orgId, permission }, 'Permission check failed')
      return reply.code(403).send({ message: `You don't have permission: ${permission}` })
    }

    ;(req as any).orgMember = member
    ;(req as any).permissions = permissions
  }
}
