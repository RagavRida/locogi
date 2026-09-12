/**
 * Presentation helpers shared by the booking cards.
 *
 * Extracted because status colouring and date formatting appearing five times
 * with small differences is how a UI starts contradicting itself — one card
 * calling a booking "Confirmed" while another beside it says "CONFIRMED" in a
 * different colour.
 */

import React from 'react'
import { Text, View, StyleSheet, Pressable } from 'react-native'
import { colors, radius, spacing } from '../../theme'

/** Human wording for a request status, in the user's language not the schema's. */
export function statusLabel(status: string): string {
  return (
    {
      open: 'Finding a provider',
      negotiating: 'Getting quotes',
      waitlisted: 'On the waitlist',
      confirmed: 'Confirmed',
      in_progress: 'In progress',
      completed: 'Completed',
      cancelled: 'Cancelled',
      expired: 'Expired',
      no_match: 'No provider found',
      disrupted: 'Provider cancelled',
      no_show_customer: 'Marked no-show',
      no_show_vendor: 'Provider no-show',
      rescheduled: 'Rescheduled',
    }[status] ?? status.replace(/_/g, ' ')
  )
}

export function statusColor(status: string): string {
  if (status === 'confirmed' || status === 'in_progress' || status === 'completed') {
    return colors.success
  }
  if (status === 'open' || status === 'negotiating' || status === 'waitlisted') {
    return colors.warning
  }
  return colors.danger
}

export function StatusPill({ status }: { status: string }) {
  const color = statusColor(status)
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]}>{statusLabel(status)}</Text>
    </View>
  )
}

/**
 * "Today · 6:00 PM", "Sat 22 Aug · 5:00 PM".
 *
 * Relative wording only for today and tomorrow. Beyond that "in 3 days" makes
 * people count on their fingers, so the actual date is kinder.
 */
export function formatWhen(iso: string | null): string {
  if (!iso) return 'Time not set'

  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Time not set'

  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)

  const time = d.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  if (sameDay(d, now)) return `Today · ${time}`
  if (sameDay(d, tomorrow)) return `Tomorrow · ${time}`

  const date = d.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
  return `${date} · ${time}`
}

export function formatPrice(paise: number | null): string | null {
  if (paise === null) return null
  return `₹${paise.toLocaleString('en-IN')}`
}

export function CardButton({
  label,
  onPress,
  tone = 'default',
  disabled,
}: {
  label: string
  onPress: () => void
  tone?: 'default' | 'primary' | 'danger'
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.button,
        tone === 'primary' && styles.buttonPrimary,
        tone === 'danger' && styles.buttonDanger,
        (pressed || disabled) && styles.buttonPressed,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          tone === 'primary' && styles.buttonTextPrimary,
          tone === 'danger' && styles.buttonTextDanger,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    gap: 6,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3 },

  button: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    minHeight: 40,
    justifyContent: 'center',
  },
  buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  buttonDanger: { borderColor: colors.danger },
  buttonPressed: { opacity: 0.6 },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  buttonTextPrimary: { color: colors.bg },
  buttonTextDanger: { color: colors.danger },
})
