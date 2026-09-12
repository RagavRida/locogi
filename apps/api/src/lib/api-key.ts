/**
 * API Key management for B2B platform integrations.
 *
 * Keys follow the pattern: lok_{env}_{32 random hex chars}
 *   - lok_live_a3f9bc12...  (production)
 *   - lok_test_7e2d1f08...  (sandbox)
 *
 * The raw key is shown ONCE at creation. We store only the SHA-256 hash.
 * On each request, the middleware hashes the incoming key and looks up the hash.
 */

import { randomBytes, createHash, createHmac } from 'crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { query } from './db'
import { logger } from './logger'

// ─── Key generation ─────────────────────────────────────────────────────────

export function generateApiKey(environment: 'live' | 'test' = 'live'): {
  rawKey: string
  keyHash: string
  keyPrefix: string
} {
  const random = randomBytes(32).toString('hex')
  const rawKey = `lok_${environment}_${random}`
  const keyHash = hashKey(rawKey)
  const keyPrefix = `lok_${environment}_${random.slice(0, 8)}`

  return { rawKey, keyHash, keyPrefix }
}

export function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

/**
 * Generate an HMAC-SHA256 signing secret for webhook verification.
 */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`
}

/**
 * Sign a webhook payload with HMAC-SHA256.
 * The business verifies this to prove the request came from Locogi.
 */
export function signWebhookPayload(
  payload: string,
  secret: string,
  timestamp: number
): string {
  const message = `${timestamp}.${payload}`
  return createHmac('sha256', secret).update(message).digest('hex')
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type ApiKeyScope =
  | 'bookings:read' | 'bookings:write'
  | 'catalog:read' | 'catalog:write'
  | 'resources:read'
  | 'availability:read'
  | 'webhooks:manage'

export interface OrgApiKeyContext {
  keyId: string
  organizationId: string
  environment: 'live' | 'test'
  scopes: ApiKeyScope[]
}

// Augment FastifyRequest
declare module 'fastify' {
  interface FastifyRequest {
    orgApiKey?: OrgApiKeyContext
  }
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Authenticate requests using an org API key.
 *
 * The key is passed in the `X-API-Key` header. We hash it and look up the
 * hash in org_api_keys.
 */
export async function requireOrgApiKey(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const rawKey = req.headers['x-api-key'] as string | undefined

  if (!rawKey || !rawKey.startsWith('lok_')) {
    return reply.code(401).send({
      message: 'Missing or invalid X-API-Key header. Keys start with lok_live_ or lok_test_.',
    })
  }

  const keyHash = hashKey(rawKey)

  const result = await query<{
    id: string
    organization_id: string
    environment: string
    scopes: string[]
    is_active: boolean
    expires_at: string | null
  }>(
    `SELECT id, organization_id, environment, scopes, is_active, expires_at
     FROM org_api_keys
     WHERE key_hash = $1`,
    [keyHash]
  )

  const key = result.rows[0]

  if (!key) {
    return reply.code(401).send({ message: 'Invalid API key' })
  }

  if (!key.is_active) {
    return reply.code(401).send({ message: 'API key has been revoked' })
  }

  if (key.expires_at && new Date(key.expires_at) < new Date()) {
    return reply.code(401).send({ message: 'API key has expired' })
  }

  // Update last_used_at (fire-and-forget, don't block the request)
  query(
    'UPDATE org_api_keys SET last_used_at = now() WHERE id = $1',
    [key.id]
  ).catch(() => {})

  req.orgApiKey = {
    keyId: key.id,
    organizationId: key.organization_id,
    environment: key.environment as 'live' | 'test',
    scopes: key.scopes as ApiKeyScope[],
  }
}

/**
 * Check if the API key has a required scope.
 */
export function requireScope(...requiredScopes: ApiKeyScope[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.orgApiKey) {
      return reply.code(401).send({ message: 'API key required' })
    }

    const missing = requiredScopes.filter(s => !req.orgApiKey!.scopes.includes(s))
    if (missing.length > 0) {
      return reply.code(403).send({
        message: `Insufficient permissions. Missing scopes: ${missing.join(', ')}`,
      })
    }
  }
}
