/**
 * "Which one did you mean?"
 *
 * Rendered when resolution came back AMBIGUOUS. Tapping resolves it without
 * the user typing anything — which is the whole point: having asked a
 * question, making them phrase an answer is worse than not asking.
 *
 * The card sends only the id. The server re-checks that it belongs to the
 * caller, so a tampered client gains nothing by posting a different one.
 */

import React from 'react'
import { Text, View, StyleSheet, Pressable, ActivityIndicator } from 'react-native'
import { CardShell, type ServerCardProps } from '../registry'
import { useBookings } from '../../hooks/useBooking'
import { formatWhen } from './bookingBits'
import { colors, radius, spacing } from '../../theme'

export default function BookingSelectorCard({ data, onSelectBooking }: ServerCardProps) {
  const ids = Array.isArray(data.bookingIds) ? (data.bookingIds as string[]) : []
  const forIntent = typeof data.forIntent === 'string' ? data.forIntent : undefined
  const { bookings, loading } = useBookings(ids)

  if (loading) {
    return (
      <CardShell>
        <ActivityIndicator color={colors.accent} />
      </CardShell>
    )
  }

  return (
    <CardShell testID="booking-selector">
      <Text style={styles.prompt}>
        You have {bookings.length} bookings. Which one do you mean?
      </Text>

      <View style={styles.options}>
        {bookings.map((b) => (
          <Pressable
            key={b.id}
            onPress={() => onSelectBooking(b.id, forIntent)}
            accessibilityRole="button"
            accessibilityLabel={`${b.title}, ${formatWhen(b.slotTime)}`}
            style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
          >
            <Text style={styles.optionTitle}>{b.title}</Text>
            <Text style={styles.optionWhen}>{formatWhen(b.slotTime)}</Text>
          </Pressable>
        ))}
      </View>
    </CardShell>
  )
}

const styles = StyleSheet.create({
  prompt: { color: colors.text, fontSize: 15, marginBottom: spacing.md },
  options: { gap: spacing.sm },
  option: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    // Comfortably above the 44pt minimum touch target.
    minHeight: 56,
    justifyContent: 'center',
  },
  optionPressed: { backgroundColor: colors.surfaceHover, opacity: 0.8 },
  optionTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  optionWhen: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
})
