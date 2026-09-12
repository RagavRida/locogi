import React, { useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import * as Haptics from 'expo-haptics'
import { colors, spacing, radius, typography } from '../../theme'
import { GlassCard } from '../glass/GlassCard'
import { GlassInput } from '../glass/GlassInput'
import { GlassButton } from '../glass/GlassButton'

interface Props {
  vendorName?: string
  onSubmit: (rating: number, comment: string) => void
}

export default function ReviewCard({ vendorName, onSubmit }: Props) {
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')

  return (
    <GlassCard style={styles.card}>
      <Text style={styles.title}>
        {vendorName ? `How was ${vendorName}?` : 'Rate your experience'}
      </Text>

      <View style={styles.stars}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable
            key={n}
            onPress={() => {
              Haptics.selectionAsync()
              setRating(n)
            }}
            hitSlop={6}
          >
            <Text style={[styles.star, n <= rating && styles.starOn]}>
              {n <= rating ? '★' : '☆'}
            </Text>
          </Pressable>
        ))}
      </View>

      {rating > 0 ? (
        <>
          <GlassInput
            containerStyle={{ width: '100%', minHeight: 64 }}
            value={comment}
            onChangeText={setComment}
            placeholder="Add a comment (optional)"
            multiline
          />
          <GlassButton
            title="Submit review"
            variant="primary"
            style={{ width: '100%' }}
            onPress={() => onSubmit(rating, comment)}
          />
        </>
      ) : null}
    </GlassCard>
  )
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.lg,
    alignItems: 'center',
  },
  title: { ...typography.h3, color: colors.text, textAlign: 'center' },
  stars: { flexDirection: 'row', gap: spacing.md },
  star: { fontSize: 34, color: colors.textTertiary },
  starOn: { color: colors.accent },
})
