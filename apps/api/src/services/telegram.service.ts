/**
 * Telegram Bot Adapter
 *
 * Maps Locogi's UISchema components to Telegram-native messages
 * (inline keyboards, photos, formatted text).
 *
 * Architecture:
 *   Telegram webhook → this adapter → ChatOrchestratorService → AI
 *   AI response + UISchema → this adapter → Telegram Bot API
 */

import { Telegraf, Markup } from 'telegraf'
import type { UISchema } from '@locogi/types'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { ChatOrchestratorService } from './chat-orchestrator.service'

const orchestrator = new ChatOrchestratorService()

// ═════════════════════════════════════════════════════════════════════════════
// User mapping: Telegram chat ID ↔ Locogi user ID
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Find or create a Locogi user for a Telegram chat.
 * Uses phone if shared, otherwise creates a placeholder keyed by telegram ID.
 */
async function getOrCreateUser(
  telegramId: number,
  firstName?: string
): Promise<string> {
  // Check if we already mapped this telegram ID
  const existing = await query<{ user_id: string }>(
    `SELECT user_id FROM telegram_users WHERE telegram_id = $1`,
    [telegramId]
  ).catch(() => ({ rows: [] }))

  if (existing.rows[0]) return existing.rows[0].user_id

  // Create a new Locogi user
  const phone = `tg_${telegramId}` // placeholder until they share contact
  const result = await query<{ id: string }>(
    `INSERT INTO users (phone, name)
     VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [phone, firstName ?? 'Telegram User']
  )
  const userId = result.rows[0].id

  // Map telegram → locogi
  await query(
    `INSERT INTO telegram_users (telegram_id, user_id, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [telegramId, userId, firstName ?? '']
  ).catch(() => {}) // table might not exist yet, graceful

  return userId
}

/**
 * Update user's real phone when they share a contact.
 */
async function linkPhone(telegramId: number, phone: string): Promise<void> {
  const existing = await query<{ user_id: string }>(
    `SELECT user_id FROM telegram_users WHERE telegram_id = $1`,
    [telegramId]
  ).catch(() => ({ rows: [] }))

  if (existing.rows[0]) {
    await query(
      `UPDATE users SET phone = $1 WHERE id = $2`,
      [phone, existing.rows[0].user_id]
    )
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// UI → Telegram message mapping
// ═════════════════════════════════════════════════════════════════════════════

interface TelegramMessage {
  text: string
  keyboard?: any    // Telegraf inline keyboard markup
  photo?: string    // URL to send as photo
}

function formatPrice(price: number): string {
  return `₹${price.toLocaleString('en-IN')}`
}

/**
 * Convert a Locogi UISchema into a Telegram-friendly message.
 */
function mapUIToTelegram(
  message: string,
  ui?: UISchema
): TelegramMessage {
  if (!ui) return { text: message }

  const data = ui.data as Record<string, any>
  const uiType = ui.type as string  // Commerce types may not be in UISchema yet

  switch (uiType) {
    // ─── Menu / Catalog ────────────────────────────────────────────────
    case 'catalog_grid':
    case 'catalog_filtered': {
      const items = data.items ?? []
      if (items.length === 0) return { text: message }

      let text = `${message}\n\n`
      const buttons: { text: string; callback_data: string }[][] = []

      items.forEach((item: any, i: number) => {
        const vegIcon = item.isVeg ? '🟢' : item.isVeg === false ? '🔴' : ''
        text += `${i + 1}. ${vegIcon} *${item.name}*\n`
        if (item.description) text += `   _${item.description.slice(0, 60)}_\n`
        text += `   ${formatPrice(item.price)}\n\n`

        // 2 items per row
        const btn = { text: `${item.name} ${formatPrice(item.price)}`, callback_data: `add:${item.id}` }
        if (i % 2 === 0) buttons.push([btn])
        else buttons[buttons.length - 1].push(btn)
      })

      return {
        text,
        keyboard: Markup.inlineKeyboard(buttons),
      }
    }

    // ─── Single item detail ────────────────────────────────────────────
    case 'item_detail': {
      const item = data.item ?? data
      let text = `*${item.name ?? 'Item'}*\n\n`
      if (item.description) text += `${item.description}\n\n`
      if (item.price) text += `💰 ${formatPrice(item.price)}\n`

      return {
        text: `${message}\n\n${text}`,
        photo: item.imageUrl,
        keyboard: item.id
          ? Markup.inlineKeyboard([[
              { text: '➕ Add to Cart', callback_data: `add:${item.id}` },
              { text: '⬅️ Back', callback_data: 'back' },
            ]])
          : undefined,
      }
    }

    // ─── Cart ──────────────────────────────────────────────────────────
    case 'cart_summary': {
      const items = data.items ?? []
      let text = `🛒 *Your Cart*\n\n`
      let total = 0

      items.forEach((item: any, i: number) => {
        const lineTotal = item.price * (item.quantity ?? 1)
        total += lineTotal
        text += `${i + 1}. ${item.name} × ${item.quantity ?? 1} — ${formatPrice(lineTotal)}\n`
      })

      if (data.discount) {
        text += `\n🎁 Discount: -${formatPrice(data.discount)}\n`
        total -= data.discount
      }
      text += `\n*Total: ${formatPrice(total)}*`

      return {
        text: `${message}\n\n${text}`,
        keyboard: Markup.inlineKeyboard([
          [{ text: '✅ Checkout', callback_data: 'checkout' }, { text: '🗑 Clear Cart', callback_data: 'clear' }],
        ]),
      }
    }

    // ─── Order summary (pre-confirm) ───────────────────────────────────
    case 'order_summary': {
      const items = data.items ?? []
      let text = `📋 *Order Summary*\n\n`
      let total = 0

      items.forEach((item: any) => {
        const lineTotal = item.price * (item.quantity ?? 1)
        total += lineTotal
        text += `• ${item.name} × ${item.quantity ?? 1} — ${formatPrice(lineTotal)}\n`
      })

      if (data.discount) {
        text += `\n🎁 Discount: -${formatPrice(data.discount)}`
        total -= data.discount
      }
      text += `\n\n*Total: ${formatPrice(total)}*`

      if (data.scheduledFor) text += `\n📅 ${data.scheduledFor}`

      return {
        text: `${message}\n\n${text}`,
        keyboard: Markup.inlineKeyboard([
          [{ text: '✅ Confirm Order', callback_data: 'confirm' }],
          [{ text: '❌ Cancel', callback_data: 'cancel' }],
        ]),
      }
    }

    // ─── Booking confirmed ─────────────────────────────────────────────
    case 'booking_confirmed': {
      let text = `✅ *Booking Confirmed!*\n\n${message}`
      if (data.bookingId) text += `\n\nBooking ID: \`${data.bookingId}\``
      return { text }
    }

    // ─── Business listings (photographers, studios, etc.) ──────────────
    case 'vendor_list': {
      const items = data.items ?? data.orgs ?? []
      const buttons: { text: string; callback_data: string }[][] = []

      // Build rich listing for each business
      const listings = items.map((item: any, i: number) => {
        let listing = `━━━━━━━━━━━━━━━━\n`
        listing += `📸 *${item.name ?? item.displayName}*`
        if (item.rating) listing += `  ⭐ ${item.rating}`
        listing += '\n'

        if (item.area) listing += `📍 ${item.area}\n`

        if (item.description) {
          listing += `\n${item.description.slice(0, 150)}\n`
        }

        // Show top packages with prices
        if (item.topItems?.length > 0) {
          listing += `\n💼 *Popular Packages:*\n`
          item.topItems.forEach((pkg: any) => {
            listing += `  • ${pkg.name} — ${formatPrice(pkg.price)}\n`
          })
        }

        // Portfolio links (Exa-powered or website fallback)
        if (item.portfolio?.length > 0) {
          listing += `\n🖼 *Portfolio:*\n`
          item.portfolio.slice(0, 2).forEach((p: any) => {
            listing += `  • [${p.title?.slice(0, 40) || 'View Work'}](${p.url})\n`
          })
        } else if (item.website) {
          listing += `\n🖼 [View Portfolio](${item.website})\n`
        }

        // Reviews from Exa
        if (item.reviews?.length > 0) {
          const review = item.reviews[0]
          if (review.snippet) {
            listing += `\n💬 _"${review.snippet.slice(0, 80)}..."_\n`
          }
        }

        listing += '\n'

        // Buttons: Chat + Portfolio (if URL available)
        const row: { text: string; callback_data: string }[] = [
          {
            text: `💬 Chat with ${(item.name ?? item.displayName).split(' ')[0]}`,
            callback_data: `org:${item.id}`,
          },
          {
            text: `📋 View Packages`,
            callback_data: `org:${item.id}`,
          },
        ]
        buttons.push(row)

        return listing
      })

      const text = `${message}\n\n${listings.join('\n')}`
      return { text, keyboard: Markup.inlineKeyboard(buttons) }
    }

    // ─── Slot picker ───────────────────────────────────────────────────
    case 'slot_picker': {
      const slots = data.slots ?? []
      let text = `${message}\n\n📅 *Available Slots:*\n`
      const buttons: { text: string; callback_data: string }[][] = []

      slots.forEach((slot: any, i: number) => {
        const label = slot.label ?? slot.time ?? slot.date ?? `Slot ${i + 1}`
        text += `${i + 1}. ${label}\n`

        const btn = { text: label, callback_data: `slot:${slot.id ?? i}` }
        if (i % 3 === 0) buttons.push([btn])
        else buttons[buttons.length - 1]?.push(btn)
      })

      return { text, keyboard: buttons.length ? Markup.inlineKeyboard(buttons) : undefined }
    }

    // ─── Offer banner ──────────────────────────────────────────────────
    case 'offer_banner': {
      const offers = data.offers ?? (data.id ? [data] : [])
      let text = `🎁 *Special Offers*\n\n`

      offers.forEach((offer: any) => {
        text += `🔥 *${offer.title ?? offer.name}*\n`
        if (offer.description) text += `${offer.description}\n`
        if (offer.badge) text += `🏷 ${offer.badge}\n`
        text += '\n'
      })

      return {
        text: `${message}\n\n${text}`,
        photo: offers[0]?.imageUrl,
      }
    }

    // ─── Phone input request ───────────────────────────────────────────
    case 'phone_input': {
      return {
        text: `${message}\n\n📱 Please share your phone number:`,
        keyboard: Markup.keyboard([
          [Markup.button.contactRequest('📞 Share My Contact')],
        ]).oneTime().resize(),
      }
    }

    // ─── Default: just text ────────────────────────────────────────────
    default:
      return { text: message }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Bot setup
// ═════════════════════════════════════════════════════════════════════════════

let bot: Telegraf | null = null

export function getTelegramBot(): Telegraf | null {
  return bot
}

export async function startTelegramBot(): Promise<Telegraf | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    logger.info('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled')
    return null
  }

  bot = new Telegraf(token)

  // ─── Text messages ─────────────────────────────────────────────────
  bot.on('text', async (ctx) => {
    try {
      const userId = await getOrCreateUser(
        ctx.from.id,
        ctx.from.first_name
      )

      const result = await orchestrator.handle({
        userId,
        text: ctx.message.text,
      })

      if (!result) {
        await ctx.reply("I'm not sure what you need. Could you describe it differently?")
        return
      }

      const msg = mapUIToTelegram(result.message, result.ui)

      // Send photo if available
      if (msg.photo) {
        try {
          await ctx.replyWithPhoto(msg.photo, {
            caption: msg.text.slice(0, 1024), // Telegram caption limit
            parse_mode: 'Markdown',
            ...(msg.keyboard ? { reply_markup: msg.keyboard.reply_markup } : {}),
          })
          return
        } catch {
          // Photo failed — fall through to text
        }
      }

      // Send text with keyboard
      await ctx.reply(msg.text, {
        parse_mode: 'Markdown',
        ...(msg.keyboard ? { reply_markup: msg.keyboard.reply_markup } : {}),
      })

      // Persist the turn
      await persistTelegramTurn(userId, ctx.message.text, result.message, result.ui)
    } catch (err) {
      logger.error({ err, telegramId: ctx.from.id }, 'Telegram message handling failed')
      await ctx.reply('Sorry, something went wrong. Please try again.')
    }
  })

  // ─── Callback queries (inline keyboard button taps) ────────────────
  bot.on('callback_query', async (ctx) => {
    try {
      const data = (ctx.callbackQuery as any).data as string
      if (!data) return

      await ctx.answerCbQuery() // dismiss the loading spinner

      const userId = await getOrCreateUser(
        ctx.from.id,
        ctx.from.first_name
      )

      // Convert callback data to natural language for the orchestrator
      // Special case: org selection starts a commerce session
      let text: string
      let orgId: string | undefined

      if (data.startsWith('org:')) {
        orgId = data.split(':')[1]
        text = 'show me all packages'
      } else {
        text = callbackToText(data)
      }

      const result = await orchestrator.handle({
        userId,
        text,
        orgId,
      })

      if (!result) {
        await ctx.reply("I'm not sure what you need. Could you describe it differently?")
        return
      }

      const msg = mapUIToTelegram(result.message, result.ui)

      if (msg.photo) {
        try {
          await ctx.replyWithPhoto(msg.photo, {
            caption: msg.text.slice(0, 1024),
            parse_mode: 'Markdown',
            ...(msg.keyboard ? { reply_markup: msg.keyboard.reply_markup } : {}),
          })
          return
        } catch {
          // fall through
        }
      }

      await ctx.reply(msg.text, {
        parse_mode: 'Markdown',
        ...(msg.keyboard ? { reply_markup: msg.keyboard.reply_markup } : {}),
      })

      await persistTelegramTurn(userId, text, result.message, result.ui)
    } catch (err) {
      logger.error({ err }, 'Telegram callback handling failed')
      await ctx.reply('Sorry, something went wrong.')
    }
  })

  // ─── Contact shared (phone number) ─────────────────────────────────
  bot.on('contact', async (ctx) => {
    try {
      const phone = ctx.message.contact.phone_number
      const userId = await getOrCreateUser(ctx.from.id, ctx.from.first_name)

      // Link real phone
      await linkPhone(ctx.from.id, phone.startsWith('+') ? phone : `+${phone}`)

      // Tell the orchestrator the phone number
      const result = await orchestrator.handle({
        userId,
        text: phone,
      })

      if (result) {
        const msg = mapUIToTelegram(result.message, result.ui)
        await ctx.reply(msg.text, {
          parse_mode: 'Markdown',
          ...(msg.keyboard ? { reply_markup: msg.keyboard.reply_markup } : {}),
        })
      }
    } catch (err) {
      logger.error({ err }, 'Telegram contact handling failed')
      await ctx.reply('Got your number! Please try your request again.')
    }
  })

  // ─── /start command ────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const name = ctx.from.first_name ?? 'there'
    await getOrCreateUser(ctx.from.id, ctx.from.first_name)

    // Check for deep-link org parameter: /start org_<orgId>
    const startPayload = ctx.startPayload
    if (startPayload?.startsWith('org_')) {
      const orgId = startPayload.replace('org_', '')
      const result = await orchestrator.handle({
        userId: await getOrCreateUser(ctx.from.id, ctx.from.first_name),
        text: 'hi',
        orgId,
      })
      if (result) {
        const msg = mapUIToTelegram(result.message, result.ui)
        await ctx.reply(msg.text, {
          parse_mode: 'Markdown',
          ...(msg.keyboard ? { reply_markup: msg.keyboard.reply_markup } : {}),
        })
        return
      }
    }

    await ctx.reply(
      `Hey ${name}! 👋\n\n` +
      `I'm *Locogi* — your local commerce assistant.\n\n` +
      `📍 Share your location so I can find services near you:`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.keyboard([
          [Markup.button.locationRequest('📍 Share My Location')],
          ['Skip — I\'ll type my area'],
        ]).oneTime().resize().reply_markup,
      }
    )
  })

  // ─── Location shared ──────────────────────────────────────────────
  bot.on('location', async (ctx) => {
    try {
      const { latitude, longitude } = ctx.message.location
      const userId = await getOrCreateUser(ctx.from.id, ctx.from.first_name)

      // Store location in user record
      await query(
        `UPDATE users SET h3_index = $1 WHERE id = $2`,
        [`${latitude},${longitude}`, userId]
      ).catch(() => {})

      // Also store in Redis for quick lookup
      const { redis } = await import('../lib/redis')
      await redis.set(`tg_location:${ctx.from.id}`, JSON.stringify({
        lat: latitude,
        lng: longitude,
        updatedAt: new Date().toISOString(),
      }), { EX: 86400 * 30 }) // 30 days

      await ctx.reply(
        `📍 Got your location! Now I can find services near you.\n\n` +
        `Tell me what you need:\n` +
        `• "I need a photographer for my wedding"\n` +
        `• "Find a dentist near me"\n` +
        `• "Order biryani"\n` +
        `• "Book a plumber"\n\n` +
        `Just type naturally — I'll handle the rest! 🚀`,
        {
          parse_mode: 'Markdown',
          reply_markup: { remove_keyboard: true },
        }
      )
    } catch (err) {
      logger.error({ err }, 'Telegram location handling failed')
      await ctx.reply('Got your location! Now tell me what you need.')
    }
  })

  // ─── Launch ────────────────────────────────────────────────────────
  // In production: use webhook. In dev: use polling.
  if (process.env.NODE_ENV === 'production' && process.env.TELEGRAM_WEBHOOK_URL) {
    // Webhook is set up via the route — just launch the bot processing
    logger.info('Telegram bot started (webhook mode)')
  } else {
    // Polling mode for local development
    bot.launch({ dropPendingUpdates: true })
    logger.info('Telegram bot started (polling mode)')
  }

  return bot
}

