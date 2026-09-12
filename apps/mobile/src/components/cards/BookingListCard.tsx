/**
 * Every booking, tappable.
 *
 * Renders inline in the conversation rather than pushing to a separate screen:
 * the whole product premise is that the chat IS the app, and bouncing the user
 * to a list view would contradict it.
 */

import React from 'react'
import { Text, View, StyleSheet, Pressable, ActivityIndicator } from 'react-native'
import { CardShell, type ServerCardProps } from '../registry'
import { useBookings } from '../../hooks/useBooking'
import { StatusPill, formatWhen, formatPrice } from './bookingBits'
import { colors, spacing } from '../../theme'

export default function BookingListCard({ data, onSelectBooking }: ServerCardProps) {
  const ids = Array.isArray(data.bookingIds) ? (data.bookingIds as string[]) : undefined
  const { bookings, loading } = useBookings(ids)

  if (loading) {
    return (
      <CardShell>
        <ActivityIndicator color={colors.accent} />
      </CardShell>
    )
  }

  if (bookings.length === 0) {
    return (
      <CardShell>
        <Text style={styles.empty}>No bookings to show.</Text>
      </CardShell>
    )
  }

  return (
    <CardShell testID="booking-list">
      <Text style={styles.heading}>Your bookings</Text>

      {bookings.map((b, i) => (
        <Pressable
          key={b.id}
          onPress={() => onSelectBooking(b.id)}
          accessibilityRole="button"
          accessibilityLabel={`${b.title}, ${formatWhen(b.slotTime)}`}
          style={({ pressed }) => [
            styles.row,
            i > 0 && styles.rowDivider,
            pressed && styles.rowPressed,
          ]}
        >
          <Text style={styles.when}>{formatWhen(b.slotTime)}</Text>
          <Text style={styles.title}>{b.title}</Text>
          {b.price !== null ? <Text style={styles.price}>{formatPrice(b.price)}</Text> : null}
          <View style={styles.pill}>
            <StatusPill status={b.status} />
          </View>
        </Pressable>
      ))}
    </CardShell>
  )
}

const styles = StyleSheet.create({
  heading: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  row: { paddingVertical: spacing.md },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  rowPressed: { opacity: 0.6 },
  when: { color: colors.textSecondary, fontSize: 12 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600', marginTop: 2 },
  price: { color: colors.text, fontSize: 14, marginTop: 2 },
  pill: { marginTop: spacing.sm },
  empty: { color: colors.textSecondary, fontSize: 14 },
})
