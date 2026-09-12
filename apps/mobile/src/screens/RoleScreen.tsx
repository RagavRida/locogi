import React, { useState } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import { useStore } from '../store'
import { api } from '../api/client'
import { colors, spacing, radius, typography } from '../theme'

const ROLES = [
  {
    id: 'customer' as const,
    emoji: '🔍',
    title: 'I need a service',
    sub: 'Find photographers, plumbers, rides, salons and more',
  },
  {
    id: 'vendor' as const,
    emoji: '🛠',
    title: 'I offer services',
    sub: 'Get job requests sent straight to you',
  },
  {
    id: 'both' as const,
    emoji: '👤',
    title: 'Both',
    sub: 'Switch between finding and offering anytime',
  },
]

export default function RoleScreen() {
  const insets = useSafeAreaInsets()
  const { setAuth, userId } = useStore()
  const [loading, setLoading] = useState<string | null>(null)

  const pick = async (role: 'customer' | 'vendor' | 'both') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    setLoading(role)
    try {
      await api.setRole(role === 'vendor' || role === 'both', role === 'customer' || role === 'both')
    } catch { /* proceed anyway */ }
    setAuth(userId ?? '', role)
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.xxl }]}>
      <Text style={styles.headline}>How will you use Locogi?</Text>
      <Text style={styles.sub}>You can change this anytime</Text>

      <View style={styles.list}>
        {ROLES.map((r) => (
          <Pressable
            key={r.id}
            style={styles.card}
            onPress={() => pick(r.id)}
            disabled={loading !== null}
          >
            <Text style={styles.emoji}>{r.emoji}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{r.title}</Text>
              <Text style={styles.cardSub}>{r.sub}</Text>
            </View>
            {loading === r.id ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={styles.chevron}>›</Text>
            )}
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.xl },
  headline: { ...typography.h1, color: colors.text, marginBottom: spacing.sm },
  sub: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.xxl },
  list: { gap: spacing.md },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emoji: { fontSize: 28 },
  title: { ...typography.bodyBold, color: colors.text, fontSize: 16 },
  cardSub: { ...typography.caption, color: colors.textSecondary, marginTop: 3, lineHeight: 18 },
  chevron: { fontSize: 26, color: colors.textTertiary },
})
