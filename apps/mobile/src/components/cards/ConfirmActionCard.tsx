/**
 * "Are you sure?" for a destructive action.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE BUTTONS SEND MESSAGES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tapping Confirm sends the word "yes" back through the normal chat endpoint
 * rather than calling a cancel API directly. That keeps ONE path to a
 * destructive action: the server armed a pending confirmation, and only the
 * server's `consumePending` — a conditional UPDATE that can fire once —
 * releases it.
 *
 * A button that called cancel directly would be a second path, unprotected by
 * the expiry window and by the single-use guarantee, and a double tap could
 * run it twice.
 *
 * The destructive button is NOT the visually dominant one. "Keep booking"
 * gets the primary treatment, because the safe choice should be the easy one.
 */

import React, { useState } from 'react'
import { Text, View, StyleSheet, ActivityIndicator } from 'react-native'
import { CardShell, type ServerCardProps } from '../registry'
import { useBooking } from '../../hooks/useBooking'
import { formatWhen, formatPrice, CardButton } from './bookingBits'
import { colors, spacing } from '../../theme'

export default function ConfirmActionCard({ data, onSend }: ServerCardProps) {
  const bookingId = typeof data.bookingId === 'string' ? data.bookingId : undefined
  const confirmLabel =
    typeof data.confirmLabel === 'string' ? data.confirmLabel : 'Confirm'
  const cancelLabel =
    typeof data.cancelLabel === 'string' ? data.cancelLabel : 'Keep booking'

  const { booking } = useBooking(bookingId)
  const [answered, setAnswered] = useState(false)

  function answer(text: string) {
    // Latch: the pending confirmation is single-use server-side, but a second
    // tap would still cost a round-trip and briefly show a contradictory
    // state.
    if (answered) return
    setAnswered(true)
    onSend(text)
  }

  return (
    <CardShell testID="confirm-action">
      {booking ? (
        <>
          <Text style={styles.title}>{booking.title}</Text>
          <Text style={styles.detail}>{formatWhen(booking.slotTime)}</Text>
          {booking.price !== null ? (
            <Text style={styles.detail}>{formatPrice(booking.price)}</Text>
          ) : null}
        </>
      ) : (
        <ActivityIndicator color={colors.accent} />
      )}

      <View style={styles.actions}>
        <CardButton
          label={cancelLabel}
          tone="primary"
          disabled={answered}
          onPress={() => answer('no')}
        />
        <CardButton
          label={confirmLabel}
          tone="danger"
          disabled={answered}
          onPress={() => answer('yes')}
        />
      </View>
    </CardShell>
  )
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  detail: { color: colors.textSecondary, fontSize: 14, marginTop: 2 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
})
