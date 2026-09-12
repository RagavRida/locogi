/**
 * OrganizationService — enrollment for businesses, not just individuals.
 *
 * A solo plumber and a 200-bed hospital both become "vendors", but the
 * onboarding they need is completely different:
 *
 *   Plumber     → describe work, done. Live in one step.
 *   Restaurant  → outlet details + FSSAI licence + tables + menu + staff
 *   Hospital    → clinical registration + departments + per-doctor
 *                 registration verification + emergency safeguards
 *
 * This service drives a type-specific onboarding checklist so the agent knows
 * what to ask next, and refuses to let a regulated org go live until a human
 * has verified its credentials.
 */

import { query, withTransaction } from '../lib/db'
import { generateEmbedding } from '../lib/nim'
import { indexLocation } from '../lib/h3'
import { logger } from '../lib/logger'
import { randomBytes } from 'crypto'

export type OrgType =
  | 'individual' | 'restaurant' | 'clinic' | 'hospital'
  | 'salon' | 'studio' | 'agency' | 'retail'

export interface OnboardingStep {
  key: string
  label: string
  description: string
  isComplete: boolean
  isBlocking: boolean       // must be done before going live
  agentPrompt: string       // what the agent says to collect this
}

export interface OrgStatus {
  organizationId: string
  orgType: OrgType
  displayName: string
  verificationStatus: string
  isLive: boolean
  steps: OnboardingStep[]
  nextStep: OnboardingStep | null
  blockingReason: string | null
}

export class OrganizationService {

  // ─── Create an organization for a vendor ────────────────────────────────────
  async create(params: {
    vendorId: string
    userId: string
    legalName: string
    displayName: string
    orgType: OrgType
    supportedBookingTypes: string[]
    address?: string
    area?: string
    lat?: number
    lng?: number
    contactPhone?: string
  }): Promise<{ organizationId: string; requiresManualApproval: boolean }> {

    // Regulated org types always need a human to approve
    const requiresManualApproval = ['clinic', 'hospital', 'restaurant'].includes(
      params.orgType
    )

    const h3 =
      params.lat && params.lng
        ? indexLocation(params.lat, params.lng)
        : { h3_r8: null, h3_r7: null }

    return withTransaction(async (client) => {
      const orgResult = await client.query<{ id: string }>(
        `INSERT INTO organizations
           (vendor_id, legal_name, display_name, org_type,
            supported_booking_types, address, area, lat, lng, h3_r8, h3_r7,
            contact_phone, requires_manual_approval, verification_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 CASE WHEN $13 THEN 'pending' ELSE 'verified' END)
         RETURNING id`,
        [
          params.vendorId,
          params.legalName,
          params.displayName,
          params.orgType,
          params.supportedBookingTypes,
          params.address ?? null,
          params.area ?? null,
          params.lat ?? null,
          params.lng ?? null,
          h3.h3_r8,
          h3.h3_r7,
          params.contactPhone ?? null,
          requiresManualApproval,
        ]
      )

      const orgId = orgResult.rows[0].id

      // The creating user becomes owner with full permissions
      await client.query(
        `INSERT INTO organization_members
           (organization_id, user_id, role, can_accept_bookings,
            can_manage_catalog, can_manage_staff, can_view_earnings)
         VALUES ($1, $2, 'owner', true, true, true, true)`,
        [orgId, params.userId]
      )

      logger.info(
        { orgId, orgType: params.orgType, requiresManualApproval },
        'Organization created'
      )

      return { organizationId: orgId, requiresManualApproval }
    })
  }

