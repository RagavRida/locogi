import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { colors, spacing, radius, typography } from '../../theme'
import { GlassView } from '../glass/GlassView'
import type { Vendor } from '../../api/client'

interface Props {
  vendors: Vendor[]
  onSelect: (vendorId: string) => void
}

export default function VendorListCard({ vendors, onSelect }: Props) {
  return (
    <View style={styles.wrap}>
      {vendors.map((v) => (
        <Pressable key={v.id} onPress={() => onSelect(v.id)}>
          <GlassView style={styles.row} intensity={30} elevation="elevation1">
            <View style={styles.avatar}>
              <Text style={styles.avatarTxt}>
                {(v.attributes?.name as string ?? 'V').charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {(v.attributes?.name as string) ?? v.categoryTags[0] ?? 'Vendor'}
              </Text>
              <Text style={styles.meta}>
                {v.rating > 0 ? `⭐ ${v.rating.toFixed(1)}` : 'New'}
                {'  ·  '}
                {v.completedJobs} jobs
                {v.serviceAreaDescription ? `  ·  ${v.serviceAreaDescription}` : ''}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </GlassView>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarTxt: { ...typography.bodyBold, color: colors.accent },
  name: { ...typography.bodyBold, color: colors.text },
  meta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  chevron: { fontSize: 24, color: colors.textTertiary },
})
