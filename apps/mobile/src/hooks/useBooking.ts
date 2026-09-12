/**
 * Live booking data for a card.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY CARDS FETCH INSTEAD OF READING THEIR MESSAGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A card in chat history was rendered at some point in the past. If it drew
 * from the data serialised alongside it, scrolling up would show a booking as
 * CONFIRMED that was cancelled an hour ago, with a price that has since
 * changed — presented with exactly the same confidence as the live one at the
 * bottom of the thread.
 *
 * So the message carries an id and the card fetches. The cost is a request per
 * card on replay; the benefit is that nothing in the conversation can lie.
 *
 * A tiny module-level cache keeps a burst of cards for the same booking from
 * issuing duplicate requests within the same render pass, and is invalidated
 * whenever anything mutates a booking.
 */

import { useCallback, useEffect, useState } from 'react'
import { api, type BookingView } from '../api/client'

const cache = new Map<string, { value: BookingView; at: number }>()
const TTL_MS = 15_000

/** Called after any mutation so stale reads cannot survive it. */
export function invalidateBookings(): void {
  cache.clear()
}

export function useBooking(bookingId: string | undefined) {
  const [booking, setBooking] = useState<BookingView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (force = false) => {
      if (!bookingId) return

      const hit = cache.get(bookingId)
      if (!force && hit && Date.now() - hit.at < TTL_MS) {
        setBooking(hit.value)
        return
      }

      setLoading(true)
      setError(null)
      try {
        const value = await api.getBooking(bookingId)
        cache.set(bookingId, { value, at: Date.now() })
        setBooking(value)
      } catch {
        // A 404 here is the ordinary answer for a booking that was deleted or
        // never belonged to this user. Cards show a quiet line, not a crash.
        setError('This booking is no longer available.')
      } finally {
        setLoading(false)
      }
    },
    [bookingId]
  )

  useEffect(() => {
    void load()
  }, [load])

  return { booking, error, loading, reload: () => load(true) }
}

export function useBookings(ids: string[] | undefined) {
  const [bookings, setBookings] = useState<BookingView[]>([])
  const [loading, setLoading] = useState(true)

  const key = (ids ?? []).join(',')

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        // One list call, then filter — cheaper and more consistent than N
        // parallel gets, and it reflects a single point in time.
        const { bookings: all } = await api.getBookings()
        if (!alive) return
        const wanted = ids && ids.length > 0 ? all.filter((b) => ids.includes(b.id)) : all
        setBookings(wanted)
      } catch {
        if (alive) setBookings([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [key])

  return { bookings, loading }
}
