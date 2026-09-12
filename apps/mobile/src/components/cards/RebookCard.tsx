import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { colors, spacing, radius, typography } from '../../theme'

interface Props {
  vendorName: string
  onRebook: () => void
  onDismiss: () => void
}

export default function RebookCard({ vendorName, onRebook, onDismiss }: Props) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Book {vendorName} again?</Text>
      <View style={styles.actions}>
        <Pressable style={styles.primary} onPress={onRebook}>
          <Text style={styles.primaryTxt}>Book again</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={onDismiss}>
          <Text style={styles.secondaryTxt}>Not now</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.accentSoft,
    gap: spacing.md,
  },
  title: { ...typography.bodyBold, color: colors.text },
  actions: { flexDirection: 'row', gap: spacing.sm },
  primary: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  primaryTxt: { ...typography.bodyBold, color: colors.bg },
  secondary: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryTxt: { ...typography.bodyBold, color: colors.textSecondary },
})