  // ─── The onboarding checklist, per org type ─────────────────────────────────
  // This is what makes the agent able to walk a restaurant through setup
  // without a human explaining anything.
  async getStatus(organizationId: string): Promise<OrgStatus | null> {
    const orgResult = await query<{
      id: string
      org_type: OrgType
      display_name: string
      verification_status: string
      supported_booking_types: string[]
      address: string | null
      lat: number | null
    }>(
      `SELECT id, org_type, display_name, verification_status,
              supported_booking_types, address, lat
       FROM organizations WHERE id = $1`,
      [organizationId]
    )

    const org = orgResult.rows[0]
    if (!org) return null

    // Gather completion state in parallel
    const [creds, resources, catalog, slots, staff, practCreds] = await Promise.all([
      query<{ credential_type: string; verification_status: string }>(
        'SELECT credential_type, verification_status FROM business_credentials WHERE organization_id = $1',
        [organizationId]
      ),
      query<{ count: string }>(
        'SELECT COUNT(*) FROM bookable_resources WHERE organization_id = $1 AND is_active = true',
        [organizationId]
      ),
      query<{ count: string }>(
        'SELECT COUNT(*) FROM catalog_items WHERE organization_id = $1',
        [organizationId]
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) FROM resource_slots rs
         JOIN bookable_resources r ON r.id = rs.resource_id
         WHERE r.organization_id = $1 AND rs.slot_time > now()`,
        [organizationId]
      ),
      query<{ count: string }>(
        'SELECT COUNT(*) FROM organization_members WHERE organization_id = $1 AND is_active = true',
        [organizationId]
      ),
      query<{ total: string; verified: string }>(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE verification_status = 'verified') AS verified
         FROM practitioner_credentials pc
         JOIN bookable_resources r ON r.id = pc.resource_id
         WHERE r.organization_id = $1`,
        [organizationId]
      ),
    ])

    const credMap = new Map(
      creds.rows.map((c) => [c.credential_type, c.verification_status])
    )
    const resourceCount = Number(resources.rows[0]?.count ?? 0)
    const catalogCount = Number(catalog.rows[0]?.count ?? 0)
    const slotCount = Number(slots.rows[0]?.count ?? 0)
    const staffCount = Number(staff.rows[0]?.count ?? 0)
    const practTotal = Number(practCreds.rows[0]?.total ?? 0)
    const practVerified = Number(practCreds.rows[0]?.verified ?? 0)

    // Required credentials for this org type
    const required = await query<{ credential_type: string; is_mandatory: boolean; note: string | null }>(
      'SELECT credential_type, is_mandatory, note FROM org_type_requirements WHERE org_type = $1',
      [org.org_type]
    )

    const steps: OnboardingStep[] = []

    // ── Location (everyone) ────────────────────────────────────────────────
    steps.push({
      key: 'location',
      label: 'Location',
      description: 'Where customers find you',
      isComplete: org.address !== null && org.lat !== null,
      isBlocking: true,
      agentPrompt: "What's your full address? This is how customers near you find you.",
    })

    // ── Legally required credentials ────────────────────────────────────────
    for (const r of required.rows) {
      const status = credMap.get(r.credential_type)
      steps.push({
        key: `credential_${r.credential_type}`,
        label: this.credentialLabel(r.credential_type),
        description: r.note ?? 'Business credential',
        isComplete: status === 'verified',
        isBlocking: r.is_mandatory,
        agentPrompt: this.credentialPrompt(r.credential_type),
      })
    }

