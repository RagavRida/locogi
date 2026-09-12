import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { colors, spacing, radius, typography } from '../../theme'

interface ResolvedCategory {
  categoryId: string
  name: string
  slug: string
  matchedVia: 'exact_alias' | 'alias_similarity' | 'category_similarity' | 'created'
  confidence: number
  yourTag: string
  requiresKyc: boolean
}

interface Props {
  resolved: ResolvedCategory[]
  onConfirm: () => void
}

/**
 * Shows the vendor how their freeform description was interpreted into
 * canonical service categories — with honest signalling about whether they
 * joined an existing category or created a brand-new one.
 */
export default function CategoryCard({ resolved, onConfirm }: Props) {
  const isNew = resolved.some((r) => r.matchedVia === 'created')
  const needsKyc = resolved.some((r) => r.requiresKyc)

  return (
    <View style={styles.card}>
      <Text style={styles.title}>You'll be listed as</Text>

      <View style={styles.list}>
        {resolved.map((r, i) => (
          <View key={r.categoryId} style={styles.row}>
            <View style={styles.left}>
              <Text style={styles.name}>{r.name}</Text>
              {i === 0 ? (
                <View style={styles.primaryBadge}>
                  <Text style={styles.primaryTxt}>PRIMARY</Text>
                </View>
              ) : null}
            </View>
            {r.matchedVia === 'created' ? (
              <View style={styles.newBadge}>
                <Text style={styles.newTxt}>NEW</Text>
              </View>
            ) : null}
          </View>
        ))}
      </View>

      {/* Show the mapping when their wording differed from the canonical name */}
      {resolved.some((r) => r.yourTag.toLowerCase() !== r.name.toLowerCase()) ? (
        <View style={styles.mapping}>
          {resolved
            .filter((r) => r.yourTag.toLowerCase() !== r.name.toLowerCase())
            .map((r) => (
              <Text key={r.categoryId} style={styles.mapTxt}>
                "{r.yourTag}" → {r.name}
              </Text>
            ))}
        </View>
      ) : null}

      {isNew ? (
        <Text style={styles.note}>
          You're the first vendor in this category — customers searching for this
          will find you directly.
        </Text>
      ) : null}

      {needsKyc ? (
        <View style={styles.kycNote}>
          <Text style={styles.kycTxt}>
            This service needs ID verification before you go live. Takes about 24 hours.
          </Text>
        </View>
      ) : null}

      <Pressable style={styles.confirmBtn} onPress={onConfirm}>
        <Text style={styles.confirmTxt}>
          {needsKyc ? 'Submit for review' : 'Go live'}
        </Text>
      </Pressable>
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
  title: { ...typography.caption, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 },

  list: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  left: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  name: { ...typography.h3, color: colors.text },

  primaryBadge: {
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  primaryTxt: { fontSize: 9, fontWeight: '700', color: colors.accent, letterSpacing: 0.5 },

  newBadge: {
    backgroundColor: `${colors.info}22`,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  newTxt: { fontSize: 9, fontWeight: '700', color: colors.info, letterSpacing: 0.5 },

  mapping: {
    gap: 3,
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  mapTxt: { ...typography.tiny, color: colors.textTertiary },

  note: { ...typography.caption, color: colors.textSecondary, lineHeight: 18 },

  kycNote: {
    backgroundColor: `${colors.warning}15`,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  kycTxt: { ...typography.caption, color: colors.warning, lineHeight: 18 },

  confirmBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  confirmTxt: { ...typography.bodyBold, color: colors.bg },
})
