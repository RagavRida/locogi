import { createClient } from 'redis'
import { logger } from './logger'

export const redis = createClient({ url: process.env.REDIS_URL })

redis.on('error', (err) => logger.error({ err }, 'Redis error'))
redis.on('connect', () => logger.info('Redis connected'))

export async function connectRedis() {
  await redis.connect()
}

// Rate limiter — returns true if allowed, false if rate-limited
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<boolean> {
  try {
    const current = await redis.incr(key)
    if (current === 1) await redis.expire(key, windowSeconds)
    return current <= maxRequests
  } catch {
    // Redis down → fail open (allow through) + log
    logger.error('Redis rate limit check failed — failing open')
    return true
  }
}

// OTP storage
export async function storeOTP(phone: string, otp: string) {
  await redis.setEx(`otp:${phone}`, 300, otp) // 5 min TTL
}

export async function getOTP(phone: string): Promise<string | null> {
  return redis.get(`otp:${phone}`)
}

export async function deleteOTP(phone: string) {
  await redis.del(`otp:${phone}`)
}

// Generic cache helpers
export async function cacheGet(key: string): Promise<string | null> {
  try {
    return await redis.get(key)
  } catch {
    return null
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds = 300) {
  try {
    await redis.setEx(key, ttlSeconds, value)
  } catch {
    /* cache failures are non-fatal */
  }
}