    // ── Type-specific steps ────────────────────────────────────────────────
    switch (org.org_type) {
      case 'restaurant': {
        steps.push({
          key: 'tables',
          label: 'Tables',
          description: 'Your seating, so we can take reservations',
          isComplete: resourceCount > 0,
          isBlocking: org.supported_booking_types.includes('appointment'),
          agentPrompt:
            "How many tables do you have, and what party sizes? " +
            "For example: \"4 tables for 2, 6 tables for 4, 2 tables for 8\".",
        })
        steps.push({
          key: 'menu',
          label: 'Menu',
          description: 'Items customers can order',
          isComplete: catalogCount > 0,
          isBlocking: org.supported_booking_types.includes('order'),
          agentPrompt:
            "Send me your menu — you can type it or upload a photo. " +
            "Item name and price is enough to start.",
        })
        steps.push({
          key: 'slots',
          label: 'Reservation times',
          description: 'When tables are bookable',
          isComplete: slotCount > 0,
          isBlocking: false,
          agentPrompt:
            "What are your service hours? For example: " +
            "\"lunch 12 to 3, dinner 7 to 11, closed Mondays\".",
        })
        break
      }

      case 'clinic':
      case 'hospital': {
        steps.push({
          key: 'practitioners',
          label: 'Doctors',
          description: 'Each doctor patients can book',
          isComplete: resourceCount > 0,
          isBlocking: true,
          agentPrompt:
            "Tell me about each doctor: name, specialisation, qualification, " +
            "and consultation fee. One per message is fine.",
        })
        steps.push({
          key: 'practitioner_registration',
          label: 'Medical registrations',
          description: 'State medical council registration for every doctor',
          isComplete: practTotal > 0 && practVerified === practTotal,
          isBlocking: true,
          agentPrompt:
            "I need each doctor's state medical council registration number. " +
            "This is a legal requirement and we verify it manually before you go live.",
        })
        steps.push({
          key: 'slots',
          label: 'OPD timings',
          description: 'Consultation slots per doctor',
          isComplete: slotCount > 0,
          isBlocking: true,
          agentPrompt:
            "What are the OPD timings for each doctor? For example: " +
            "\"Dr. Priya: Mon-Sat 10am-1pm, 15 min slots\".",
        })
        break
      }

      case 'salon':
      case 'studio': {
        steps.push({
          key: 'resources',
          label: 'Stylists / chairs',
          description: 'Who or what customers book',
          isComplete: resourceCount > 0,
          isBlocking: true,
          agentPrompt:
            "Who works there? Give me each stylist's name and speciality, " +
            "or just tell me how many chairs you have.",
        })
        steps.push({
          key: 'services',
          label: 'Service list',
          description: 'Services with prices',
          isComplete: catalogCount > 0,
          isBlocking: false,
          agentPrompt:
            "What services do you offer and at what price? " +
            "For example: \"haircut ₹300, colour ₹1500, facial ₹800\".",
        })
        break
      }

      case 'agency':
      case 'retail': {
        steps.push({
          key: 'catalog',
          label: 'Catalog',
          description: 'What you offer',
          isComplete: catalogCount > 0,
          isBlocking: false,
          agentPrompt: 'What do you offer, and at what prices?',
        })
        break
      }

      case 'individual':
      default:
        // Solo vendors need nothing beyond their description — already done
        break
    }

    // ── Staff (optional, but useful) ───────────────────────────────────────
    if (org.org_type !== 'individual') {
      steps.push({
        key: 'staff',
        label: 'Team access',
        description: 'Staff who can manage bookings',
        isComplete: staffCount > 1,
        isBlocking: false,
        agentPrompt:
          'Want to give your staff access? Send me their phone numbers and ' +
          "I'll invite them.",
      })
    }

    const blocking = steps.filter((s) => s.isBlocking && !s.isComplete)
    const isLive =
      org.verification_status === 'verified' && blocking.length === 0

