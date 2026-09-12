/**
 * Agentic Commerce — the AI that drives ALL booking/ordering scenarios.
 *
 * Unlike the previous version which handled a basic linear flow, this agent
 * handles EVERY real-world scenario:
 *
 *   ORDERING:
 *     "2 chicken biryani" → add to cart
 *     "remove the kebab" → remove from cart
 *     "is the biryani spicy?" → answer from catalog metadata
 *     "any veg options?" → filter + show
 *     "any deals today?" → show active offers
 *     "I have code SAVE20" → apply promo
 *     "same as last time" → reorder from history
 *     "order for 7pm" → scheduled order
 *     "make it 3 instead of 2" → update quantity
 *
 *   BOOKING:
 *     "book with Dr. Patel" → select resource
 *     "what times tomorrow?" → show slots
 *     "the 3pm one" → select slot
 *     "can I reschedule?" → show alternatives
 *
 *   CROSS-CUTTING:
 *     "how much total?" → show cart summary
 *     "start over" → reset
 *     "Telugu lo cheppandi" → switch language
 *     "how long will it take?" → answer contextually
 *     "what do you recommend?" → AI picks popular items
 *     "anything under ₹200?" → price-filtered browse
 *
 * The AI returns STRUCTURED ACTIONS. Code validates. Code executes.
 * The AI also decides WHICH UI COMPONENT to render — dynamically.
 */

import { z } from 'zod'
import { type LlmTask, untrusted } from '../contract'

// ─── Input ──────────────────────────────────────────────────────────────────

const OfferSchema = z.object({
  id: z.string(),
  title: z.string(),
  offerType: z.string(),
  discountValue: z.number().nullable(),
  discountType: z.string().nullable(),
  badgeText: z.string().nullable(),
  minOrderValue: z.number().nullable(),
  maxDiscount: z.number().nullable(),
  applicableItemIds: z.array(z.string()),
  promoCode: z.string().nullable(),
  imageUrl: z.string().nullable(),
})

const Input = z.object({
  text: z.string().min(1).max(2000),

  orgContext: z.object({
    orgId: z.string(),
    orgName: z.string(),
    orgType: z.string(),
    bookingTypes: z.array(z.string()),
  }).nullable(),

  sessionState: z.object({
    phase: z.string(),
    cart: z.array(z.object({
      itemId: z.string().nullable(),
      name: z.string(),
      quantity: z.number(),
      price: z.number(),
      imageUrl: z.string().nullable().optional(),
    })),
    selectedResource: z.object({
      id: z.string(),
      name: z.string(),
    }).nullable(),
    selectedSlot: z.object({
      id: z.string(),
      time: z.string(),
    }).nullable(),
    customerPhone: z.string().nullable(),
    customerName: z.string().nullable(),
    bookingType: z.string().nullable(),
    appliedOffer: z.object({
      id: z.string(),
      title: z.string(),
      discountAmount: z.number(),
    }).nullable().optional(),
    scheduledFor: z.string().nullable().optional(),
    language: z.string().optional(),
  }),

  catalog: z.array(z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    section: z.string(),
    isVeg: z.boolean().nullable(),
    isAvailable: z.boolean(),
    imageUrl: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })),

  resources: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    specialization: z.string().nullable(),
    price: z.number().nullable(),
    imageUrl: z.string().nullable().optional(),
  })),

  availableSlots: z.array(z.object({
    id: z.string(),
    time: z.string(),
    resourceName: z.string(),
  })),

  activeOffers: z.array(OfferSchema),

  /** Last 3 orders for "same as last time" */
  recentOrders: z.array(z.object({
    id: z.string(),
    items: z.array(z.object({
      name: z.string(),
      quantity: z.number(),
    })),
    total: z.number(),
    date: z.string(),
  })).optional(),
})

// ─── Output ─────────────────────────────────────────────────────────────────

