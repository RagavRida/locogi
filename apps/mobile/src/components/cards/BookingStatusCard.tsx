/**
 * Just the status, for "is my booking confirmed?".
 *
 * A deliberately smaller answer than the full detail card: the user asked a
 * yes/no question, and burying the answer in a wall of detail makes them read
 * to find it.
 */

import React from 'react'
import { Text, StyleSheet, ActivityIndicator } from 'react-native'
import { CardShell, CardError, type ServerCardProps } from '../registry'
import { useBooking } from '../../hooks/useBooking'
import { StatusPill, formatWhen, CardButton } from './bookingBits'
import { colors, spacing } from '../../theme'

export default function BookingStatusCard({ data, onSelectBooking }: ServerCardProps) {
  const bookingId = typeof data.bookingId === 'string' ? data.bookingId : undefined
  const { booking, error, loading } = useBooking(bookingId)

  if (loading && !booking) {
    return (
      <CardShell>
        <ActivityIndicator color={colors.accent} />
      </CardShell>
    )
  }
  if (error || !booking) return <CardError message={error ?? 'Booking unavailable.'} />

  return (
    <CardShell testID="booking-status">
      <Text style={styles.title}>{booking.title}</Text>
      <StatusPill status={booking.status} />
      <Text style={styles.when}>{formatWhen(booking.slotTime)}</Text>
      {booking.vendorName ? <Text style={styles.vendor}>{booking.vendorName}</Text> : null}
      <CardButton label="View booking" onPress={() => onSelectBooking(booking.id)} />
    </CardShell>
  )
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: spacing.sm },
  when: { color: colors.text, fontSize: 14, marginTop: spacing.md },
  vendor: { color: colors.textSecondary, fontSize: 14, marginTop: 2, marginBottom: spacing.md },
})
