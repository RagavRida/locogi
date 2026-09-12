/**
 * One booking in full, with the actions the server says are available.
 *
 * `canCancel` and `canTrack` come from the API rather than being computed
 * here. The cancellation window and the "is a vendor actually assigned" rule
 * are server policy, and a client that re-derives them will eventually offer a
 * button the server then refuses — which reads as a broken app rather than a
 * closed window.
 */

import React from 'react'
import { Text, View, StyleSheet, ActivityIndicator } from 'react-native'
import { CardShell, CardError, type ServerCardProps } from '../registry'
import { useBooking, invalidateBookings } from '../../hooks/useBooking'
import { StatusPill, formatWhen, formatPrice, CardButton } from './bookingBits'
import { colors, spacing } from '../../theme'
import { api } from '../../api/client'
import { useRealtimeTopic } from '../../hooks/useRealtime'

export default function BookingDetailCard({ data, onSend, onChanged }: ServerCardProps) {
  const bookingId = typeof data.bookingId === 'string' ? data.bookingId : undefined
  const { booking, error, loading, reload } = useBooking(bookingId)

  // A booking confirmed, cancelled or disrupted elsewhere — by the vendor, by
  // a worker, or on the user's other device — updates this card in place.
  useRealtimeTopic(bookingId ? { kind: 'booking', id: bookingId } : null, () => {
    invalidateBookings()
    void reload()
  })

  if (loading && !booking) {
    return (
      <CardShell>
        <ActivityIndicator color={colors.accent} />
      </CardShell>
    )
  }
  if (error || !booking) return <CardError message={error ?? 'Booking unavailable.'} />

  const price = formatPrice(booking.price)

  async function cancel() {
    if (!bookingId) return
    try {
      await api.cancelBookingById(bookingId)
    } finally {
      // Refresh either way: on success the status changed, and on failure the
      // reason is usually that it already had.
      invalidateBookings()
      await reload()
      onChanged()
    }
  }

  return (
    <CardShell testID="booking-detail">
      <Text style={styles.title}>{booking.title}</Text>

      {booking.vendorName ? (
        <View style={styles.vendorRow}>
          <Text style={styles.vendor}>{booking.vendorName}</Text>
          {booking.vendorRating !== null ? (
            <Text style={styles.rating}>★ {booking.vendorRating.toFixed(1)}</Text>
          ) : null}
        </View>
      ) : null}

      <Text style={styles.when}>{formatWhen(booking.slotTime)}</Text>
      {price ? <Text style={styles.price}>{price}</Text> : null}

      <View style={styles.pillRow}>
        <StatusPill status={booking.status} />
      </View>

      <View style={styles.actions}>
        {booking.canTrack ? (
          <CardButton label="Track" onPress={() => onSend('where is my provider?')} />
        ) : null}
        {booking.vendorId ? (
          <CardButton label="Message" onPress={() => onSend('message my provider')} />
        ) : null}
        {booking.canCancel ? (
          <CardButton label="Cancel" tone="danger" onPress={cancel} />
        ) : null}
      </View>
    </CardShell>
  )
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  vendorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 4 },
  vendor: { color: colors.textSecondary, fontSize: 15 },
  rating: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  when: { color: colors.text, fontSize: 15, marginTop: spacing.md },
  price: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 4 },
  pillRow: { marginTop: spacing.md },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
})