export function stopTelegramBot(): void {
  try { bot?.stop('shutdown') } catch { /* already stopped */ }
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Convert inline keyboard callback data to natural language.
 * The AI processes text, so we translate button taps to text intents.
 */
function callbackToText(data: string): string {
  if (data.startsWith('add:'))    return `add item ${data.split(':')[1]} to cart`
  if (data.startsWith('select:')) return `select ${data.split(':')[1]}`
  if (data.startsWith('slot:'))   return `I want slot ${data.split(':')[1]}`
  if (data === 'checkout')        return "that's all, checkout"
  if (data === 'confirm')         return 'yes confirm'
  if (data === 'cancel')          return 'cancel'
  if (data === 'clear')           return 'clear cart'
  if (data === 'back')            return 'go back'
  return data // pass through unknown actions as-is
}

/**
 * Persist the turn in the messages table (same as chat.routes.ts).
 */
async function persistTelegramTurn(
  userId: string,
  userText: string,
  agentText: string,
  ui?: UISchema
): Promise<void> {
  try {
    await query(
      `INSERT INTO messages (request_id, sender_id, text, message_type)
       VALUES (NULL, $1, $2, 'text')`,
      [userId, userText]
    )
    await query(
      `INSERT INTO messages (request_id, sender_id, text, message_type, ui)
       VALUES (NULL, $1, $2, 'system', $3)`,
      [userId, agentText, ui ? JSON.stringify(ui) : null]
    )
  } catch (err) {
    logger.error({ err }, 'Could not persist Telegram chat turn')
  }
}
