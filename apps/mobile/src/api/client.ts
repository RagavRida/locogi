import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'

const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string) ?? 'http://localhost:3000'

/**
 * Every call goes through /api/v1.
 *
 * Applied here rather than written into each of the ~40 endpoint definitions
 * below: one place to change, and no chance of a single endpoint being left
 * on the unversioned mount by accident.
 *
 * The server still serves the bare paths, so a build shipped before this
 * change keeps working. That is what makes rolling this out safe — but it is
 * also why the server logs every unversioned hit: the compatibility mount can
 * only be retired once those logs go quiet.
 */
const API_PREFIX = '/api/v1'

async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync('access_token')
  } catch {
    return null
  }
}

export async function setToken(token: string) {
  await SecureStore.setItemAsync('access_token', token)
}

export async function clearToken() {
  await SecureStore.deleteItemAsync('access_token')
}

class ApiError extends Error {
  status: number
  /**
   * The server's correlation id for the failed call.
   *
   * Surfaced so a user reporting a problem can quote one string that finds
   * the entire server-side trace — instead of support asking for a
   * screenshot and guessing at timestamps.
   */
  correlationId: string | null
  constructor(message: string, status: number, correlationId: string | null = null) {
    super(message)
    this.status = status
    this.correlationId = correlationId
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getToken()
  // Absolute paths (health checks, anything intentionally unversioned) opt
  // out by starting with a marker the caller controls.
  const url = path.startsWith('/healthz')
    ? `${API_URL}${path}`
    : `${API_URL}${API_PREFIX}${path}`

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })

  if (!res.ok) {
    let msg = `Request failed (${res.status})`
    try {
      const body = await res.json()
      msg = body.message ?? body.error ?? msg
    } catch {
      /* ignore */
    }
    // Read from the response headers: the server echoes it on every reply,
    // so an error can always be traced even when the body is unhelpful.
    throw new ApiError(msg, res.status, res.headers.get('x-correlation-id'))
  }

  if (res.status === 204) return {} as T
  return res.json()
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Vendor {
  id: string
  categoryTags: string[]
  rating: number
  completedJobs: number
  attributes: Record<string, unknown>
  serviceAreaDescription?: string
}

export interface Quote {
  responseId: string
  vendorId: string
  vendorName: string
  vendorRating: number
  vendorJobs: number
  quotedPrice: number
  message?: string
}

export interface Slot {
  id: string
  slotTime: string
  capacityBooked: number
  capacityTotal: number
  isCancelled: boolean
}

export type Intent =
  | 'service_request'
  | 'place_discovery'
  | 'social_community'
  | 'information'
  | 'unsupported'

export interface PlaceResult {
  id: string
  name: string
  placeType: string
  area: string | null
  address: string | null
  notes: string | null
  distanceKm?: number
}

export interface ExtractionResult {
  /** Which intent the gate classified this as. */
  intent: Intent
  /** True when the agent answered outside the service pipeline. */
  handled: boolean
  /** Present when handled — what the agent should say. */
  agentMessage?: string | null
  /** Present for place_discovery intent. */
  places?: PlaceResult[]

  // Null when handled === true
  categoryTags: string[] | null
  attributes: Record<string, unknown> | null
  attributeSchema: Record<string, 'text' | 'number' | 'date' | 'currency' | 'list'> | null
  bookingTypeSuggestion?: 'quote' | 'appointment' | 'hiring' | 'order'
  ambiguityFlag?: boolean
  ambiguityNote?: string | null
  followUpQuestions?: string[]
}

export interface JobStatus {
  status: string
  bookingType: string
  confirmedVendor?: Vendor
  agreedPrice?: number
  stages: { label: string; completedAt: string | null }[]
}

// ─── API ──────────────────────────────────────────────────────────────────────
/** What a booking card renders. Fetched live; never read from chat history. */
export interface BookingView {
  id: string
  title: string
  status: string
  bookingType: string
  price: number | null
  slotTime: string | null
  vendorId: string | null
  vendorName: string | null
  vendorRating: number | null
  categories: string[]
  canCancel: boolean
  canTrack: boolean
}

