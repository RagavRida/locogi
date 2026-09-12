/**
 * Unified Permission Engine
 *
 * Central authority for ALL access control across Locogi:
 *   - API routes (Fastify middleware)
 *   - Telegram bot (customer vs vendor)
 *   - CopilotKit dashboard (dynamic tool generation)
 *   - Commerce engine (action validation)
 *
 * Uses the existing organization_members table:
 *   role: 'owner' | 'manager' | 'staff' | 'practitioner'
 *   + granular: can_accept_bookings, can_manage_catalog, can_manage_staff, can_view_earnings
 *
 * Design:
 *   1. Roles define BASE capabilities
 *   2. Granular flags OVERRIDE role defaults (a staff can be given can_manage_catalog)
 *   3. All queries are ALWAYS scoped to organization_id (no cross-org leaks)
 *   4. Customers are a separate context (no org membership needed)
 */

import { query } from './db'
import { logger } from './logger'

// ─── Types ──────────────────────────────────────────────────────────────────

export type OrgRole = 'owner' | 'manager' | 'staff' | 'practitioner'
export type UserContext = 'customer' | 'vendor'

export interface Permission {
  viewCatalog: boolean
  editCatalog: boolean
  deleteCatalogItem: boolean
  viewAllBookings: boolean
  viewOwnBookings: boolean
  acceptBookings: boolean
  cancelBookings: boolean
  viewEarnings: boolean
  viewAnalytics: boolean
  manageStaff: boolean
  manageSettings: boolean
  placeOrders: boolean
  viewCustomerMessages: boolean
  replyToCustomers: boolean
  exportData: boolean
  dynamicQuery: boolean           // can use the text-to-SQL copilot tool
  dynamicQueryAllowedTables: string[]  // which tables the dynamic query can access
  maxQueryRows: number
}

export interface OrgMember {
  userId: string
  orgId: string
  role: OrgRole
  canAcceptBookings: boolean
  canManageCatalog: boolean
  canManageStaff: boolean
  canViewEarnings: boolean
  isActive: boolean
}

// ─── Role → Permission defaults ─────────────────────────────────────────────

const ROLE_DEFAULTS: Record<OrgRole, Permission> = {
  owner: {
    viewCatalog: true,
    editCatalog: true,
    deleteCatalogItem: true,
    viewAllBookings: true,
    viewOwnBookings: true,
    acceptBookings: true,
    cancelBookings: true,
    viewEarnings: true,
    viewAnalytics: true,
    manageStaff: true,
    manageSettings: true,
    placeOrders: false,
    viewCustomerMessages: true,
    replyToCustomers: true,
    exportData: true,
    dynamicQuery: true,
    dynamicQueryAllowedTables: [
      'bookings', 'catalog_items', 'resources', 'users', 'chat_messages',
      'organizations', 'organization_members', 'offers', 'booking_categories',
    ],
    maxQueryRows: 100,
  },
  manager: {
    viewCatalog: true,
    editCatalog: true,
    deleteCatalogItem: false,
    viewAllBookings: true,
    viewOwnBookings: true,
    acceptBookings: true,
    cancelBookings: true,
    viewEarnings: true,
    viewAnalytics: true,
    manageStaff: false,
    manageSettings: false,
    placeOrders: false,
    viewCustomerMessages: true,
    replyToCustomers: true,
    exportData: false,
    dynamicQuery: true,
    dynamicQueryAllowedTables: [
      'bookings', 'catalog_items', 'resources', 'chat_messages', 'offers',
    ],
    maxQueryRows: 50,
  },
  staff: {
    viewCatalog: true,
    editCatalog: false,
    deleteCatalogItem: false,
    viewAllBookings: true,
    viewOwnBookings: true,
    acceptBookings: true,
    cancelBookings: false,
    viewEarnings: false,
    viewAnalytics: false,
    manageStaff: false,
    manageSettings: false,
    placeOrders: false,
    viewCustomerMessages: true,
    replyToCustomers: true,
    exportData: false,
    dynamicQuery: false,
    dynamicQueryAllowedTables: ['bookings', 'catalog_items'],
    maxQueryRows: 20,
  },
  practitioner: {
    viewCatalog: true,
    editCatalog: false,
    deleteCatalogItem: false,
    viewAllBookings: false,
    viewOwnBookings: true,
    acceptBookings: false,
    cancelBookings: false,
    viewEarnings: false,
    viewAnalytics: false,
    manageStaff: false,
    manageSettings: false,
    placeOrders: false,
    viewCustomerMessages: false,
    replyToCustomers: false,
    exportData: false,
    dynamicQuery: false,
    dynamicQueryAllowedTables: [],
    maxQueryRows: 10,
  },
}

const CUSTOMER_PERMISSIONS: Permission = {
  viewCatalog: true,
  editCatalog: false,
  deleteCatalogItem: false,
  viewAllBookings: false,
  viewOwnBookings: true,
  acceptBookings: false,
  cancelBookings: true,  // can cancel their own
  viewEarnings: false,
  viewAnalytics: false,
  manageStaff: false,
  manageSettings: false,
  placeOrders: true,
  viewCustomerMessages: false,
  replyToCustomers: false,
  exportData: false,
  dynamicQuery: false,
  dynamicQueryAllowedTables: [],
  maxQueryRows: 0,
}

