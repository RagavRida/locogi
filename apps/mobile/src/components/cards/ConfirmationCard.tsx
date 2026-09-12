import React, { useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, radius, typography } from '../../theme'
import { GlassCard } from '../glass/GlassCard'
import { GlassInput } from '../glass/GlassInput'
import { GlassButton } from '../glass/GlassButton'

type FieldType = 'text' | 'number' | 'date' | 'currency' | 'list'

interface Props {
  attributes: Record<string, unknown>
  attributeSchema: Record<string, FieldType>
  categoryTags: string[]
  onConfirm: (edited: Record<string, unknown>) => void
}

const prettyLabel = (key: string) =>
  key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export default function ConfirmationCard({
  attributes,
  attributeSchema,
  categoryTags,
  onConfirm,
}: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    Object.keys(attributeSchema ?? {}).forEach((k) => {
      init[k] = String(attributes[k] ?? '')
    })
    return init
  })

  const fields = Object.entries(attributeSchema ?? {})

  return (
    <GlassCard style={styles.card}>
      {/* Category chips */}
      <View style={styles.chips}>
        {categoryTags.slice(0, 3).map((tag) => (
          <View key={tag} style={styles.chip}>
            <Text style={styles.chipTxt}>{tag}</Text>
          </View>
        ))}
      </View>

      {/* Editable fields */}
      {fields.length > 0 ? (
        <View style={styles.fields}>
          {fields.map(([key, type]) => (
            <View key={key} style={styles.field}>
              <Text style={styles.label}>{prettyLabel(key)}</Text>
              <GlassInput
                value={values[key]}
                onChangeText={(v) => setValues((s) => ({ ...s, [key]: v }))}
                keyboardType={
                  type === 'number' || type === 'currency' ? 'numeric' : 'default'
                }
                placeholder={type === 'currency' ? '₹0' : `Add ${prettyLabel(key).toLowerCase()}`}
              />
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.empty}>Ready to find vendors for you.</Text>
      )}

      <GlassButton
        title="Looks good — find vendors"
        variant="primary"
        onPress={() => onConfirm(values)}
      />
    </GlassCard>
  )
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.lg,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.full,
  },
  chipTxt: { ...typography.tiny, color: colors.accent, fontWeight: '600' },

  fields: { gap: spacing.md },
  field: { gap: spacing.xs },
  label: { ...typography.tiny, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  empty: { ...typography.caption, color: colors.textSecondary },
})
