import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

let remoteKeys: { issuer: string; resolve: JWTVerifyGetKey } | undefined

export function auth0Configuration() {
  const issuerBase = process.env.AUTH0_ISSUER_BASE_URL
  const audience = process.env.AUTH0_AUDIENCE
  const clientId = process.env.AUTH0_CLIENT_ID
  if (!issuerBase || !audience || !clientId || audience === clientId) return null
  try {
    const url = new URL(issuerBase)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return { issuer: `${url.origin}/`, audience, clientId }
  } catch { return null }
}

export async function verifyAuth0AccessToken(token: string, resolver?: JWTVerifyGetKey) {
  const config = auth0Configuration()
  if (!config) throw new Error('AUTH0_NOT_CONFIGURED')
  if (!resolver && remoteKeys?.issuer !== config.issuer) {
    remoteKeys = { issuer: config.issuer, resolve: createRemoteJWKSet(new URL('.well-known/jwks.json', config.issuer), { timeoutDuration: 5000, cacheMaxAge: 600000, cooldownDuration: 30000 }) }
  }
  const { payload } = await jwtVerify(token, resolver ?? remoteKeys!.resolve, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat'],
    clockTolerance: 5,
  })
  if (payload.azp !== config.clientId || typeof payload.sub !== 'string' || !/^[^\s]{1,255}$/.test(payload.sub)) throw new Error('INVALID_AUTH0_IDENTITY')
  return { issuer: config.issuer, subject: payload.sub }
}
