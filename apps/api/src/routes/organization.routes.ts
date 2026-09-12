import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { query } from '../lib/db'
import { requireAuth } from '../lib/auth'
import { OrganizationService, type OrgType } from '../services/organization.service'
import { logger } from '../lib/logger'

const orgs = new OrganizationService()

const CreateOrgSchema = z.object({
  vendorId: z.string().uuid(),
  legalName: z.string().min(2).max(160),
  displayName: z.string().min(2).max(120),
  orgType: z.enum([
    'individual', 'restaurant', 'clinic', 'hospital',
    'salon', 'studio', 'agency', 'retail',
  ]),
  supportedBookingTypes: z
    .array(z.enum(['quote', 'appointment', 'hiring', 'order']))
    .min(1),
  address: z.string().max(400).optional(),
  area: z.string().max(80).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  contactPhone: z.string().max(20).optional(),
})

const TablesSchema = z.object({
  specs: z
    .array(
      z.object({
        count: z.number().int().min(1).max(200),
        seats: z.number().int().min(1).max(30),
        minimumSpend: z.number().int().min(0).optional(),
      })
    )
    .min(1),
})

const PractitionerSchema = z.object({
  name: z.string().min(2).max(120),
  specialization: z.string().max(120).optional(),
  qualification: z.string().max(200).optional(),
  experienceYears: z.number().int().min(0).max(70).optional(),
  consultationFee: z.number().int().min(0).optional(),
  registrationNumber: z.string().max(60).optional(),
  council: z.string().max(160).optional(),
})

const CatalogSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        price: z.number().int().min(0),
        section: z.string().max(80).optional(),
        description: z.string().max(400).optional(),
        isVeg: z.boolean().optional(),
        servesCount: z.number().int().min(1).max(50).optional(),
      })
    )
    .min(1)
    .max(200),
})