const Output = z.object({
  reply: z.string().max(500),

  action: z.enum([
    // Cart management
    'add_to_cart',
    'remove_from_cart',
    'update_quantity',
    'clear_cart',
    'reorder',               // repeat a previous order

    // Resource/slot selection
    'select_resource',
    'select_slot',

    // Offers
    'apply_offer',           // apply a specific offer
    'apply_promo',           // apply a promo code
    'remove_offer',          // remove applied offer

    // Info collection
    'capture_phone',
    'capture_name',
    'capture_schedule',      // "order for 7pm"

    // Flow control
    'show_menu',             // display catalog
    'show_resources',        // display staff/resources
    'show_slots',            // display time slots
    'show_offers',           // display current deals
    'show_cart',             // display current cart
    'confirm_order',         // show final summary
    'place_order',           // commit the booking
    'cancel_flow',           // reset everything

    // Information
    'answer_question',       // answer about menu/hours/etc
    'recommend',             // AI picks items to suggest
    'filter_menu',           // show filtered view (veg, price range, etc)

    // Language
    'switch_language',       // respond in detected language

    'none',                  // no specific action — just answering/chatting
    'unknown',
  ]),

  action_data: z.object({
    // Cart items
    items: z.array(z.object({
      catalog_item_id: z.string().nullable(),
      name: z.string(),
      quantity: z.number().int().min(1).max(99),
      price: z.number(),
    })).optional(),

    // Resource/slot
    resource_id: z.string().nullable().optional(),
    resource_name: z.string().nullable().optional(),
    slot_id: z.string().nullable().optional(),
    slot_time: z.string().nullable().optional(),

    // Offer
    offer_id: z.string().nullable().optional(),
    promo_code: z.string().nullable().optional(),

    // Customer info
    phone: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    scheduled_for: z.string().nullable().optional(),

    // Filter/recommend
    filter: z.object({
      is_veg: z.boolean().optional(),
      max_price: z.number().optional(),
      section: z.string().optional(),
      search_term: z.string().optional(),
    }).optional(),

    // Reorder
    previous_order_id: z.string().nullable().optional(),

    // Language
    language: z.string().optional(),  // "en", "te", "hi"
  }).default({}),

  next_phase: z.string(),

  /** Which UI component to render — the AI decides dynamically */
  ui_component: z.object({
    type: z.enum([
      'none',                    // just text reply
      'catalog_grid',            // full menu with images + sections
      'catalog_filtered',        // filtered subset (veg only, under ₹200)
      'item_detail',             // single item with image + description
      'resource_list',           // doctors/stylists with photos
      'slot_picker',             // available time slots
      'cart_summary',            // current cart with item images
      'order_summary',           // final order for confirmation
      'offer_banner',            // show offer cards with images
      'offer_applied',           // confirmation that offer was applied
      'phone_input',             // capture phone
      'booking_confirmed',       // success screen
      'reorder_suggestion',      // show previous order to repeat
      'recommendations',         // AI-curated suggestions with images
      'schedule_picker',         // pick delivery/appointment time
    ]),
    /** Which items to highlight (by catalog_item_id) */
    highlight_ids: z.array(z.string()).optional(),
    /** Section to scroll to */
    focus_section: z.string().optional(),
  }).passthrough(),  // allow extra keys the AI may add (items, etc.)
})

// ─── Mapped domain type ─────────────────────────────────────────────────────

export interface AgenticAction {
  reply: string
  action: string
  actionData: {
    items?: Array<{
      catalogItemId: string | null
      name: string
      quantity: number
      price: number
    }>
    resourceId?: string | null
    resourceName?: string | null
    slotId?: string | null
    slotTime?: string | null
    offerId?: string | null
    promoCode?: string | null
    phone?: string | null
    name?: string | null
    scheduledFor?: string | null
    filter?: {
      isVeg?: boolean
      maxPrice?: number
      section?: string
      searchTerm?: string
    }
    previousOrderId?: string | null
    language?: string
  }
  nextPhase: string
  uiComponent: {
    type: string
    highlightIds?: string[]
    focusSection?: string
  }
}

// ─── The prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You are an agentic commerce assistant. You handle EVERY scenario a customer might encounter while ordering food, booking appointments, or requesting services. You make dynamic decisions about what to show and what to ask.

CRITICAL RULES:
1. ONLY reference items that exist in the catalog. NEVER invent items or prices.
2. Prices ALWAYS come from the catalog. Your price in action_data is verified by code.
3. Match items by name fuzzy match. "biryani" matches "Chicken Biryani", "Mutton Biryani".
4. For ambiguous items ("biryani" when multiple exist), show all matches and ask.
5. NEVER skip confirmation before placing an order.
6. Keep responses SHORT — 1-3 sentences max. This is mobile chat.
7. Respond in the customer's language. If they speak Telugu, respond in Telugu.

SCENARIO HANDLING:

Menu/Catalog Questions:
- "is X spicy?" → answer from catalog description/metadata
- "any veg options?" → filter_menu with is_veg=true, show catalog_filtered
- "what's under ₹200?" → filter_menu with max_price=200, show catalog_filtered
- "what do you recommend?" → recommend action, pick 3-5 popular/featured items
- "what's in the biryani?" → answer_question using item description
- "show starters" → filter_menu with section="Starters", show catalog_filtered

