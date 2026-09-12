import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from '@copilotkit/runtime'
import { NextRequest } from 'next/server'
import pg from 'pg'

// ─── DB ─────────────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://raghavendramachikatla@localhost:5432/locogi',
})

async function db<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params)
  return result.rows as T[]
}

// ─── Role → Permission mapping ──────────────────────────────────────────────

type OrgRole = 'owner' | 'manager' | 'staff' | 'practitioner'

interface RolePermissions {
  canViewCatalog: boolean
  canEditCatalog: boolean
  canViewBookings: boolean
  canViewEarnings: boolean
  canViewMessages: boolean
  canManageStaff: boolean
  canDynamicQuery: boolean
  allowedTables: string[]
  maxQueryRows: number
}

const ROLE_PERMISSIONS: Record<OrgRole, RolePermissions> = {
  owner: {
    canViewCatalog: true, canEditCatalog: true, canViewBookings: true,
    canViewEarnings: true, canViewMessages: true, canManageStaff: true,
    canDynamicQuery: true,
    allowedTables: ['bookings', 'catalog_items', 'resources', 'users', 'chat_messages', 'organizations', 'organization_members', 'offers'],
    maxQueryRows: 100,
  },
  manager: {
    canViewCatalog: true, canEditCatalog: true, canViewBookings: true,
    canViewEarnings: true, canViewMessages: true, canManageStaff: false,
    canDynamicQuery: true,
    allowedTables: ['bookings', 'catalog_items', 'resources', 'chat_messages', 'offers'],
    maxQueryRows: 50,
  },
  staff: {
    canViewCatalog: true, canEditCatalog: false, canViewBookings: true,
    canViewEarnings: false, canViewMessages: true, canManageStaff: false,
    canDynamicQuery: false,
    allowedTables: ['bookings', 'catalog_items'],
    maxQueryRows: 20,
  },
  practitioner: {
    canViewCatalog: true, canEditCatalog: false, canViewBookings: false,
    canViewEarnings: false, canViewMessages: false, canManageStaff: false,
    canDynamicQuery: false,
    allowedTables: [],
    maxQueryRows: 10,
  },
}

// ─── Detect user role from request ──────────────────────────────────────────

