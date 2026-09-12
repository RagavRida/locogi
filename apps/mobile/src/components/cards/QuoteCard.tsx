import React, { useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, radius, typography } from '../../theme'
import { GlassCard } from '../glass/GlassCard'
import { GlassInput } from '../glass/GlassInput'
import { GlassButton } from '../glass/GlassButton'

interface Props {
  vendorName: string
  vendorRating: number
  vendorJobs: number
  quotedPrice: number
  message?: string
  onAccept: () => void
  onCounter: (price: number) => void
}

export default function QuoteCard({
  vendorName,
  vendorRating,
  vendorJobs,
  quotedPrice,
  message,
  onAccept,
  onCounter,
}: Props) {
  const [countering, setCountering] = useState(false)
  const [counterPrice, setCounterPrice] = useState('')

  return (
    <GlassCard style={styles.card}>
      {/* Vendor row */}
      <View style={styles.top}>
        <View style={styles.avatar}>
          <Text style={styles.avatarTxt}>{vendorName.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{vendorName}</Text>
          <Text style={styles.meta}>
            {vendorRating > 0 ? `⭐ ${vendorRating.toFixed(1)}` : 'New vendor'}
            {'  ·  '}
            {vendorJobs} job{vendorJobs === 1 ? '' : 's'}
          </Text>
        </View>
        <View style={styles.priceBox}>
          <Text style={styles.priceTxt}>₹{quotedPrice.toLocaleString('en-IN')}</Text>
        </View>
      </View>

      {message ? <Text style={styles.note}>"{message}"</Text> : null}

      {/* Actions */}
      {!countering ? (
        <View style={styles.actions}>
          <GlassButton
            style={{ flex: 2 }}
            title="Accept"
            variant="primary"
            onPress={onAccept}
          />
          <GlassButton
            style={{ flex: 1 }}
            title="Counter"
            variant="secondary"
            onPress={() => setCountering(true)}
          />
        </View>
      ) : (
        <View style={styles.counterRow}>
          <GlassInput
            containerStyle={{ flex: 1 }}
            value={counterPrice}
            onChangeText={setCounterPrice}
            keyboardType="numeric"
            placeholder="Your price"
            autoFocus
          />
          <GlassButton
            title="Send"
            variant="primary"
            onPress={() => {
              const p = parseInt(counterPrice.replace(/\D/g, ''))
              if (p > 0) {
                onCounter(p)
                setCountering(false)
                setCounterPrice('')
              }
            }}
          />
        </View>
      )}
    </GlassCard>
  )
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarTxt: { ...typography.h3, color: colors.accent },
  name: { ...typography.bodyBold, color: colors.text },
  meta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  priceBox: {
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  priceTxt: { ...typography.h3, color: colors.accent },
  note: {
    ...typography.caption,
    color: colors.textSecondary,
    fontStyle: 'italic',
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  actions: { flexDirection: 'row', gap: spacing.sm },
  counterRow: { flexDirection: 'row', gap: spacing.sm },
})