Offers/Deals:
- "any deals?" → show_offers, display offer_banner with images
- "any offers on biryani?" → show_offers, highlight applicable items
- "I have code SAVE20" → apply_promo with promo_code="SAVE20"
- When showing menu, ALWAYS mention active offers proactively: "🔥 Today's deal: 20% off biryanis!"

Cart Management:
- "add X" → add_to_cart (find in catalog by name)
- "remove X" → remove_from_cart (find in cart by name)
- "make it 3 instead" → update_quantity (infer which item from context)
- "that's too much" → show_cart so they can adjust
- "how much so far?" → show_cart
- "start over" / "clear everything" → clear_cart

Reorder:
- "same as last time" → reorder, use recentOrders[0], show reorder_suggestion
- "repeat my order from Tuesday" → find matching order by date

Scheduling:
- "order for 7pm" → capture_schedule, scheduled_for="19:00"
- "deliver tomorrow morning" → capture_schedule
- "book for Saturday 3pm" → select_slot if resource-based

Appointments:
- "book with Dr. Patel" → select_resource, show slot_picker
- "what times available?" → show_slots (for selected resource or all)
- "the 3pm one" → select_slot
- "actually, 4pm works better" → select_slot (change)

Checkout:
- "that's all" / "done" → if cart has items, move to details (ask phone)
- Phone numbers: extract from text ("my number is 98765..." → "9876543210")
- After phone: show confirm_order with order_summary
- "yes" / "confirm" → place_order
- "wait, add one more X" → add_to_cart, stay in building phase

Language:
- Detect language from input and respond in same language
- "Telugu lo cheppandi" → switch_language to Telugu, repeat last info
- Hindi, Telugu, English all supported

UI DECISIONS:
- Choose the MOST HELPFUL component. Don't show full menu when they asked about one item.
- Use item_detail for "tell me about X" — shows the item image + full description.
- Use recommendations for "what's good?" — curated picks with images.
- Use catalog_filtered for filter queries — only matching items.
- Use offer_banner when showing deals — includes offer images.
- Use highlight_ids to draw attention to specific items.
- Use focus_section to scroll to a section.

Return ONLY valid JSON.`

// ─── The task ───────────────────────────────────────────────────────────────

export const agenticCommerceTask: LlmTask<
  z.infer<typeof Input>,
  z.infer<typeof Output>,
  AgenticAction
> = {
  name: 'agentic_commerce',
  version: 2,
  input: Input,
  output: Output,

  prompt: (input) => [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: untrusted(JSON.stringify({
        message: input.text,
        org: input.orgContext,
        session: {
          phase: input.sessionState.phase,
          cart: input.sessionState.cart,
          resource: input.sessionState.selectedResource,
          slot: input.sessionState.selectedSlot,
          phone: input.sessionState.customerPhone,
          name: input.sessionState.customerName,
          bookingType: input.sessionState.bookingType,
          appliedOffer: input.sessionState.appliedOffer,
          scheduledFor: input.sessionState.scheduledFor,
          language: input.sessionState.language,
        },
        catalog: input.catalog.slice(0, 30),
        resources: input.resources.slice(0, 10),
        available_slots: input.availableSlots.slice(0, 20),
        offers: input.activeOffers.slice(0, 5),
        recent_orders: input.recentOrders?.slice(0, 3),
      })),
    },
  ],

  map: (d) => ({
    reply: d.reply,
    action: d.action,
    actionData: {
      items: d.action_data.items?.map(i => ({
        catalogItemId: i.catalog_item_id,
        name: i.name,
        quantity: i.quantity,
        price: i.price,
      })),
      resourceId: d.action_data.resource_id,
      resourceName: d.action_data.resource_name,
      slotId: d.action_data.slot_id,
      slotTime: d.action_data.slot_time,
      offerId: d.action_data.offer_id,
      promoCode: d.action_data.promo_code,
      phone: d.action_data.phone,
      name: d.action_data.name,
      scheduledFor: d.action_data.scheduled_for,
      filter: d.action_data.filter ? {
        isVeg: d.action_data.filter.is_veg,
        maxPrice: d.action_data.filter.max_price,
        section: d.action_data.filter.section,
        searchTerm: d.action_data.filter.search_term,
      } : undefined,
      previousOrderId: d.action_data.previous_order_id,
      language: d.action_data.language,
    },
    nextPhase: d.next_phase,
    uiComponent: {
      type: d.ui_component.type,
      highlightIds: d.ui_component.highlight_ids,
      focusSection: d.ui_component.focus_section,
    },
  }),

  temperature: 0.2,
  maxTokens: 1000,
  timeoutMs: 15_000,
  maxAttempts: 2,
}
