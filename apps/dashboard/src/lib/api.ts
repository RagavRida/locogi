/**
 * API client for the Locogi platform API.
 * Used by the dashboard to communicate with the backend.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

interface FetchOptions extends RequestInit {
  token?: string
  apiKey?: string
}

export async function api<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { token, apiKey, ...fetchOptions } = options

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((fetchOptions.headers as Record<string, string>) ?? {}),
  }

  if (token) headers['Authorization'] = `Bearer ${token}`
  if (apiKey) headers['X-API-Key'] = apiKey

  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...fetchOptions,
    headers,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `API error: ${res.status}`)
  }

  return res.json()
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('locogi_token')
}

export function setToken(token: string) {
  localStorage.setItem('locogi_token', token)
}

export function clearToken() {
  localStorage.removeItem('locogi_token')
}

export function getOrgId(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('locogi_org_id')
}

export function setOrgId(orgId: string) {
  localStorage.setItem('locogi_org_id', orgId)
}

// ─── Typed API calls ────────────────────────────────────────────────────────

export async function fetchBookings(token: string, orgId: string, status?: string) {
  const params = new URLSearchParams({ organizationId: orgId })
  if (status) params.set('status', status)
  return api<{ bookings: any[] }>(`/platform/bookings?${params}`, {
    token,
    headers: { 'X-API-Key': '' }, // Will use JWT auth via org membership
  })
}

export async function fetchCatalog(orgId: string) {
  return api<{ items: any[] }>(`/widget/catalog/${orgId}`)
}

export async function fetchResources(orgId: string) {
  return api<{ resources: any[] }>(`/widget/resources/${orgId}`)
}
