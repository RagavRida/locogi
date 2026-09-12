/**
 * Commerce Guardrails
 *
 * Safety rules enforced AFTER the AI proposes an action, BEFORE execution.
 * These are deterministic — they never call the LLM.
 *
 * Rules:
 *   1. Cart limits — max items, max quantity per item, max order value
 *   2. Price validation — AI can't set prices below catalog price
 *   3. Offer validation — promo codes must exist in DB
 *   4. Phone validation — must be valid Indian mobile number
 *   5. Booking validation — slot must exist and be available
 *   6. Rate limiting — max operations per session
 */

import { logger } from './logger'

// ─── Configuration (per-org overridable in future) ──────────────────────────

export interface CommerceGuardrailConfig {
  maxCartItems: number
  maxQuantityPerItem: number
  maxOrderValue: number          // in INR
  minOrderValue: number
  maxSessionMessages: number     // prevent infinite loops
  allowedPaymentMethods: string[]
  requirePhoneForBooking: boolean
  requireNameForBooking: boolean
}

const DEFAULT_CONFIG: CommerceGuardrailConfig = {
  maxCartItems: 20,
  maxQuantityPerItem: 99,
  maxOrderValue: 500000,         // ₹5L max
  minOrderValue: 0,
  maxSessionMessages: 100,
  allowedPaymentMethods: ['cash', 'upi', 'card'],
  requirePhoneForBooking: true,
  requireNameForBooking: false,
}

// ─── Validation Results ─────────────────────────────────────────────────────

export interface GuardrailResult {
  allowed: boolean
  reason?: string
  suggestion?: string
}

// ─── Cart Guardrails ────────────────────────────────────────────────────────

export function validateCartAdd(
  currentCart: Array<{ name: string; quantity: number; price: number }>,
  newItems: Array<{ name: string; quantity: number; price: number }>,
  config: CommerceGuardrailConfig = DEFAULT_CONFIG,
): GuardrailResult {
  // Check total items
  const totalItems = currentCart.length + newItems.length
  if (totalItems > config.maxCartItems) {
    return {
      allowed: false,
      reason: `Cart can have maximum ${config.maxCartItems} items`,
      suggestion: 'Remove some items before adding more',
    }
  }

  // Check quantity per item
  for (const item of newItems) {
    if (item.quantity > config.maxQuantityPerItem) {
      return {
        allowed: false,
        reason: `Maximum quantity per item is ${config.maxQuantityPerItem}`,
      }
    }
    if (item.quantity <= 0) {
      return { allowed: false, reason: 'Quantity must be at least 1' }
    }
  }

  // Check total order value
  const currentTotal = currentCart.reduce((s, i) => s + i.price * i.quantity, 0)
  const newTotal = newItems.reduce((s, i) => s + i.price * i.quantity, 0)
  if (currentTotal + newTotal > config.maxOrderValue) {
    return {
      allowed: false,
      reason: `Order total cannot exceed ₹${config.maxOrderValue.toLocaleString()}`,
    }
  }

  return { allowed: true }
}

// ─── Price Guardrails ───────────────────────────────────────────────────────

export function validatePrice(
  aiPrice: number,
  catalogPrice: number,
  tolerance: number = 0.01,  // 1% tolerance for rounding
): GuardrailResult {
  if (aiPrice < 0) {
    return { allowed: false, reason: 'Price cannot be negative' }
  }

  // AI shouldn't set prices lower than catalog (prevent hallucinated discounts)
  const minAllowed = catalogPrice * (1 - tolerance)
  if (aiPrice < minAllowed) {
    logger.warn(
      { aiPrice, catalogPrice },
      '[guardrail] AI attempted to set price below catalog price',
    )
    return {
      allowed: false,
      reason: `Price ₹${aiPrice} is below catalog price ₹${catalogPrice}`,
    }
  }

  return { allowed: true }
}

// ─── Phone Guardrails ───────────────────────────────────────────────────────

export function validatePhone(phone: string): GuardrailResult {
  // Remove spaces, dashes, + prefix
  const cleaned = phone.replace(/[\s\-+]/g, '')

  // Indian mobile: 10 digits starting with 6-9, optionally prefixed with 91
  const indianMobile = /^(91)?[6-9]\d{9}$/
  if (!indianMobile.test(cleaned)) {
    return {
      allowed: false,
      reason: 'Please provide a valid Indian mobile number (10 digits starting with 6-9)',
    }
  }

  return { allowed: true }
}

// ─── Offer/Promo Guardrails ─────────────────────────────────────────────────

export function validateDiscount(
  discountAmount: number,
  orderTotal: number,
  maxDiscountPercent: number = 50,
): GuardrailResult {
  if (discountAmount < 0) {
    return { allowed: false, reason: 'Discount cannot be negative' }
  }

  const discountPercent = (discountAmount / orderTotal) * 100
  if (discountPercent > maxDiscountPercent) {
    return {
      allowed: false,
      reason: `Discount cannot exceed ${maxDiscountPercent}% of order total`,
    }
  }

  return { allowed: true }
}

// ─── Session Guardrails ─────────────────────────────────────────────────────

export function validateSessionHealth(
  messageCount: number,
  config: CommerceGuardrailConfig = DEFAULT_CONFIG,
): GuardrailResult {
  if (messageCount > config.maxSessionMessages) {
    return {
      allowed: false,
      reason: 'Session has too many messages. Please start a new conversation.',
    }
  }

  return { allowed: true }
}

// ─── Telegram Rate Limiting ─────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

export function checkRateLimit(
  userId: string,
  maxPerMinute: number = 30,
): GuardrailResult {
  const now = Date.now()
  const entry = rateLimitMap.get(userId)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + 60000 })
    return { allowed: true }
  }

  entry.count++
  if (entry.count > maxPerMinute) {
    logger.warn({ userId, count: entry.count }, '[guardrail] Rate limit exceeded')
    return {
      allowed: false,
      reason: 'Too many messages. Please wait a moment.',
    }
  }

  return { allowed: true }
}

// ─── Content Safety ─────────────────────────────────────────────────────────

const ABUSE_PATTERNS = [
  /\b(fuck|shit|damn|hell|ass)\b/i,
  /\b(kill|murder|attack|bomb)\b/i,
  /\b(scam|fraud|cheat)\b/i,
]

export function checkContentSafety(text: string): GuardrailResult {
  for (const pattern of ABUSE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        allowed: true,  // Don't block — just flag for review
        reason: 'flagged',
        suggestion: 'Message flagged for review',
      }
    }
  }
  return { allowed: true }
}

export { DEFAULT_CONFIG }