const SlotsSchema = z.object({
  resourceId: z.string().uuid(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  durationMinutes: z.number().int().min(5).max(480),
  weeksAhead: z.number().int().min(1).max(12).optional(),
  capacityPerSlot: z.number().int().min(1).max(50).optional(),
})

const CredentialSchema = z.object({
  credentialType: z.enum([
    'gst', 'fssai', 'shop_establishment', 'medical_registration',
    'clinical_establishment', 'trade_licence', 'pan', 'other',
  ]),
  credentialNumber: z.string().min(3).max(60),
  issuingAuthority: z.string().max(160).optional(),
  validUntil: z.string().optional(),
  documentUrl: z.string().url().optional(),
})

export async function organizationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ─── Create organization ────────────────────────────────────────────────────
  app.post('/organizations', async (req, reply) => {
    const parsed = CreateOrgSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }
    const d = parsed.data

    // Verify the caller owns this vendor record
    const owns = await query(
      'SELECT 1 FROM vendors WHERE id = $1 AND user_id = $2',
      [d.vendorId, req.user!.id]
    )
    if (owns.rowCount === 0) {
      return reply.code(403).send({ message: 'Not your vendor profile' })
    }

    const { organizationId, requiresManualApproval } = await orgs.create({
      ...d,
      userId: req.user!.id,
      orgType: d.orgType as OrgType,
    })

    const status = await orgs.getStatus(organizationId)

    return reply.send({
      organizationId,
      requiresManualApproval,
      status,
      message: requiresManualApproval
        ? `${d.displayName} is registered. Let's get your details set up — ` +
          `our team will verify your licences before you go live.`
        : `${d.displayName} is registered. Let's finish setting up.`,
    })
  })

  // ─── Onboarding status + next step ─────────────────────────────────────────
  // The agent polls this to know what to ask next.
  app.get<{ Params: { id: string } }>('/organizations/:id/status', async (req, reply) => {
    const allowed = await orgs.checkPermission(req.user!.id, req.params.id, 'accept_bookings')
    if (!allowed) return reply.code(403).send({ message: 'Not a member of this organization' })

    const status = await orgs.getStatus(req.params.id)
    if (!status) return reply.code(404).send({ message: 'Organization not found' })

    return reply.send(status)
  })

  // ─── Restaurant: bulk-create tables ────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/organizations/:id/tables', async (req, reply) => {
    const allowed = await orgs.checkPermission(req.user!.id, req.params.id, 'manage_catalog')
    if (!allowed) return reply.code(403).send({ message: 'You cannot manage this organization' })

    const parsed = TablesSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const created = await orgs.createTables(req.params.id, parsed.data.specs)
    const totalSeats = parsed.data.specs.reduce((s, x) => s + x.count * x.seats, 0)

    return reply.send({
      created,
      totalSeats,
      message: `${created} tables added, seating up to ${totalSeats} people.`,
    })
  })

  // ─── Clinic/hospital: add a doctor ─────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/organizations/:id/practitioners',
    async (req, reply) => {
      const allowed = await orgs.checkPermission(req.user!.id, req.params.id, 'manage_staff')
      if (!allowed) return reply.code(403).send({ message: 'You cannot manage staff here' })

      const parsed = PractitionerSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ message: parsed.error.errors[0].message })
      }

      // For health orgs, registration details are mandatory
      const orgResult = await query<{ org_type: string }>(
        'SELECT org_type FROM organizations WHERE id = $1',
        [req.params.id]
      )
      const orgType = orgResult.rows[0]?.org_type
      const isHealthOrg = orgType === 'clinic' || orgType === 'hospital'

      if (isHealthOrg && (!parsed.data.registrationNumber || !parsed.data.council)) {
        return reply.code(400).send({
          message:
            'Medical council registration number and council name are required ' +
            'for every practitioner. This is a legal requirement.',
        })
      }

      const { resourceId, needsVerification } = await orgs.addPractitioner({
        organizationId: req.params.id,
        ...parsed.data,
      })

      return reply.send({
        resourceId,
        needsVerification,
        isActive: !needsVerification,
        message: needsVerification
          ? `${parsed.data.name} added. Their registration will be verified by ` +
            `our team before they can accept bookings — usually within 24 hours.`
          : `${parsed.data.name} added and ready to take bookings.`,
      })
    }
  )

  // ─── Add catalog items (menu / service list) ────────────────────────────────
  app.post<{ Params: { id: string } }>('/organizations/:id/catalog', async (req, reply) => {
    const allowed = await orgs.checkPermission(req.user!.id, req.params.id, 'manage_catalog')
    if (!allowed) return reply.code(403).send({ message: 'You cannot manage the catalog' })

    const parsed = CatalogSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    const created = await orgs.addCatalogItems(req.params.id, parsed.data.items)
    return reply.send({ created, message: `${created} items added.` })
  })

  // ─── Browse a catalog (customer-facing) ───────────────────────────────────
  app.get<{ Params: { id: string } }>('/organizations/:id/catalog', async (req, reply) => {
    const result = await query<{
      id: string
      name: string
      description: string | null
      section: string | null
      price: number
      is_veg: boolean | null
      serves_count: number | null
      image_url: string | null
    }>(
      `SELECT id, name, description, section, price, is_veg, serves_count, image_url
       FROM catalog_items
       WHERE organization_id = $1 AND is_available = true
       ORDER BY section NULLS LAST, display_order, name`,
      [req.params.id]
    )

    // Group by section for display
    const sections = new Map<string, typeof result.rows>()
    for (const item of result.rows) {
      const key = item.section ?? 'Other'
      if (!sections.has(key)) sections.set(key, [])
      sections.get(key)!.push(item)
    }

    return reply.send({
      sections: [...sections.entries()].map(([name, items]) => ({
        name,
        items: items.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          price: i.price,
          isVeg: i.is_veg,
          servesCount: i.serves_count,
          imageUrl: i.image_url,
        })),
      })),
    })
  })

  // ─── Generate slots for a resource ─────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/organizations/:id/slots', async (req, reply) => {
    const allowed = await orgs.checkPermission(req.user!.id, req.params.id, 'manage_catalog')
    if (!allowed) return reply.code(403).send({ message: 'You cannot manage this organization' })

    const parsed = SlotsSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }

    // Verify the resource belongs to this org
    const owns = await query(
      'SELECT 1 FROM bookable_resources WHERE id = $1 AND organization_id = $2',
      [parsed.data.resourceId, req.params.id]
    )
    if (owns.rowCount === 0) {
      return reply.code(404).send({ message: 'Resource not found in this organization' })
    }

    const created = await orgs.generateSlots(parsed.data)
    return reply.send({ created, message: `${created} slots created.` })
  })

  // ─── List bookable resources (customer-facing) ─────────────────────────────
  app.get<{ Params: { id: string } }>('/organizations/:id/resources', async (req, reply) => {
    const result = await query<{
      id: string
      resource_type: string
      name: string
      specialization: string | null
      qualification: string | null
      experience_years: number | null
      base_price: number | null
      price_unit: string | null
      capacity_min: number
      capacity_max: number
    }>(
      `SELECT id, resource_type, name, specialization, qualification,
              experience_years, base_price, price_unit, capacity_min, capacity_max
       FROM bookable_resources
       WHERE organization_id = $1 AND is_active = true
       ORDER BY display_order, name`,
      [req.params.id]
    )

    return reply.send({
      resources: result.rows.map((r) => ({
        id: r.id,
        type: r.resource_type,
        name: r.name,
        specialization: r.specialization,
        qualification: r.qualification,
        experienceYears: r.experience_years,
        price: r.base_price,
        priceUnit: r.price_unit,
        capacityMin: r.capacity_min,
        capacityMax: r.capacity_max,
      })),
    })
  })

  // ─── Available slots for a resource ────────────────────────────────────────
  app.get<{ Params: { resourceId: string }; Querystring: { date?: string; partySize?: string } }>(
    '/resources/:resourceId/slots',
    async (req, reply) => {
      const date = req.query.date ?? new Date().toISOString().split('T')[0]
      const partySize = req.query.partySize ? parseInt(req.query.partySize) : null

      // If a party size is given, check the resource can seat them
      if (partySize) {
        const cap = await query<{ capacity_min: number; capacity_max: number }>(
          'SELECT capacity_min, capacity_max FROM bookable_resources WHERE id = $1',
          [req.params.resourceId]
        )
        const c = cap.rows[0]
        if (c && (partySize < c.capacity_min || partySize > c.capacity_max)) {
          return reply.send({
            slots: [],
            message: `This table seats ${c.capacity_min}–${c.capacity_max} people.`,
          })
        }
      }

      const result = await query<{
        id: string
        slot_time: string
        capacity_booked: number
        capacity_total: number
        price_override: number | null
      }>(
        `SELECT id, slot_time, capacity_booked, capacity_total, price_override
         FROM resource_slots
         WHERE resource_id = $1
           AND slot_time::date = $2::date
           AND is_cancelled = false
           AND slot_time > now()
         ORDER BY slot_time`,
        [req.params.resourceId, date]
      )

      return reply.send({
        slots: result.rows.map((s) => ({
          id: s.id,
          slotTime: s.slot_time,
          available: s.capacity_booked < s.capacity_total,
          capacityBooked: s.capacity_booked,
          capacityTotal: s.capacity_total,
          price: s.price_override,
        })),
      })
    }
  )

  // ─── Submit a business credential ──────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/organizations/:id/credentials', async (req, reply) => {
    const allowed = await orgs.checkPermission(req.user!.id, req.params.id, 'manage_staff')
    if (!allowed) return reply.code(403).send({ message: 'You cannot manage this organization' })

    const parsed = CredentialSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.errors[0].message })
    }
    const d = parsed.data

    await query(
      `INSERT INTO business_credentials
         (organization_id, credential_type, credential_number,
          issuing_authority, valid_until, document_url)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organization_id, credential_type, credential_number)
         DO UPDATE SET document_url = EXCLUDED.document_url,
                       verification_status = 'pending'`,
      [
        req.params.id,
        d.credentialType,
        d.credentialNumber,
        d.issuingAuthority ?? null,
        d.validUntil ?? null,
        d.documentUrl ?? null,
      ]
    )

    logger.info(
      { orgId: req.params.id, type: d.credentialType },
      'Business credential submitted for verification'
    )

    return reply.send({
      success: true,
      message:
        'Received. Our team will verify this — usually within 24 hours. ' +
        "We'll notify you once it's approved.",
    })
  })

  // ─── Invite staff ──────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/organizations/:id/invites', async (req, reply) => {
    const allowed = await orgs.checkPermission(req.user!.id, req.params.id, 'manage_staff')
    if (!allowed) return reply.code(403).send({ message: 'You cannot invite staff' })

    const { phone, role } = (req.body ?? {}) as { phone?: string; role?: string }
    if (!phone?.match(/^\+91[6-9]\d{9}$/)) {
      return reply.code(400).send({ message: 'Valid Indian mobile number required' })
    }
    const validRoles = ['manager', 'staff', 'practitioner']
    if (!role || !validRoles.includes(role)) {
      return reply.code(400).send({ message: `role must be one of: ${validRoles.join(', ')}` })
    }

    const { inviteCode } = await orgs.inviteStaff(
      req.params.id,
      req.user!.id,
      phone,
      role as 'manager' | 'staff' | 'practitioner'
    )

    return reply.send({
      inviteCode,
      message:
        `Invite created. Share this code with them: ${inviteCode}\n` +
        `They enter it after signing up. Expires in 7 days.`,
    })
  })

  // ─── Accept an invite ──────────────────────────────────────────────────────
  app.post('/organizations/accept-invite', async (req, reply) => {
    const { inviteCode } = (req.body ?? {}) as { inviteCode?: string }
    if (!inviteCode) return reply.code(400).send({ message: 'Invite code required' })

    const result = await orgs.acceptInvite(
      req.user!.phone,
      req.user!.id,
      inviteCode.toUpperCase()
    )

    if (!result) {
      return reply.code(404).send({
        message: 'Invalid or expired invite code, or it was issued for a different number.',
      })
    }

    const org = await query<{ display_name: string }>(
      'SELECT display_name FROM organizations WHERE id = $1',
      [result.organizationId]
    )

    return reply.send({
      organizationId: result.organizationId,
      role: result.role,
      message: `You've joined ${org.rows[0]?.display_name ?? 'the organization'} as ${result.role}.`,
    })
  })

  // ─── My organizations ──────────────────────────────────────────────────────
  app.get('/organizations/mine', async (req, reply) => {
    const result = await query<{
      id: string
      display_name: string
      org_type: string
      role: string
      verification_status: string
    }>(
      `SELECT o.id, o.display_name, o.org_type, m.role, o.verification_status
       FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.is_active = true
       ORDER BY m.joined_at`,
      [req.user!.id]
    )

    return reply.send({ organizations: result.rows })
  })
}