    return {
      organizationId: org.id,
      orgType: org.org_type,
      displayName: org.display_name,
      verificationStatus: org.verification_status,
      isLive,
      steps,
      nextStep: steps.find((s) => !s.isComplete) ?? null,
      blockingReason:
        blocking.length > 0
          ? `Waiting on: ${blocking.map((s) => s.label).join(', ')}`
          : org.verification_status !== 'verified'
          ? 'Awaiting manual verification by our team'
          : null,
    }
  }

  // ─── Bulk-create tables from a natural description ──────────────────────────
  // "4 tables for 2, 6 tables for 4, 2 tables for 8"
  async createTables(
    organizationId: string,
    specs: Array<{ count: number; seats: number; minimumSpend?: number }>
  ): Promise<number> {
    let created = 0
    let tableNumber = 1

    // Continue numbering from any existing tables
    const existing = await query<{ count: string }>(
      `SELECT COUNT(*) FROM bookable_resources
       WHERE organization_id = $1 AND resource_type = 'table'`,
      [organizationId]
    )
    tableNumber = Number(existing.rows[0]?.count ?? 0) + 1

    for (const spec of specs) {
      for (let i = 0; i < spec.count; i++) {
        await query(
          `INSERT INTO bookable_resources
             (organization_id, resource_type, name,
              capacity_min, capacity_max, base_price, price_unit, display_order)
           VALUES ($1, 'table', $2, $3, $4, $5, 'minimum_spend', $6)`,
          [
            organizationId,
            `Table ${tableNumber}`,
            Math.max(1, spec.seats - 1),
            spec.seats,
            spec.minimumSpend ?? null,
            tableNumber,
          ]
        )
        tableNumber++
        created++
      }
    }

    logger.info({ organizationId, created }, 'Tables created')
    return created
  }

  // ─── Add a practitioner (doctor, stylist, trainer) ─────────────────────────
  async addPractitioner(params: {
    organizationId: string
    name: string
    specialization?: string
    qualification?: string
    experienceYears?: number
    consultationFee?: number
    registrationNumber?: string
    council?: string
  }): Promise<{ resourceId: string; needsVerification: boolean }> {

    // Embed the specialisation so "heart doctor" finds Cardiology
    let embedding: string | null = null
    try {
      const vec = await generateEmbedding(
        [params.name, params.specialization, params.qualification]
          .filter(Boolean)
          .join(' ')
      )
      embedding = `[${vec.join(',')}]`
    } catch { /* non-fatal */ }

    const result = await query<{ id: string }>(
      `INSERT INTO bookable_resources
         (organization_id, resource_type, name, specialization, qualification,
          experience_years, base_price, price_unit, embedding)
       VALUES ($1, 'person', $2, $3, $4, $5, $6, 'per_visit', $7::vector)
       RETURNING id`,
      [
        params.organizationId,
        params.name,
        params.specialization ?? null,
        params.qualification ?? null,
        params.experienceYears ?? null,
        params.consultationFee ?? null,
        embedding,
      ]
    )

    const resourceId = result.rows[0].id

    // Medical registration must be recorded and verified manually
    let needsVerification = false
    if (params.registrationNumber && params.council) {
      await query(
        `INSERT INTO practitioner_credentials
           (resource_id, registration_number, council, qualification)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (resource_id, registration_number) DO NOTHING`,
        [
          resourceId,
          params.registrationNumber,
          params.council,
          params.qualification ?? 'Not provided',
        ]
      )
      needsVerification = true

      // Deactivate until verified — a doctor cannot take bookings on an
      // unverified registration
      await query(
        'UPDATE bookable_resources SET is_active = false WHERE id = $1',
        [resourceId]
      )
    }

    logger.info(
      { resourceId, name: params.name, needsVerification },
      'Practitioner added'
    )

    return { resourceId, needsVerification }
  }

  // ─── Add catalog items (menu, service list) ────────────────────────────────
  async addCatalogItems(
    organizationId: string,
    items: Array<{
      name: string
      price: number
      section?: string
      description?: string
      isVeg?: boolean
      servesCount?: number
    }>
  ): Promise<number> {
    let created = 0

    for (const item of items) {
      let embedding: string | null = null
      try {
        const vec = await generateEmbedding(
          `${item.name} ${item.section ?? ''} ${item.description ?? ''}`
        )
        embedding = `[${vec.join(',')}]`
      } catch { /* non-fatal */ }

      await query(
        `INSERT INTO catalog_items
           (organization_id, name, description, section, price,
            is_veg, serves_count, embedding, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9)`,
        [
          organizationId,
          item.name.slice(0, 120),
          item.description ?? null,
          item.section ?? null,
          item.price,
          item.isVeg ?? null,
          item.servesCount ?? null,
          embedding,
          created,
        ]
      )
      created++
    }

    logger.info({ organizationId, created }, 'Catalog items added')
    return created
  }

  // ─── Generate recurring slots for a resource ───────────────────────────────
  async generateSlots(params: {
    resourceId: string
    daysOfWeek: number[]        // [1,2,3,4,5,6] = Mon–Sat
    startTime: string           // '10:00'
    endTime: string             // '13:00'
    durationMinutes: number
    weeksAhead?: number
    capacityPerSlot?: number
  }): Promise<number> {
    const weeks = params.weeksAhead ?? 4
    const [startH, startM] = params.startTime.split(':').map(Number)
    const [endH, endM] = params.endTime.split(':').map(Number)

    let created = 0
    const now = new Date()

    for (let d = 0; d < weeks * 7; d++) {
      const date = new Date(now)
      date.setDate(now.getDate() + d)

      // IST day-of-week
      const istDay = new Date(
        date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
      ).getDay()
      if (!params.daysOfWeek.includes(istDay)) continue

      const dayStart = new Date(date)
      dayStart.setHours(startH, startM, 0, 0)
      const dayEnd = new Date(date)
      dayEnd.setHours(endH, endM, 0, 0)

      for (
        let t = new Date(dayStart);
        t < dayEnd;
        t = new Date(t.getTime() + params.durationMinutes * 60_000)
      ) {
        if (t <= now) continue

        await query(
          `INSERT INTO resource_slots
             (resource_id, slot_time, duration_minutes, capacity_total)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (resource_id, slot_time) DO NOTHING`,
          [
            params.resourceId,
            t.toISOString(),
            params.durationMinutes,
            params.capacityPerSlot ?? 1,
          ]
        )
        created++
      }
    }

    logger.info({ resourceId: params.resourceId, created }, 'Slots generated')
    return created
  }

  // ─── Invite staff by phone ─────────────────────────────────────────────────
  async inviteStaff(
    organizationId: string,
    invitedBy: string,
    phone: string,
    role: 'manager' | 'staff' | 'practitioner'
  ): Promise<{ inviteCode: string }> {
    const inviteCode = randomBytes(4).toString('hex').toUpperCase()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await query(
      `INSERT INTO organization_invites
         (organization_id, phone, role, invite_code, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [organizationId, phone, role, inviteCode, invitedBy, expiresAt]
    )

    return { inviteCode }
  }

  // ─── Accept an invite (called after the invitee signs up) ──────────────────
  async acceptInvite(
    phone: string,
    userId: string,
    inviteCode: string
  ): Promise<{ organizationId: string; role: string } | null> {
    const result = await query<{
      id: string
      organization_id: string
      role: string
    }>(
      `SELECT id, organization_id, role FROM organization_invites
       WHERE invite_code = $1
         AND phone = $2
         AND accepted_at IS NULL
         AND expires_at > now()`,
      [inviteCode, phone]
    )

    const invite = result.rows[0]
    if (!invite) return null

    const perms =
      invite.role === 'manager'
        ? { catalog: true, staff: true, earnings: true }
        : { catalog: false, staff: false, earnings: false }

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO organization_members
           (organization_id, user_id, role, can_accept_bookings,
            can_manage_catalog, can_manage_staff, can_view_earnings, invited_by)
         VALUES ($1,$2,$3,true,$4,$5,$6,
                 (SELECT invited_by FROM organization_invites WHERE id = $7))
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [
          invite.organization_id,
          userId,
          invite.role,
          perms.catalog,
          perms.staff,
          perms.earnings,
          invite.id,
        ]
      )
      await client.query(
        'UPDATE organization_invites SET accepted_at = now() WHERE id = $1',
        [invite.id]
      )
      await client.query('UPDATE users SET is_vendor = true WHERE id = $1', [userId])
    })

    return { organizationId: invite.organization_id, role: invite.role }
  }

  // ─── Permission check ──────────────────────────────────────────────────────
  async checkPermission(
    userId: string,
    organizationId: string,
    permission: 'accept_bookings' | 'manage_catalog' | 'manage_staff' | 'view_earnings'
  ): Promise<boolean> {
    const col = `can_${permission}`
    const result = await query(
      `SELECT 1 FROM organization_members
       WHERE user_id = $1 AND organization_id = $2
         AND is_active = true AND ${col} = true`,
      [userId, organizationId]
    )
    return (result.rowCount ?? 0) > 0
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  private credentialLabel(type: string): string {
    const labels: Record<string, string> = {
      gst: 'GST registration',
      fssai: 'FSSAI food licence',
      shop_establishment: 'Shops & Establishments registration',
      medical_registration: 'Medical council registration',
      clinical_establishment: 'Clinical Establishments registration',
      trade_licence: 'Trade licence',
      pan: 'Business PAN',
      other: 'Other credential',
    }
    return labels[type] ?? type
  }

  private credentialPrompt(type: string): string {
    const prompts: Record<string, string> = {
      fssai:
        "I need your FSSAI licence number — it's legally required for any food " +
        'business. You can also upload a photo of the certificate.',
      gst: "What's your GST number?",
      shop_establishment:
        'Do you have a Shops & Establishments registration number?',
      medical_registration:
        "I need the state medical council registration number for each doctor. " +
        'We verify these manually before you go live.',
      clinical_establishment:
        "What's your Clinical Establishments Act registration number?",
      trade_licence: "What's your municipal trade licence number?",
      pan: "What's your business PAN?",
    }
    return prompts[type] ?? `Please provide your ${this.credentialLabel(type)}.`
  }
}
