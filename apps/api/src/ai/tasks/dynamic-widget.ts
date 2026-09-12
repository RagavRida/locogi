/**
 * Generate dynamic widget content based on org context.
 *
 * Instead of hardcoded flows, the AI generates:
 *   - Personalized welcome messages
 *   - Smart follow-up questions based on what the business offers
 *   - Dynamic field labels in the customer's language
 *   - Intelligent item recommendations
 *
 * The AI configures WHAT to show. The widget code renders HOW to show it.
 */

import { z } from 'zod'
import { type LlmTask, untrusted } from '../contract'

const Input = z.object({
  orgName: z.string(),
  orgType: z.string(),
  bookingTypes: z.array(z.string()),
  catalogSections: z.array(z.string()),
  resourceCount: z.number(),
  customerLanguage: z.string(),
  timeOfDay: z.enum(['morning', 'afternoon', 'evening', 'night']),
})

const Output = z.object({
  greeting: z.string().max(120),
  menu_items: z.array(z.object({
    icon: z.string().max(4),
    title: z.string().max(40),
    subtitle: z.string().max(60),
    action: z.string(),
  })),
  smart_suggestions: z.array(z.string().max(60)).max(3),
  checkout_cta: z.string().max(30),
  success_title: z.string().max(40),
  success_message: z.string().max(120),
})

export interface DynamicWidgetConfig {
  greeting: string
  menuItems: Array<{
    icon: string
    title: string
    subtitle: string
    action: string
  }>
  smartSuggestions: string[]
  checkoutCta: string
  successTitle: string
  successMessage: string
}

const SYSTEM = `You generate personalized UI copy for a booking widget.

Given a business's details and the time of day, create warm, contextual text.

Rules:
- Greeting should reference time of day ("Good evening!" / "Namaskaram!")
- For restaurants at dinner time, suggest popular items
- For clinics, be professional and reassuring
- For salons, be upbeat and inviting
- smart_suggestions should be common orders/bookings that save the customer time
- Keep everything concise — this is mobile UI
- If customerLanguage is "te", write in Telugu. If "hi", Hindi. If "en", English.
- checkout_cta should be an action verb ("Place Order", "Book Now", "Get Quote")

Return ONLY valid JSON.`

export const dynamicWidgetTask: LlmTask<
  z.infer<typeof Input>,
  z.infer<typeof Output>,
  DynamicWidgetConfig
> = {
  name: 'dynamic_widget',
  version: 1,
  input: Input,
  output: Output,

  prompt: (input) => [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: untrusted(JSON.stringify(input)),
    },
  ],

  map: (d) => ({
    greeting: d.greeting,
    menuItems: d.menu_items.map(m => ({
      icon: m.icon,
      title: m.title,
      subtitle: m.subtitle,
      action: m.action,
    })),
    smartSuggestions: d.smart_suggestions,
    checkoutCta: d.checkout_cta,
    successTitle: d.success_title,
    successMessage: d.success_message,
  }),

  temperature: 0.5,
  maxTokens: 600,
  timeoutMs: 10_000,
  maxAttempts: 1,
}
