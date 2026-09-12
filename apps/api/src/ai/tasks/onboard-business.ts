/**
 * Auto-configure a business from a plain-text description.
 *
 * A restaurant owner types: "I run Bawarchi Biryani in Madhapur. We serve
 * Hyderabadi biryani, kebabs, and curries. Open 11am-11pm, closed Mondays.
 * 40 seats, avg meal ₹300."
 *
 * The AI returns a structured config that the onboarding service uses to
 * auto-create the entire org: catalog items, resources, slot templates,
 * booking types, branding, and widget copy.
 *
 * This follows the same contract pattern as every other AI task:
 *   - AI reads and structures. It does NOT create anything.
 *   - Code validates the output and writes to the database.
 *   - A malformed response is retried with the parse error fed back.
 */

import { z } from 'zod'
import { type LlmTask, untrusted } from '../contract'

const Input = z.object({
  description: z.string().min(10).max(5000),
  /** Optional hints from the signup form */
  city: z.string().max(100).optional(),
  phone: z.string().max(20).optional(),
})

/**
 * What the model returns. This is the "blueprint" for an entire business.
 */
const Output = z.object({
  // ─── Organization basics ──────────────────────────────────────────────
  display_name: z.string().min(1).max(120),
  org_type: z.enum([
    'restaurant', 'clinic', 'hospital', 'salon',
    'individual', 'studio', 'repair_service', 'rental_agency',
  ]),
  supported_booking_types: z.array(
    z.enum(['quote', 'appointment', 'hiring', 'order'])
  ).min(1),
  description_short: z.string().max(200),
  address: z.string().max(300).nullable(),
  area: z.string().max(100).nullable(),

  // ─── Catalog items ────────────────────────────────────────────────────
  catalog_items: z.array(z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(400).nullable(),
    section: z.string().max(80),
    price: z.number().min(0),
    is_veg: z.boolean().nullable(),
  })).default([]),

  // ─── Bookable resources (staff, tables, equipment) ────────────────────
  resources: z.array(z.object({
    name: z.string().min(1).max(120),
    resource_type: z.enum(['person', 'table', 'room', 'equipment', 'vehicle']),
    specialization: z.string().max(200).nullable(),
    price_per_slot: z.number().min(0).nullable(),
    duration_minutes: z.number().int().min(5).max(480).default(30),
  })).default([]),

  // ─── Operating hours ──────────────────────────────────────────────────
  operating_hours: z.array(z.object({
    day_of_week: z.number().int().min(0).max(6), // 0=Sun
    open_time: z.string(), // "09:00"
    close_time: z.string(), // "21:00"
    is_closed: z.boolean().default(false),
  })).default([]),

  // ─── Branding ─────────────────────────────────────────────────────────
  branding: z.object({
    primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
    tone: z.enum(['professional', 'casual', 'luxurious', 'friendly']).default('friendly'),
    tagline: z.string().max(100).nullable(),
  }).default({ primary_color: '#6366f1', tone: 'friendly', tagline: null }),

  // ─── Widget configuration ────────────────────────────────────────────
  widget: z.object({
    button_text: z.string().max(30).nullable(),
    welcome_message: z.string().max(200),
    theme: z.enum(['light', 'dark']).default('dark'),
  }).default({ welcome_message: 'Book with us!', button_text: null, theme: 'dark' as const }),

  // ─── Cancellation policy ─────────────────────────────────────────────
  cancellation_policy: z.enum([
    'flexible', 'moderate', 'strict', 'non_refundable',
  ]).default('flexible'),

  // ─── AI reasoning ─────────────────────────────────────────────────────
  reasoning: z.string().max(500),
})

// ─── The mapped domain type ─────────────────────────────────────────────────

export interface BusinessBlueprint {
  displayName: string
  orgType: string
  supportedBookingTypes: string[]
  descriptionShort: string
  address: string | null
  area: string | null
  catalogItems: Array<{
    name: string
    description: string | null
    section: string
    price: number
    isVeg: boolean | null
  }>
  resources: Array<{
    name: string
    resourceType: string
    specialization: string | null
    pricePerSlot: number | null
    durationMinutes: number
  }>
  operatingHours: Array<{
    dayOfWeek: number
    openTime: string
    closeTime: string
    isClosed: boolean
  }>
  branding: {
    primaryColor: string
    tone: string
    tagline: string | null
  }
  widget: {
    buttonText: string | null
    welcomeMessage: string
    theme: string
  }
  cancellationPolicy: string
  reasoning: string
}

// ─── The prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You are a business configuration AI. A business owner describes their business, and you generate a complete setup blueprint.

You must infer EVERYTHING the business needs from their description:
- What type of business it is
- What they sell or offer (catalog items with realistic prices)
- Who works there (resources/staff)
- When they're open (operating hours)
- What booking types they support
- What branding fits them
- A welcoming widget message

Rules:
1. Generate realistic catalog items with reasonable prices in INR (₹).
2. For restaurants: generate menu items grouped by section (Starters, Main Course, Desserts, Beverages).
3. For clinics/hospitals: generate services (Consultation, Tests, Procedures) and doctors as resources.
4. For salons: generate services (Haircut, Facial, etc.) and stylists as resources.
5. For repair services: generate service types and set booking_type to "quote".
6. Operating hours: default to 7 days, mark closed days. Use 24h format.
7. Primary color should match the business mood (medical=blue, food=orange/red, salon=pink/purple).
8. Widget welcome message should be warm and in a tone that matches the business.
9. If the description is in Telugu or Hindi, still return field values in English (for database), but the tagline and welcome_message can be bilingual.
10. Generate at least 5 catalog items and at least 1 resource.

Return ONLY valid JSON. No markdown. No explanation. Just the JSON object.`

// ─── The task contract ──────────────────────────────────────────────────────

export const onboardBusinessTask: LlmTask<
  z.infer<typeof Input>,
  z.infer<typeof Output>,
  BusinessBlueprint
> = {
  name: 'onboard_business',
  version: 1,
  input: Input,
  output: Output,

  prompt: ({ description, city, phone }) => [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: untrusted(
        `${description}${city ? `\nCity: ${city}` : ''}${phone ? `\nPhone: ${phone}` : ''}`
      ),
    },
  ],

  map: (d) => ({
    displayName: d.display_name,
    orgType: d.org_type,
    supportedBookingTypes: d.supported_booking_types,
    descriptionShort: d.description_short,
    address: d.address,
    area: d.area,
    catalogItems: d.catalog_items.map(i => ({
      name: i.name,
      description: i.description,
      section: i.section,
      price: i.price,
      isVeg: i.is_veg,
    })),
    resources: d.resources.map(r => ({
      name: r.name,
      resourceType: r.resource_type,
      specialization: r.specialization,
      pricePerSlot: r.price_per_slot,
      durationMinutes: r.duration_minutes,
    })),
    operatingHours: d.operating_hours.map(h => ({
      dayOfWeek: h.day_of_week,
      openTime: h.open_time,
      closeTime: h.close_time,
      isClosed: h.is_closed,
    })),
    branding: {
      primaryColor: d.branding.primary_color,
      tone: d.branding.tone,
      tagline: d.branding.tagline,
    },
    widget: {
      buttonText: d.widget.button_text,
      welcomeMessage: d.widget.welcome_message,
      theme: d.widget.theme,
    },
    cancellationPolicy: d.cancellation_policy,
    reasoning: d.reasoning,
  }),

  temperature: 0.3, // slightly creative for menu items and copy
  maxTokens: 3000,  // blueprints are large
  timeoutMs: 30_000, // 30s — this is a one-time setup, not latency-sensitive
  maxAttempts: 2,
}
