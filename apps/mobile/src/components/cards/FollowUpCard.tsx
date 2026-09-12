import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { colors, spacing, radius, typography } from '../../theme'

interface Props {
  question: string
  options: string[]
  onAnswer: (answer: string) => void
}

export default function FollowUpCard({ question, options, onAnswer }: Props) {
  return (
    <View style={styles.card}>
      <Text style={styles.question}>{question}</Text>
      {options.length > 0 ? (
        <View style={styles.options}>
          {options.map((opt) => (
            <Pressable key={opt} style={styles.option} onPress={() => onAnswer(opt)}>
              <Text style={styles.optionTxt}>{opt}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text style={styles.hint}>Type your answer below ↓</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
  },
  question: { ...typography.body, color: colors.text },
  options: { gap: spacing.sm },
  option: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionTxt: { ...typography.body, color: colors.text },
  hint: { ...typography.caption, color: colors.textTertiary },
})