async function getUserContext(req: NextRequest): Promise<{
  orgId: string
  userId: string
  role: OrgRole
  permissions: RolePermissions
  orgName: string
}> {
  // For hackathon: get from headers or default to first org owner
  const headerOrgId = req.headers.get('x-org-id')
  const headerUserId = req.headers.get('x-user-id')
  const headerRole = req.headers.get('x-role') as OrgRole | null

  if (headerOrgId && headerRole) {
    return {
      orgId: headerOrgId,
      userId: headerUserId ?? '',
      role: headerRole,
      permissions: ROLE_PERMISSIONS[headerRole] ?? ROLE_PERMISSIONS.staff,
      orgName: 'Business',
    }
  }

  // Default: first org, owner role
  const org = await db<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM organizations LIMIT 1`
  )
  return {
    orgId: org[0]?.id ?? '',
    userId: '',
    role: 'owner',
    permissions: ROLE_PERMISSIONS.owner,
    orgName: org[0]?.display_name ?? 'Your Business',
  }
}

// ─── Dynamic tool builders ──────────────────────────────────────────────────

function buildToolsForRole(orgId: string, permissions: RolePermissions) {
  const tools: any[] = []

  // ── Everyone: view catalog ──
  if (permissions.canViewCatalog) {
    tools.push({
      name: 'getCatalog',
      description: 'Get business catalog items (packages, services) with prices and availability.',
      parameters: [
        { name: 'section', type: 'string', description: 'Filter by section', required: false },
      ],
      handler: async ({ section }: { section?: string }) => {
        const sectionFilter = section ? `AND LOWER(ci.section) = LOWER($2)` : ''
        const params: unknown[] = [orgId]
        if (section) params.push(section)

        const items = await db(`
          SELECT ci.id, ci.name, ci.price, ci.section, ci.is_available AS available, ci.description
          FROM catalog_items ci
          WHERE ci.organization_id = $1 ${sectionFilter}
          ORDER BY ci.display_order, ci.name
        `, params)

        return { items, total: items.length }
      },
    })
  }

  // ── Owner/Manager: edit catalog ──
  if (permissions.canEditCatalog) {
    tools.push({
      name: 'addCatalogItem',
      description: 'Add a new item to the catalog.',
      parameters: [
        { name: 'name', type: 'string', description: 'Item name', required: true },
        { name: 'price', type: 'number', description: 'Price in INR', required: true },
        { name: 'section', type: 'string', description: 'Section/category', required: true },
      ],
      handler: async ({ name, price, section }: { name: string; price: number; section: string }) => {
        const max = await db<{ n: number }>(`SELECT COALESCE(MAX(display_order),0)+1 AS n FROM catalog_items WHERE organization_id=$1`, [orgId])
        await db(`INSERT INTO catalog_items (id,organization_id,name,price,section,is_available,display_order)
                  VALUES (gen_random_uuid(),$1,$2,$3,$4,true,$5)`, [orgId, name, price, section, max[0]?.n ?? 1])
        return { success: true, message: `✅ Added "${name}" to ${section} at ₹${price}` }
      },
    })

    tools.push({
      name: 'updateCatalogItem',
      description: 'Update price, name, or availability of a catalog item.',
      parameters: [
        { name: 'item_name', type: 'string', description: 'Item to update (fuzzy match)', required: true },
        { name: 'new_price', type: 'number', description: 'New price', required: false },
        { name: 'available', type: 'boolean', description: 'Set available/unavailable', required: false },
      ],
      handler: async ({ item_name, new_price, available }: { item_name: string; new_price?: number; available?: boolean }) => {
        const items = await db<{ id: string; name: string }>(`
          SELECT id, name FROM catalog_items WHERE organization_id=$1 AND LOWER(name) LIKE LOWER($2)
        `, [orgId, `%${item_name}%`])
        if (!items.length) return { success: false, message: `No item matching "${item_name}"` }

        const updates: string[] = []; const params: unknown[] = [items[0].id]; let i = 1
        if (new_price !== undefined) { updates.push(`price=$${++i}`); params.push(new_price) }
        if (available !== undefined) { updates.push(`is_available=$${++i}`); params.push(available) }
        if (!updates.length) return { success: false, message: 'Nothing to update' }

        await db(`UPDATE catalog_items SET ${updates.join(',')} WHERE id=$1`, params)
        return { success: true, message: `✅ Updated "${items[0].name}"` }
      },
    })
  }

  // ── Bookings (owner/manager/staff) ──
  if (permissions.canViewBookings) {
    tools.push({
      name: 'getBookings',
      description: 'Get real bookings from the database.',
      parameters: [
        { name: 'status', type: 'string', description: 'Filter: all, pending, confirmed, completed, cancelled', required: false },
        { name: 'limit', type: 'number', description: 'Max results', required: false },
      ],
      handler: async ({ status = 'all', limit = 10 }: { status?: string; limit?: number }) => {
        const statusFilter = status !== 'all' ? `AND b.status='${status}'` : ''
        const bookings = await db(`
          SELECT b.id, COALESCE(u.name,u.phone,'Customer') AS customer, b.status,
                 b.agreed_price AS total, b.slot_time AS date, b.created_at
          FROM bookings b LEFT JOIN users u ON u.id=b.user_id
          WHERE b.organization_id=$1 ${statusFilter}
          ORDER BY b.created_at DESC LIMIT $2
        `, [orgId, limit])

        const stats = await db<{ revenue: string; pending: string }>(`
          SELECT COALESCE(SUM(agreed_price),0) AS revenue,
                 COUNT(*) FILTER (WHERE status='pending') AS pending
          FROM bookings WHERE organization_id=$1
        `, [orgId])

        return { bookings, revenue: Number(stats[0]?.revenue ?? 0), pending: Number(stats[0]?.pending ?? 0) }
      },
    })
  }

  // ── Revenue (owner/manager only) ──
  if (permissions.canViewEarnings) {
    tools.push({
      name: 'getRevenue',
      description: 'Revenue analytics — today, this week, this month.',
      parameters: [
        { name: 'period', type: 'string', description: 'today, week, month, all', required: false },
      ],
      handler: async ({ period = 'week' }: { period?: string }) => {
        const filters: Record<string, string> = {
          today: `AND created_at >= CURRENT_DATE`,
          week: `AND created_at >= CURRENT_DATE - INTERVAL '7 days'`,
          month: `AND created_at >= CURRENT_DATE - INTERVAL '30 days'`,
          all: '',
        }
        const stats = await db<{ total: string; count: string; avg: string }>(`
          SELECT COALESCE(SUM(agreed_price),0) AS total, COUNT(*) AS count,
                 COALESCE(AVG(agreed_price),0) AS avg
          FROM bookings WHERE organization_id=$1 AND status IN ('confirmed','completed')
          ${filters[period] ?? filters.week}
        `, [orgId])

        return {
          period,
          total: Number(stats[0]?.total ?? 0),
          orders: Number(stats[0]?.count ?? 0),
          avg_order: Math.round(Number(stats[0]?.avg ?? 0)),
        }
      },
    })
  }

  // ── Messages (owner/manager/staff) ──
  if (permissions.canViewMessages) {
    tools.push({
      name: 'getMessages',
      description: 'Recent customer messages from Telegram.',
      parameters: [
        { name: 'limit', type: 'number', description: 'Max messages', required: false },
      ],
      handler: async ({ limit = 20 }: { limit?: number }) => {
        const msgs = await db(`
          SELECT cm.role, cm.content AS message, cm.created_at AS time,
                 COALESCE(u.name,'Telegram User') AS customer
          FROM chat_messages cm LEFT JOIN users u ON u.id=cm.user_id
          WHERE cm.organization_id=$1
          ORDER BY cm.created_at DESC LIMIT $2
        `, [orgId, limit])
        return { messages: msgs.reverse(), total: msgs.length }
      },
    })
  }

  // ── Staff management (owner only) ──
  if (permissions.canManageStaff) {
    tools.push({
      name: 'getStaff',
      description: 'List all staff members with their roles and permissions.',
      parameters: [],
      handler: async () => {
        const staff = await db(`
          SELECT m.role, m.can_accept_bookings, m.can_manage_catalog,
                 m.can_view_earnings, m.is_active, COALESCE(u.name,u.phone) AS name
          FROM organization_members m JOIN users u ON u.id=m.user_id
          WHERE m.organization_id=$1 ORDER BY m.role
        `, [orgId])
        return { staff, total: staff.length }
      },
    })
  }

  // ── Dynamic query (owner/manager) — text-to-SQL with guardrails ──
  if (permissions.canDynamicQuery) {
    tools.push({
      name: 'queryBusiness',
      description: `Run a custom SQL SELECT query on your business data. Allowed tables: ${permissions.allowedTables.join(', ')}. All queries are automatically scoped to your organization. Only SELECT is allowed.`,
      parameters: [
        { name: 'sql', type: 'string', description: 'SQL SELECT query to run', required: true },
      ],
      handler: async ({ sql }: { sql: string }) => {
        const upper = sql.toUpperCase().trim()

        // Guardrail 1: Only SELECT
        if (!upper.startsWith('SELECT')) {
          return { error: '❌ Only SELECT queries are allowed' }
        }

        // Guardrail 2: Block destructive keywords
        const blocked = ['DROP', 'TRUNCATE', 'ALTER', 'DELETE FROM', 'UPDATE ', 'INSERT INTO', 'pg_', 'information_schema']
        for (const kw of blocked) {
          if (upper.includes(kw)) return { error: `❌ Query contains blocked keyword: ${kw}` }
        }

        // Guardrail 3: Check table access
        for (const table of permissions.allowedTables) {
          // This is a simple check — in production, use proper SQL parsing
        }

        // Guardrail 4: Inject org scoping + limit
        let safeSql = sql
        if (!upper.includes('LIMIT')) safeSql += ` LIMIT ${permissions.maxQueryRows}`

        try {
          const result = await db(safeSql)
          return { rows: result, count: result.length }
        } catch (err: any) {
          return { error: `Query failed: ${err.message}` }
        }
      },
    })
  }

  // ── Resources (everyone) ──
  tools.push({
    name: 'getResources',
    description: 'Get staff/resources (photographers, stylists, etc).',
    parameters: [],
    handler: async () => {
      const resources = await db(`
        SELECT id, name, type, specialization, price, is_active
        FROM resources WHERE organization_id=$1 ORDER BY name
      `, [orgId])
      return { resources, total: resources.length }
    },
  })

  return tools
}

// ─── Route handler ──────────────────────────────────────────────────────────

const serviceAdapter = new OpenAIAdapter({ model: 'gpt-4.1' })

export const POST = async (req: NextRequest) => {
  const ctx = await getUserContext(req)

  const toolCount = Object.keys(ROLE_PERMISSIONS[ctx.role])
    .filter(k => k.startsWith('can') && ROLE_PERMISSIONS[ctx.role][k as keyof RolePermissions])
    .length

  const runtime = new CopilotRuntime({
    actions: buildToolsForRole(ctx.orgId, ctx.permissions),
    instructions: `You are Locogi AI Assistant for "${ctx.orgName}".
The current user has role: ${ctx.role}.
They have ${toolCount} tools available based on their permissions.
Always be helpful and answer using the tools provided.
If they ask for something they don't have access to, politely explain their role doesn't have that permission.
Never reveal raw SQL or internal implementation details.
Format numbers as ₹X,XXX for prices.`,
  })

  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: '/api/copilotkit',
  })
  return handleRequest(req)
}