export const api = {
  // Auth
  sendOtp: (phone: string) =>
    request<{ success: boolean }>('/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),

  verifyOtp: (phone: string, otp: string) =>
    request<{ accessToken: string; refreshToken: string; userId: string }>(
      '/auth/verify-otp',
      { method: 'POST', body: JSON.stringify({ phone, otp }) }
    ),

  setRole: (isVendor: boolean, isCustomer: boolean) =>
    request<{ success: boolean }>('/users/role', {
      method: 'PATCH',
      body: JSON.stringify({ isVendor, isCustomer }),
    }),

  // ── Conversational booking retrieval ──────────────────────────────────────
  //
  // Try this BEFORE extractRequest. `handled: false` means the message was not
  // about an existing booking, and the original extract flow should run — that
  // is what keeps this feature additive rather than a replacement.
  chat: (text: string) =>
    request<{
      handled: boolean
      message?: string
      ui?: { type: string; data: Record<string, unknown> }
      intent?: string
    }>('/chat', { method: 'POST', body: JSON.stringify({ text }) }),

  chatSelect: (bookingId: string, forIntent?: string) =>
    request<{
      handled: boolean
      message: string
      ui: { type: string; data: Record<string, unknown> }
    }>('/chat/select', {
      method: 'POST',
      body: JSON.stringify({ bookingId, forIntent }),
    }),

  chatHistory: (limit = 50) =>
    request<{
      messages: Array<{
        id: string
        role: 'user' | 'agent'
        text: string | null
        ui?: { type: string; data: Record<string, unknown> }
        timestamp: string
      }>
    }>(`/chat/history?limit=${limit}`),

  // Booking reads used by the rendered cards. Each card fetches its own
  // current state rather than trusting whatever was serialised into history.
  getBooking: (id: string) =>
    request<BookingView>(`/bookings/${id}`),

  getBookings: () => request<{ bookings: BookingView[] }>('/bookings'),

  getBookingTracking: (id: string) =>
    request<{
      available: boolean
      why?: string
      lat?: number
      lng?: number
      etaMinutes?: number
      distanceKm?: number
      vendorName?: string | null
    }>(`/bookings/${id}/tracking`),

  /** Provider reports their journey phase. Pushes to the customer's socket. */
  setBookingPhase: (
    id: string,
    phase: string,
    coords?: { lat: number; lng: number }
  ) =>
    request<{ success: boolean; phase: string }>(`/bookings/${id}/phase`, {
      method: 'POST',
      body: JSON.stringify({ phase, ...coords }),
    }),

  cancelBookingById: (id: string) =>
    request<{ success: boolean; message: string }>(`/bookings/${id}/cancel`, {
      method: 'POST',
    }),

  // Extraction (runs through the intent gate first)
  extractRequest: (text: string, coords?: { lat?: number; lng?: number }) =>
    request<ExtractionResult>('/requests/extract', {
      method: 'POST',
      body: JSON.stringify({ rawDescription: text, ...coords }),
    }),

  extractVendor: (text: string) =>
    request<ExtractionResult>('/vendors/extract', {
      method: 'POST',
      body: JSON.stringify({ rawDescription: text }),
    }),

  // Requests
  createRequest: (payload: {
    rawDescription: string
    categoryTags: string[]
    attributes: Record<string, unknown>
    bookingType: string
    idempotencyKey: string
    lat?: number
    lng?: number
  }) =>
    request<{ id: string; matchedCount: number }>('/requests', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getRequest: (id: string) => request<JobStatus>(`/requests/${id}`),

  getQuotes: (requestId: string) =>
    request<{ quotes: Quote[] }>(`/requests/${requestId}/quotes`),

  acceptQuote: (requestId: string, responseId: string, price: number) =>
    request<{ success: boolean }>(`/requests/${requestId}/quote/accept`, {
      method: 'POST',
      body: JSON.stringify({ responseId, agreedPrice: price, idempotencyKey: `q_${responseId}` }),
    }),

  counterQuote: (requestId: string, responseId: string, price: number) =>
    request<{ success: boolean }>(`/requests/${requestId}/quote/counter`, {
      method: 'POST',
      body: JSON.stringify({ responseId, counterPrice: price }),
    }),

  advanceStage: (requestId: string, stage: 'in_progress' | 'completed') =>
    request<{ success: boolean }>(`/requests/${requestId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ stage }),
    }),

  // Slots
  getSlots: (vendorId: string, date: string) =>
    request<{ slots: Slot[] }>(`/vendors/${vendorId}/slots?date=${date}`),

  bookSlot: (requestId: string, slotId: string) =>
    request<{ success: boolean; slot?: Slot }>(`/requests/${requestId}/book-slot`, {
      method: 'POST',
      body: JSON.stringify({ slotId, idempotencyKey: `s_${slotId}` }),
    }),

  // Reviews
  submitReview: (requestId: string, rating: number, comment: string) =>
    request<{ success: boolean }>('/reviews', {
      method: 'POST',
      body: JSON.stringify({ requestId, rating, comment }),
    }),

  // Vendor
  createVendor: (payload: {
    rawDescription: string
    categoryTags: string[]
    attributes: Record<string, unknown>
    attributeSchema: Record<string, string>
    serviceAreaDescription?: string
    serviceRadiusKm?: number
    lat?: number
    lng?: number
  }) =>
    request<{
      id: string
      categories: Array<{
        id: string
        name: string
        slug: string
        isPrimary: boolean
        matchedVia: string
      }>
      suggestedBookingType: string | null
      kycRequired: boolean
      isLive: boolean
      missingFields: Array<{ fieldName: string; fieldType: string; question: string }>
      message: string
    }>('/vendors', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getVendorInbox: () =>
    request<{ requests: Array<{ id: string; rawDescription: string; bookingType: string; createdAt: string }> }>(
      '/vendors/inbox'
    ),

  sendQuote: (requestId: string, price: number, message?: string) =>
    request<{ success: boolean }>(`/requests/${requestId}/quote`, {
      method: 'POST',
      body: JSON.stringify({ quotedPrice: price, message }),
    }),

  // Categories / taxonomy
  resolveCategories: (tags: string[]) =>
    request<{
      resolved: Array<{
        categoryId: string
        name: string
        slug: string
        bookingType: string | null
        requiresKyc: boolean
        requiresGenderPreference: boolean
        matchedVia: 'exact_alias' | 'alias_similarity' | 'category_similarity' | 'created'
        confidence: number
        yourTag: string
      }>
    }>('/categories/resolve', {
      method: 'POST',
      body: JSON.stringify({ tags }),
    }),

  getCategories: () =>
    request<{
      categories: Array<{
        id: string
        slug: string
        name: string
        description: string | null
        bookingType: string | null
        requiresKyc: boolean
        vendorCount: number
        avgPrice: number | null
      }>
    }>('/categories'),

  getCategoryFields: (categoryId: string) =>
    request<{
      fields: Array<{
        fieldName: string
        fieldType: string
        fieldLabel: string
        promptQuestion: string
        isRequired: boolean
      }>
    }>(`/categories/${categoryId}/fields`),

  // History
  getHistory: () =>
    request<{ requests: Array<{ id: string; rawDescription: string; status: string; createdAt: string; vendorName?: string; rating?: number }> }>(
      '/requests/history'
    ),
}

export { ApiError }