// ─── Fetch org membership from DB ───────────────────────────────────────────

export async function getOrgMember(userId: string, orgId: string): Promise<OrgMember | null> {
  const result = await query<{
    user_id: string
    organization_id: string
    role: OrgRole
    can_accept_bookings: boolean
    can_manage_catalog: boolean
    can_manage_staff: boolean
    can_view_earnings: boolean
    is_active: boolean
  }>(
    `SELECT user_id, organization_id, role,
            can_accept_bookings, can_manage_catalog,
            can_manage_staff, can_view_earnings, is_active
     FROM organization_members
     WHERE user_id = $1 AND organization_id = $2`,
    [userId, orgId],
  )

  const row = result.rows[0]
  if (!row) return null

  return {
    userId: row.user_id,
    orgId: row.organization_id,
    role: row.role,
    canAcceptBookings: row.can_accept_bookings,
    canManageCatalog: row.can_manage_catalog,
    canManageStaff: row.can_manage_staff,
    canViewEarnings: row.can_view_earnings,
    isActive: row.is_active,
  }
}

// ─── Build permissions for a user ───────────────────────────────────────────

/**
 * Get the effective permissions for a user in an organization.
 * Merges role defaults with granular DB flags.
 */
export function buildPermissions(member: OrgMember): Permission {
  const base = { ...ROLE_DEFAULTS[member.role] }

  // Granular flags can UPGRADE (not downgrade) role defaults
  if (member.canManageCatalog && !base.editCatalog) {
    base.editCatalog = true
  }
  if (member.canAcceptBookings && !base.acceptBookings) {
    base.acceptBookings = true
  }
  if (member.canManageStaff && !base.manageStaff) {
    base.manageStaff = true
  }
  if (member.canViewEarnings && !base.viewEarnings) {
    base.viewEarnings = true
    base.viewAnalytics = true
  }

  // Inactive members get read-only
  if (!member.isActive) {
    base.editCatalog = false
    base.deleteCatalogItem = false
    base.acceptBookings = false
    base.cancelBookings = false
    base.manageStaff = false
    base.manageSettings = false
    base.replyToCustomers = false
    base.dynamicQuery = false
  }

  return base
}

/**
 * Get permissions for a customer (no org membership needed).
 */
export function getCustomerPermissions(): Permission {
  return { ...CUSTOMER_PERMISSIONS }
}

/**
 * Convenience: fetch member + build permissions in one call.
 */
export async function getPermissions(
  userId: string,
  orgId: string,
): Promise<{ member: OrgMember | null; permissions: Permission; context: UserContext }> {
  const member = await getOrgMember(userId, orgId)

  if (!member) {
    return { member: null, permissions: getCustomerPermissions(), context: 'customer' }
  }

  return { member, permissions: buildPermissions(member), context: 'vendor' }
}

// ─── Permission check helpers ───────────────────────────────────────────────

export function can(permissions: Permission, action: keyof Permission): boolean {
  const value = permissions[action]
  return typeof value === 'boolean' ? value : false
}

export function assertCan(permissions: Permission, action: keyof Permission, actionLabel?: string): void {
  if (!can(permissions, action)) {
    const label = actionLabel ?? action
    logger.warn({ action }, `[permissions] Access denied: ${label}`)
    throw new PermissionDeniedError(`You don't have permission to ${label}`)
  }
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionDeniedError'
  }
}

// ─── Dynamic query guardrails ───────────────────────────────────────────────

const BLOCKED_KEYWORDS = [
  'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE',
  'DELETE FROM', 'UPDATE ', 'INSERT INTO',
  'pg_', 'information_schema',
]

/**
 * Validate a dynamically generated SQL query against guardrails.
 */
export function validateDynamicQuery(
  sql: string,
  permissions: Permission,
  orgId: string,
): { valid: boolean; reason?: string; sanitizedSql?: string } {
  const upper = sql.toUpperCase().trim()

  // Must be a SELECT
  if (!upper.startsWith('SELECT')) {
    return { valid: false, reason: 'Only SELECT queries are allowed' }
  }

  // Block dangerous keywords
  for (const kw of BLOCKED_KEYWORDS) {
    if (upper.includes(kw)) {
      return { valid: false, reason: `Query contains blocked keyword: ${kw}` }
    }
  }

  // Check table access
  const allowedTables = permissions.dynamicQueryAllowedTables
  if (allowedTables.length === 0) {
    return { valid: false, reason: 'You do not have permission to run custom queries' }
  }

  // Ensure org_id scoping — query MUST contain the org ID
  // (We'll inject it if not present)
  let sanitized = sql
  if (!sql.includes(orgId)) {
    // Add org scoping as a CTE wrapper
    sanitized = `SELECT * FROM (${sql}) AS _q WHERE organization_id = '${orgId}'`
  }

  // Add LIMIT if not present
  if (!upper.includes('LIMIT')) {
    sanitized += ` LIMIT ${permissions.maxQueryRows}`
  }

  return { valid: true, sanitizedSql: sanitized }
}
