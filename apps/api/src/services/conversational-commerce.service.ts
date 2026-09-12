/**
 * Agentic Commerce Service — executes AI-driven actions for ordering & booking.
 *
 * The AI reads context (catalog, offers, session, resources) and returns
 * structured actions. This service VALIDATES and EXECUTES them.
 *
 * Safety contract:
 *   - AI decides WHAT the user means → structured action
 *   - Code decides IF it's valid → validates against DB
 *   - Code decides HOW to execute → atomic transactions
 *   - AI NEVER sets prices, creates items, or commits bookings
 */

import { query, withTransaction } from '../lib/db'
import { logger } from '../lib/logger'
import { runTask } from '../ai/contract'
import { agenticCommerceTask, type AgenticAction } from '../ai/tasks/conversational-commerce'
import { enqueueOutbox } from '../lib/outbox'
import type { UISchema } from '@locogi/types'
import { redis } from '../lib/redis'

// ─── Session State ──────────────────────────────────────────────────────────

export interface ChatSession {
  orgId: string
  phase: string
  cart: Array<{
    itemId: string | null
    name: string
    quantity: number
    price: number
    imageUrl?: string | null
  }>
  selectedResource: { id: string; name: string } | null
  selectedSlot: { id: string; time: string } | null
  customerPhone: string | null
  customerName: string | null
  bookingType: string | null
  appliedOffer: { id: string; title: string; discountAmount: number } | null
  scheduledFor: string | null
  language: string
  startedAt: string
}

const SESSION_TTL = 3600

