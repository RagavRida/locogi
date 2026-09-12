/**
 * AI-Powered Business Onboarding Service
 *
 * Takes a plain-text business description and auto-creates EVERYTHING:
 *   1. Organization
 *   2. Catalog items (menu/services)
 *   3. Bookable resources (staff/tables/rooms)
 *   4. Slot templates (operating hours → actual bookable slots)
 *   5. Branding + widget config
 *   6. First API key
 *
 * The AI reads and structures. This service writes to the database.
 * If anything fails, the transaction rolls back — no half-configured orgs.
 *
 * Usage:
 *   POST /platform/onboard
 *   { "description": "I run a dental clinic in Madhapur..." }
 *   → Returns the complete org with catalog, resources, API key, and widget code
 */

import { withTransaction } from '../lib/db'
import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { runTask } from '../ai/contract'
import { onboardBusinessTask, type BusinessBlueprint } from '../ai/tasks/onboard-business'
import { generateApiKey, generateSigningSecret } from '../lib/api-key'

export interface OnboardingResult {
  organizationId: string
  blueprint: BusinessBlueprint
  apiKey: string  // shown once
  widgetCode: string
  catalogItemCount: number
  resourceCount: number
  slotCount: number
}

export class AiOnboardingService {

  async onboard(params: {
    userId: string
    description: string
    city?: string
    phone?: string
  }): Promise<OnboardingResult> {

    // ─── Step 1: AI generates the blueprint ─────────────────────────────
    logger.info({ userId: params.userId }, '[onboard] generating blueprint via AI')

    const result = await runTask(onboardBusinessTask, {
      description: params.description,
      city: params.city,
      phone: params.phone,
    })

    if (!result.ok) {
      logger.error({ reason: result.reason }, '[onboard] AI task failed')
      throw new Error(`AI onboarding failed: ${result.reason}`)
    }

    const blueprint = result.data

    logger.info(
      {
        orgType: blueprint.orgType,
        catalogItems: blueprint.catalogItems.length,
        resources: blueprint.resources.length,
        bookingTypes: blueprint.supportedBookingTypes,
      },
      '[onboard] blueprint generated'
    )

    // ─── Step 2: Create everything in a single transaction ──────────────
    return withTransaction(async (client) => {

      // 2a. Create the organization
      const orgResult = await client.query<{ id: string }>(
        `INSERT INTO organizations
           (owner_user_id, display_name, org_type, description, address, area,
            supported_booking_types, branding, cancellation_policy,
            verification_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'verified')
         RETURNING id`,
        [
          params.userId,
          blueprint.displayName,
          blueprint.orgType,
          blueprint.descriptionShort,
          blueprint.address,
          blueprint.area,
          blueprint.supportedBookingTypes,
          JSON.stringify(blueprint.branding),
          blueprint.cancellationPolicy,
        ]
      )

      const orgId = orgResult.rows[0].id

      // 2b. Add the owner as a member
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role, is_active)
         VALUES ($1, $2, 'owner', true)`,
        [orgId, params.userId]
      )

      // 2c. Create catalog items
      let catalogCount = 0
      for (const item of blueprint.catalogItems) {
        await client.query(
          `INSERT INTO catalog_items
             (organization_id, name, description, base_price, section,
              is_available, is_veg, sort_order)
           VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
          [orgId, item.name, item.description, item.price, item.section,
           item.isVeg, catalogCount]
        )
        catalogCount++
      }

      // 2d. Create bookable resources
      let resourceCount = 0
      for (const resource of blueprint.resources) {
        await client.query(
          `INSERT INTO bookable_resources
             (organization_id, name, resource_type, specialization,
              price_per_slot, consultation_duration_minutes, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, true)`,
          [orgId, resource.name, resource.resourceType, resource.specialization,
           resource.pricePerSlot, resource.durationMinutes]
        )
        resourceCount++
      }

      // 2e. Generate slots from operating hours
      //     Creates 7 days of slots starting from tomorrow
      let slotCount = 0
      const resources = await client.query<{ id: string; consultation_duration_minutes: number }>(
        'SELECT id, consultation_duration_minutes FROM bookable_resources WHERE organization_id = $1',
        [orgId]
      )

      for (const resource of resources.rows) {
        for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
          const date = new Date()
          date.setDate(date.getDate() + dayOffset)
          const dayOfWeek = date.getDay()

          // Find operating hours for this day
          const hours = blueprint.operatingHours.find(h => h.dayOfWeek === dayOfWeek)
          if (!hours || hours.isClosed) continue

          // Generate slots
          const [openH, openM] = hours.openTime.split(':').map(Number)
          const [closeH, closeM] = hours.closeTime.split(':').map(Number)
          const openMinutes = openH * 60 + openM
          const closeMinutes = closeH * 60 + closeM
          const slotDuration = resource.consultation_duration_minutes || 30

          for (let mins = openMinutes; mins + slotDuration <= closeMinutes; mins += slotDuration) {
            const slotDate = new Date(date)
            slotDate.setHours(Math.floor(mins / 60), mins % 60, 0, 0)

            await client.query(
              `INSERT INTO resource_slots
                 (resource_id, slot_time, duration_minutes, capacity_total, capacity_booked, is_cancelled)
               VALUES ($1, $2, $3, 1, 0, false)`,
              [resource.id, slotDate.toISOString(), slotDuration]
            )
            slotCount++
          }
        }
      }

      // 2f. Generate API key
      const { rawKey, keyHash, keyPrefix } = generateApiKey('live')
      await client.query(
        `INSERT INTO org_api_keys
           (organization_id, key_hash, key_prefix, environment, label, created_by)
         VALUES ($1, $2, $3, 'live', 'Auto-generated', $4)`,
        [orgId, keyHash, keyPrefix, params.userId]
      )

      // 2g. Build widget embed code
      const widgetCode = `<script
  src="https://widget.locogi.com/v1.js"
  data-org-id="${orgId}"
  data-api-url="https://api.locogi.com"
  data-theme="${blueprint.widget.theme}"
  data-primary-color="${blueprint.branding.primaryColor}"${
  blueprint.widget.buttonText
    ? `\n  data-button-text="${blueprint.widget.buttonText}"`
    : ''
}>
</script>`

      logger.info(
        {
          orgId,
          orgType: blueprint.orgType,
          catalogItems: catalogCount,
          resources: resourceCount,
          slots: slotCount,
        },
        '[onboard] business fully configured'
      )

      return {
        organizationId: orgId,
        blueprint,
        apiKey: rawKey,
        widgetCode,
        catalogItemCount: catalogCount,
        resourceCount,
        slotCount,
      }
    })
  }
}
