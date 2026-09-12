/**
 * Nothing to show, plus a way forward.
 *
 * An empty state that only says "no bookings" is a dead end in a chat app —
 * the user has to think of what to say next. Offering the obvious action turns
 * it into a step.
 */

import React from 'react'
import { Text, View, StyleSheet } from 'react-native'
import { CardShell, type ServerCardProps } from '../registry'
import { CardButton } from './bookingBits'
import { colors, spacing } from '../../theme'

export default function EmptyStateCard({ data, onSend }: ServerCardProps) {
  const action = typeof data.action === 'string' ? data.action : 'find_service'

  return (
    <CardShell testID="empty-state">
      <Text style={styles.text}>No upcoming bookings.</Text>
      <View style={styles.actions}>
        {action === 'view_all' ? (
          <CardButton label="Show all bookings" onPress={() => onSend('show my bookings')} />
        ) : (
          <CardButton
            label="Find a service"
            tone="primary"
            onPress={() => onSend('I need help finding a service')}
          />
        )}
      </View>
    </CardShell>
  )
}

const styles = StyleSheet.create({
  text: { color: colors.textSecondary, fontSize: 15 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
})