function sessionKey(userId: string, orgId: string): string {
  return `chat_session:${userId}:${orgId}`
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CommerceReply {
  message: string
  ui?: UISchema
  session: ChatSession
}

// ─── Service ────────────────────────────────────────────────────────────────

export class ConversationalCommerceService {

  async handle(params: {
    userId: string
    orgId: string
    text: string
  }): Promise<CommerceReply> {
    const { userId, orgId, text } = params

    // ── 1. Load or create session ────────────────────────────────────────
    const session = await this.getOrCreateSession(userId, orgId)

    // ── 2. Load org (cached — changes rarely) ───────────────────────────
    const org = await this.getOrgCached(orgId)
    if (!org) {
      return {
        message: "Sorry, I can't find this business.",
        session,
      }
    }

    // ── 3. Load data in parallel ─────────────────────────────────────────
    //    Org + catalog are short-cached (60s) since they rarely change.
    //    Slots + offers checked fresh (they change by the minute).
    const [catalog, resources, slots, offers, recentOrders] = await Promise.all([
      this.getCatalogCached(orgId),
      this.getResourcesCached(orgId),
      this.getAvailableSlots(orgId),    // always fresh
      this.getActiveOffers(orgId),       // always fresh (time-dependent)
      session.phase === 'greeting'       // only load history on first message
        ? this.getRecentOrders(userId, orgId)
        : Promise.resolve([]),
    ])

    // ── 4. Ask AI ────────────────────────────────────────────────────────
    const aiResult = await runTask(agenticCommerceTask, {
      text,
      orgContext: {
        orgId: org.id,
        orgName: org.displayName,
        orgType: org.orgType,
        bookingTypes: org.bookingTypes,
      },
      sessionState: {
        phase: session.phase,
        cart: session.cart,
        selectedResource: session.selectedResource,
        selectedSlot: session.selectedSlot,
        customerPhone: session.customerPhone,
        customerName: session.customerName,
        bookingType: session.bookingType,
        appliedOffer: session.appliedOffer,
        scheduledFor: session.scheduledFor,
        language: session.language,
      },
      catalog,
      resources,
      availableSlots: slots,
      activeOffers: offers,
      recentOrders,
    })

    if (!aiResult.ok) {
      logger.error({ reason: aiResult.reason }, '[commerce] AI task failed')
      return {
        message: "Let me try again. What would you like?",
        session,
      }
    }

    const action = aiResult.data

    // ── 5. Validate and execute action ───────────────────────────────────
    const updated = await this.executeAction(userId, orgId, session, action, catalog, offers)

    // ── 6. Build dynamic UI ──────────────────────────────────────────────
    const ui = this.buildDynamicUI(action, updated, catalog, resources, slots, offers)

    return {
      message: action.reply,
      ui,
      session: updated,
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Action Execution — validates + applies each action type
  // ═══════════════════════════════════════════════════════════════════════════

  private async executeAction(
    userId: string,
    orgId: string,
    session: ChatSession,
    action: AgenticAction,
    catalog: any[],
    offers: any[],
  ): Promise<ChatSession> {
    const updated: ChatSession = { ...session, phase: action.nextPhase }

    // Language switch
    if (action.actionData.language) {
      updated.language = action.actionData.language
    }

    switch (action.action) {
      // ─── Cart Management ────────────────────────────────────────────
      case 'add_to_cart': {
        if (!action.actionData.items) break
        for (const item of action.actionData.items) {
          // Validate: item must exist in catalog
          const catalogItem = catalog.find(c =>
            c.id === item.catalogItemId ||
            c.name.toLowerCase().includes(item.name.toLowerCase())
          )
          if (!catalogItem || !catalogItem.isAvailable) continue

          // Price comes from DB, NOT from AI
          const existing = updated.cart.find(c => c.itemId === catalogItem.id)
          if (existing) {
            existing.quantity += item.quantity
          } else {
            updated.cart.push({
              itemId: catalogItem.id,
              name: catalogItem.name,
              quantity: item.quantity,
              price: catalogItem.price,  // DB price, not AI price
              imageUrl: catalogItem.imageUrl,
            })
          }
        }
        break
      }

      case 'remove_from_cart': {
        if (!action.actionData.items) break
        for (const item of action.actionData.items) {
          updated.cart = updated.cart.filter(c =>
            !c.name.toLowerCase().includes(item.name.toLowerCase()) &&
            c.itemId !== item.catalogItemId
          )
        }
        break
      }

      case 'update_quantity': {
        if (!action.actionData.items) break
        for (const item of action.actionData.items) {
          const cartItem = updated.cart.find(c =>
            c.itemId === item.catalogItemId ||
            c.name.toLowerCase().includes(item.name.toLowerCase())
          )
          if (cartItem) {
            cartItem.quantity = item.quantity
            if (cartItem.quantity <= 0) {
              updated.cart = updated.cart.filter(c => c !== cartItem)
            }
          }
        }
        break
      }

      case 'clear_cart': {
        updated.cart = []
        updated.appliedOffer = null
        break
      }

      case 'reorder': {
        // Reorder from previous order
        if (action.actionData.previousOrderId) {
          const prevOrder = await this.getPreviousOrder(action.actionData.previousOrderId)
          if (prevOrder) {
            updated.cart = prevOrder.items.map((item: { name: string; quantity: number }) => {
              const catalogItem = catalog.find(c =>
                c.name.toLowerCase().includes(item.name.toLowerCase())
              )
              return {
                itemId: catalogItem?.id ?? null,
                name: item.name,
                quantity: item.quantity,
                price: catalogItem?.price ?? 0, // DB price
                imageUrl: catalogItem?.imageUrl,
              }
            }).filter((i: { price: number }) => i.price > 0) // Only include items still in catalog
          }
        }
        break
      }

      // ─── Resource/Slot Selection ────────────────────────────────────
      case 'select_resource': {
        if (action.actionData.resourceId) {
          updated.selectedResource = {
            id: action.actionData.resourceId,
            name: action.actionData.resourceName ?? '',
          }
        }
        break
      }

      case 'select_slot': {
        if (action.actionData.slotId) {
          updated.selectedSlot = {
            id: action.actionData.slotId,
            time: action.actionData.slotTime ?? '',
          }
        }
        break
      }

      // ─── Offers ─────────────────────────────────────────────────────
      case 'apply_offer': {
        if (action.actionData.offerId) {
          const offer = offers.find(o => o.id === action.actionData.offerId)
          if (offer) {
            const discount = this.calculateDiscount(offer, updated.cart)
            if (discount > 0) {
              updated.appliedOffer = {
                id: offer.id,
                title: offer.title,
                discountAmount: discount,
              }
            }
          }
        }
        break
      }

      case 'apply_promo': {
        if (action.actionData.promoCode) {
          const offer = offers.find(o =>
            o.promoCode?.toLowerCase() === action.actionData.promoCode?.toLowerCase()
          )
          if (offer) {
            const discount = this.calculateDiscount(offer, updated.cart)
            if (discount > 0) {
              updated.appliedOffer = {
                id: offer.id,
                title: offer.title,
                discountAmount: discount,
              }
            }
          }
        }
        break
      }

      case 'remove_offer': {
        updated.appliedOffer = null
        break
      }

      // ─── Info Collection ────────────────────────────────────────────
      case 'capture_phone': {
        const phone = action.actionData.phone
        if (phone) {
          const cleaned = phone.replace(/\D/g, '')
          if (cleaned.length === 10) {
            updated.customerPhone = `+91${cleaned}`
          } else if (cleaned.length === 12 && cleaned.startsWith('91')) {
            updated.customerPhone = `+${cleaned}`
          }
        }
        break
      }

      case 'capture_name': {
        if (action.actionData.name) {
          updated.customerName = action.actionData.name
        }
        break
      }

      case 'capture_schedule': {
        if (action.actionData.scheduledFor) {
          updated.scheduledFor = action.actionData.scheduledFor
        }
        break
      }

      // ─── Flow Control ───────────────────────────────────────────────
      case 'place_order': {
        if (updated.customerPhone && updated.cart.length > 0) {
          try {
            await this.commitBooking(userId, orgId, updated)
            updated.phase = 'completed'
            await this.clearSession(userId, orgId)

            // Fire background jobs via Trigger.dev
            const { triggerOrderConfirmation, triggerVendorNotification } = await import('../lib/trigger')
            const cartItems = updated.cart.map(ci => ({
              name: ci.name, quantity: ci.quantity, price: ci.price,
            }))
            const total = cartItems.reduce((s, i) => s + i.price * i.quantity, 0)

            // Non-blocking — these run in the background
            triggerOrderConfirmation({
              orderId: `${orgId}-${Date.now()}`,
              orgName: updated.orgId ?? orgId,
              items: cartItems,
              total,
            }).catch(err => logger.warn({ err }, '[commerce] order confirmation job failed'))

            triggerVendorNotification({
              orgId,
              orderId: `${orgId}-${Date.now()}`,
              customerName: updated.customerName ?? 'Customer',
              items: cartItems,
              total,
            }).catch(err => logger.warn({ err }, '[commerce] vendor notification job failed'))

            return updated
          } catch (err) {
            logger.error({ err }, '[commerce] booking commit failed')
            updated.phase = 'confirming'
          }
        }
        break
      }

      case 'cancel_flow': {
        await this.clearSession(userId, orgId)
        return {
          ...session,
          phase: 'greeting',
          cart: [],
          selectedResource: null,
          selectedSlot: null,
          customerPhone: null,
          customerName: null,
          appliedOffer: null,
          scheduledFor: null,
          startedAt: new Date().toISOString(),
        } as ChatSession
      }

      // ─── Info / Browse actions — no session mutation needed ──────────
      case 'show_menu':
      case 'show_resources':
      case 'show_slots':
      case 'show_offers':
      case 'show_cart':
      case 'confirm_order':
      case 'answer_question':
      case 'recommend':
      case 'filter_menu':
      case 'switch_language':
      case 'none':
      case 'unknown':
        // These are display-only actions — UI builder handles them
        break
    }

    await this.saveSession(userId, updated)
    return updated
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Discount Calculation — code validates, AI only suggests
  // ═══════════════════════════════════════════════════════════════════════════

  private calculateDiscount(offer: any, cart: ChatSession['cart']): number {
    const subtotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0)

    // Check minimum order value
    if (offer.minOrderValue && subtotal < offer.minOrderValue) return 0

    let discount = 0

    switch (offer.offerType) {
      case 'percent_discount':
        discount = subtotal * (offer.discountValue / 100)
        if (offer.maxDiscount) discount = Math.min(discount, offer.maxDiscount)
        break

      case 'flat_discount':
        discount = offer.discountValue ?? 0
        break

      case 'bogo': {
        // Buy one get one — find cheapest applicable item
        const applicableItems = offer.applicableItemIds.length
          ? cart.filter(i => offer.applicableItemIds.includes(i.itemId))
          : cart
        if (applicableItems.length > 0) {
          const cheapest = Math.min(...applicableItems.map(i => i.price))
          discount = cheapest
        }
        break
      }

      case 'combo':
        // Combo price replaces individual prices
        if (offer.comboPrice) {
          const comboItems = cart.filter(i => offer.applicableItemIds.includes(i.itemId))
          const comboSubtotal = comboItems.reduce((s, i) => s + i.price * i.quantity, 0)
          discount = Math.max(0, comboSubtotal - offer.comboPrice)
        }
        break

      case 'happy_hour':
        discount = subtotal * (offer.discountValue / 100)
        if (offer.maxDiscount) discount = Math.min(discount, offer.maxDiscount)
        break
    }

    return Math.round(discount * 100) / 100
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Commit Booking — atomic transaction
  // ═══════════════════════════════════════════════════════════════════════════

  private async commitBooking(
    userId: string,
    orgId: string,
    session: ChatSession,
  ): Promise<string> {
    return withTransaction(async (client) => {
      const subtotal = session.cart.reduce((sum, i) => sum + i.price * i.quantity, 0)
      const discountTotal = session.appliedOffer?.discountAmount ?? 0
      const finalTotal = Math.max(0, subtotal - discountTotal)

      const result = await client.query(
        `INSERT INTO requests (
           user_id, status, vendor_match_method,
           extracted_description, category_tags,
           raw_text_payload, booking_type,
           vendor_org_id, subtotal, discount_total, final_total
         ) VALUES ($1, 'confirmed', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          userId,
          `chat_${orgId}_${Date.now()}`,
          session.bookingType === 'order'
            ? `Order: ${session.cart.map(i => `${i.name} x${i.quantity}`).join(', ')}`
            : `Appointment with ${session.selectedResource?.name ?? 'staff'}`,
          [session.bookingType ?? 'order'],
          JSON.stringify({
            source: 'chat',
            cart: session.cart,
            resource: session.selectedResource,
            slot: session.selectedSlot,
            customerPhone: session.customerPhone,
            customerName: session.customerName,
            scheduledFor: session.scheduledFor,
          }),
          session.bookingType ?? 'order',
          orgId,
          subtotal || null,
          discountTotal || null,
          finalTotal || null,
        ]
      )

      const requestId = result.rows[0].id

      // Book the slot if appointment
      if (session.selectedSlot) {
        await client.query(
          `UPDATE resource_slots
             SET capacity_booked = capacity_booked + 1
           WHERE id = $1 AND capacity_booked < capacity_total`,
          [session.selectedSlot.id]
        )
        await client.query(
          'UPDATE requests SET resource_slot_id = $1 WHERE id = $2',
          [session.selectedSlot.id, requestId]
        )
      }

      // Record applied offer
      if (session.appliedOffer) {
        await client.query(
          `INSERT INTO applied_offers (request_id, offer_id, discount_amount)
           VALUES ($1, $2, $3)`,
          [requestId, session.appliedOffer.id, session.appliedOffer.discountAmount]
        )
        // Increment usage
        await client.query(
          `UPDATE offers SET current_uses = current_uses + 1 WHERE id = $1`,
          [session.appliedOffer.id]
        )
      }

      // Fire outbox events
      await enqueueOutbox(
        'booking_created_platform',
        {
          requestId,
          organizationId: orgId,
          source: 'chat',
          bookingType: session.bookingType,
          subtotal,
          discountTotal,
          finalTotal,
          items: session.cart,
          offer: session.appliedOffer,
          scheduledFor: session.scheduledFor,
        },
        client,
      )

      logger.info({
        requestId, orgId,
        bookingType: session.bookingType,
        itemCount: session.cart.length,
        subtotal, discountTotal, finalTotal,
      }, '[commerce] booking committed via chat')

      return requestId
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dynamic UI Builder — AI decides component, code builds the data
  // ═══════════════════════════════════════════════════════════════════════════

  private buildDynamicUI(
    action: AgenticAction,
    session: ChatSession,
    catalog: any[],
    resources: any[],
    slots: any[],
    offers: any[],
  ): UISchema | undefined {
    const uiType = action.uiComponent.type
    const highlightIds = action.uiComponent.highlightIds ?? []
    const focusSection = action.uiComponent.focusSection

    switch (uiType) {
      case 'none':
        return undefined

      case 'catalog_grid': {
        const offerBadges = this.buildOfferBadgeMap(offers)
        return {
          type: 'vendor_list' as any,
          data: {
            items: catalog.filter(c => c.isAvailable).map(c => ({
              id: c.id,
              name: c.name,
              price: c.price,
              section: c.section,
              isVeg: c.isVeg,
              imageUrl: c.imageUrl,
              description: c.description,
              offerBadge: offerBadges.get(c.id) || null,
              highlighted: highlightIds.includes(c.id),
            })),
            offers: offers.filter(o => o.imageUrl).slice(0, 3).map(o => ({
              id: o.id, title: o.title, imageUrl: o.imageUrl,
              badgeText: o.badgeText, description: o.description,
            })),
            focusSection,
          },
        }
      }

      case 'catalog_filtered': {
        const filter = action.actionData.filter
        let filtered = catalog.filter(c => c.isAvailable)
        if (filter?.isVeg) filtered = filtered.filter(c => c.isVeg === true)
        if (filter?.maxPrice) filtered = filtered.filter(c => c.price <= filter.maxPrice!)
        if (filter?.section) filtered = filtered.filter(c =>
          c.section.toLowerCase().includes(filter.section!.toLowerCase())
        )
        if (filter?.searchTerm) filtered = filtered.filter(c =>
          c.name.toLowerCase().includes(filter.searchTerm!.toLowerCase()) ||
          (c.description ?? '').toLowerCase().includes(filter.searchTerm!.toLowerCase())
        )

        const offerBadges = this.buildOfferBadgeMap(offers)
        return {
          type: 'vendor_list' as any,
          data: {
            items: filtered.map(c => ({
              id: c.id, name: c.name, price: c.price,
              section: c.section, isVeg: c.isVeg,
              imageUrl: c.imageUrl, description: c.description,
              offerBadge: offerBadges.get(c.id) || null,
            })),
            filterApplied: filter,
          },
        }
      }

      case 'item_detail': {
        const itemId = highlightIds[0]
        const item = catalog.find(c => c.id === itemId)
        if (!item) return undefined
        return {
          type: 'confirmation' as any,
          data: {
            item: {
              id: item.id, name: item.name, price: item.price,
              section: item.section, isVeg: item.isVeg,
              imageUrl: item.imageUrl, description: item.description,
            },
          },
        }
      }

      case 'resource_list':
        return {
          type: 'vendor_list' as any,
          data: {
            resources: resources.map(r => ({
              id: r.id, name: r.name, type: r.type,
              specialization: r.specialization, price: r.price,
              imageUrl: r.imageUrl,
            })),
          },
        }

      case 'slot_picker':
        return {
          type: 'slot_picker',
          data: {
            slots: slots.map(s => ({
              id: s.id, time: s.time, resourceName: s.resourceName,
            })),
            resourceId: session.selectedResource?.id,
          },
        }

      case 'cart_summary':
      case 'order_summary': {
        const subtotal = session.cart.reduce((s, i) => s + i.price * i.quantity, 0)
        const discount = session.appliedOffer?.discountAmount ?? 0
        return {
          type: 'confirmation' as any,
          data: {
            items: session.cart.map(i => ({
              ...i,
              total: i.price * i.quantity,
            })),
            subtotal,
            discount,
            discountLabel: session.appliedOffer?.title,
            total: Math.max(0, subtotal - discount),
            resource: session.selectedResource,
            slot: session.selectedSlot,
            scheduledFor: session.scheduledFor,
            isConfirmation: uiType === 'order_summary',
          },
        }
      }

      case 'offer_banner':
        return {
          type: 'vendor_list' as any,
          data: {
            offers: offers.map(o => ({
              id: o.id, title: o.title, description: o.description,
              imageUrl: o.imageUrl, badgeText: o.badgeText,
              offerType: o.offerType,
              discountValue: o.discountValue, discountType: o.discountType,
              minOrderValue: o.minOrderValue,
            })),
          },
        }

      case 'offer_applied':
        return {
          type: 'confirmation' as any,
          data: {
            offer: session.appliedOffer,
            cart: session.cart,
            subtotal: session.cart.reduce((s, i) => s + i.price * i.quantity, 0),
            discount: session.appliedOffer?.discountAmount ?? 0,
            total: Math.max(0,
              session.cart.reduce((s, i) => s + i.price * i.quantity, 0) -
              (session.appliedOffer?.discountAmount ?? 0)
            ),
          },
        }

      case 'phone_input':
        return {
          type: 'confirmation' as any,
          data: { awaitingPhone: true },
        }

      case 'booking_confirmed':
        return {
          type: 'confirmation' as any,
          data: {
            confirmed: true,
            bookingType: session.bookingType,
            total: Math.max(0,
              session.cart.reduce((s, i) => s + i.price * i.quantity, 0) -
              (session.appliedOffer?.discountAmount ?? 0)
            ),
          },
        }

      case 'reorder_suggestion':
        return {
          type: 'confirmation' as any,
          data: {
            previousOrder: true,
            items: session.cart.map(i => ({
              name: i.name, quantity: i.quantity, price: i.price, imageUrl: i.imageUrl,
            })),
            total: session.cart.reduce((s, i) => s + i.price * i.quantity, 0),
          },
        }

      case 'recommendations': {
        const recommended = highlightIds.length
          ? catalog.filter(c => highlightIds.includes(c.id))
          : catalog.filter(c => c.isAvailable).slice(0, 5)
        return {
          type: 'vendor_list' as any,
          data: {
            items: recommended.map(c => ({
              id: c.id, name: c.name, price: c.price,
              imageUrl: c.imageUrl, description: c.description,
              section: c.section, isVeg: c.isVeg,
            })),
            isRecommendation: true,
          },
        }
      }

      case 'schedule_picker':
        return {
          type: 'slot_picker',
          data: {
            slots: slots.map(s => ({
              id: s.id, time: s.time, resourceName: s.resourceName,
            })),
            isScheduling: true,
          },
        }

      default:
        return undefined
    }
  }

  private buildOfferBadgeMap(offers: any[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const offer of offers) {
      if (offer.applicableItemIds?.length) {
        for (const itemId of offer.applicableItemIds) {
          map.set(itemId, offer.badgeText || offer.title)
        }
      }
    }
    return map
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Session Management — Redis-backed
  // ═══════════════════════════════════════════════════════════════════════════

  private async getOrCreateSession(userId: string, orgId: string): Promise<ChatSession> {
    const key = sessionKey(userId, orgId)
    const raw = await redis.get(key)

    if (raw) {
      const parsed = JSON.parse(raw) as ChatSession
      // Migrate old sessions missing new fields
      if (!('appliedOffer' in parsed)) (parsed as any).appliedOffer = null
      if (!('scheduledFor' in parsed)) (parsed as any).scheduledFor = null
      if (!('language' in parsed)) (parsed as any).language = 'en'
      return parsed
    }

    const session: ChatSession = {
      orgId,
      phase: 'greeting',
      cart: [],
      selectedResource: null,
      selectedSlot: null,
      customerPhone: null,
      customerName: null,
      bookingType: null,
      appliedOffer: null,
      scheduledFor: null,
      language: 'en',
      startedAt: new Date().toISOString(),
    }

    await redis.set(key, JSON.stringify(session), { EX: SESSION_TTL })
    return session
  }

  private async saveSession(userId: string, session: ChatSession): Promise<void> {
    await redis.set(sessionKey(userId, session.orgId), JSON.stringify(session), { EX: SESSION_TTL })
  }

  private async clearSession(userId: string, orgId: string): Promise<void> {
    await redis.del(sessionKey(userId, orgId))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Data Loaders — with in-memory TTL cache for stable data
  // ═══════════════════════════════════════════════════════════════════════════

  // Simple TTL cache: { data, expiresAt }
  private static cache = new Map<string, { data: any; expiresAt: number }>()
  private static CACHE_TTL = 60_000 // 60 seconds

  private cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const entry = ConversationalCommerceService.cache.get(key)
    if (entry && entry.expiresAt > Date.now()) return Promise.resolve(entry.data as T)

    return loader().then(data => {
      ConversationalCommerceService.cache.set(key, {
        data,
        expiresAt: Date.now() + ConversationalCommerceService.CACHE_TTL,
      })
      // Keep cache bounded (max 200 entries)
      if (ConversationalCommerceService.cache.size > 200) {
        const oldest = ConversationalCommerceService.cache.keys().next().value
        if (oldest) ConversationalCommerceService.cache.delete(oldest)
      }
      return data
    })
  }

  private getOrgCached(orgId: string) {
    return this.cached(`org:${orgId}`, () => this.getOrg(orgId))
  }

  private getCatalogCached(orgId: string) {
    return this.cached(`catalog:${orgId}`, () => this.getCatalog(orgId))
  }

  private getResourcesCached(orgId: string) {
    return this.cached(`resources:${orgId}`, () => this.getResources(orgId))
  }

  private async getOrg(orgId: string) {
    const result = await query<{
      id: string; display_name: string;
      org_type: string; supported_booking_types: string[]
    }>(
      'SELECT id, display_name, org_type, supported_booking_types FROM organizations WHERE id = $1',
      [orgId]
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      id: row.id,
      displayName: row.display_name,
      orgType: row.org_type,
      bookingTypes: row.supported_booking_types ?? ['order'],
    }
  }

  private async getCatalog(orgId: string) {
    const result = await query<{
      id: string; name: string; price: number;
      section: string; is_veg: boolean | null; is_available: boolean;
      image_url: string | null; description: string | null
    }>(
      `SELECT id, name, price, section, is_veg, is_available,
              image_url, description
       FROM catalog_items WHERE organization_id = $1
       ORDER BY display_order`,
      [orgId]
    )
    return result.rows.map(r => ({
      id: r.id,
      name: r.name,
      price: Number(r.price),
      section: r.section ?? '',
      isVeg: r.is_veg,
      isAvailable: r.is_available,
      imageUrl: r.image_url,
      description: r.description,
    }))
  }

  private async getResources(orgId: string) {
    const result = await query<{
      id: string; name: string; resource_type: string;
      specialization: string | null; base_price: number | null;
      image_url: string | null
    }>(
      `SELECT id, name, resource_type, specialization, base_price, image_url
       FROM bookable_resources WHERE organization_id = $1 AND is_active = true`,
      [orgId]
    )
    return result.rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.resource_type,
      specialization: r.specialization,
      price: r.base_price ? Number(r.base_price) : null,
      imageUrl: r.image_url,
    }))
  }

  private async getAvailableSlots(orgId: string) {
    const result = await query<{
      id: string; slot_time: string; resource_name: string
    }>(
      `SELECT rs.id, rs.slot_time, br.name AS resource_name
       FROM resource_slots rs
       JOIN bookable_resources br ON br.id = rs.resource_id
       WHERE br.organization_id = $1
         AND rs.is_cancelled = false
         AND rs.capacity_booked < rs.capacity_total
         AND rs.slot_time > now()
       ORDER BY rs.slot_time
       LIMIT 30`,
      [orgId]
    )
    return result.rows.map(r => ({
      id: r.id,
      time: r.slot_time,
      resourceName: r.resource_name,
    }))
  }

  private async getActiveOffers(orgId: string) {
    const result = await query<{
      id: string; offer_type: string; title: string;
      description: string | null; image_url: string | null;
      badge_text: string | null; discount_value: number | null;
      discount_type: string | null; min_order_value: number | null;
      max_discount: number | null; applicable_item_ids: string[];
      combo_price: number | null; promo_code: string | null;
      current_uses: number; max_uses: number | null
    }>(
      `SELECT id, offer_type, title, description, image_url, badge_text,
              discount_value, discount_type, min_order_value, max_discount,
              applicable_item_ids, combo_price, promo_code,
              current_uses, max_uses
       FROM offers
       WHERE organization_id = $1
         AND is_active = true
         AND (end_date IS NULL OR end_date >= CURRENT_DATE)
         AND start_date <= CURRENT_DATE
         AND (max_uses IS NULL OR current_uses < max_uses)
         AND EXTRACT(DOW FROM now())::int = ANY(active_days)
         AND (start_time IS NULL OR now()::time >= start_time)
         AND (end_time IS NULL OR now()::time <= end_time)
       ORDER BY is_featured DESC, discount_value DESC NULLS LAST`,
      [orgId]
    )
    return result.rows.map(r => ({
      id: r.id,
      offerType: r.offer_type,
      title: r.title,
      description: r.description,
      imageUrl: r.image_url,
      badgeText: r.badge_text,
      discountValue: r.discount_value ? Number(r.discount_value) : null,
      discountType: r.discount_type,
      minOrderValue: r.min_order_value ? Number(r.min_order_value) : null,
      maxDiscount: r.max_discount ? Number(r.max_discount) : null,
      applicableItemIds: r.applicable_item_ids ?? [],
      comboPrice: r.combo_price ? Number(r.combo_price) : null,
      promoCode: r.promo_code,
      usesRemaining: r.max_uses ? r.max_uses - r.current_uses : null,
    }))
  }

  private async getRecentOrders(userId: string, orgId: string) {
    try {
      const result = await query<{
        id: string; raw_text_payload: string; final_total: number; created_at: string
      }>(
        `SELECT id, raw_text_payload, final_total, created_at
         FROM requests
         WHERE user_id = $1 AND vendor_org_id = $2
           AND status IN ('completed', 'confirmed')
         ORDER BY created_at DESC
         LIMIT 3`,
        [userId, orgId]
      )
      return result.rows.map(r => {
        const payload = JSON.parse(r.raw_text_payload || '{}')
        return {
          id: r.id,
          items: (payload.cart ?? []).map((i: any) => ({
            name: i.name ?? '', quantity: i.quantity ?? 1,
          })),
          total: Number(r.final_total ?? 0),
          date: r.created_at,
        }
      })
    } catch {
      return []
    }
  }

  private async getPreviousOrder(orderId: string) {
    try {
      const result = await query<{
        raw_text_payload: string
      }>(
        `SELECT raw_text_payload FROM requests WHERE id = $1`,
        [orderId]
      )
      if (result.rows.length === 0) return null
      const payload = JSON.parse(result.rows[0].raw_text_payload || '{}')
      return {
        items: (payload.cart ?? []).map((i: any) => ({
          name: i.name ?? '', quantity: i.quantity ?? 1,
        })),
      }
    } catch {
      return null
    }
  }
}
