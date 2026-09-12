import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, radius, typography } from '../../theme'
import { GlassCard } from '../glass/GlassCard'
import { GlassButton } from '../glass/GlassButton'

interface Stage {
  label: string
  done: boolean
}

interface Props {
  vendorName?: string
  price?: number
  stages: Stage[]
  onAdvance: (stage: 'in_progress' | 'completed') => void
}

export default function JobTrackerCard({ vendorName, price, stages, onAdvance }: Props) {
  const activeIdx = stages.findIndex((s) => !s.done)
  const nextStage: 'in_progress' | 'completed' | null =
    activeIdx === 2 ? 'in_progress' : activeIdx === 3 ? 'completed' : null

  return (
    <GlassCard style={styles.card}>
      {vendorName ? (
        <View style={styles.head}>
          <Text style={styles.vendor}>{vendorName}</Text>
          {price ? <Text style={styles.price}>₹{price.toLocaleString('en-IN')}</Text> : null}
        </View>
      ) : null}

      {/* Progress rail */}
      <View style={styles.rail}>
        {stages.map((stage, i) => {
          const isActive = i === activeIdx
          return (
            <View key={stage.label} style={styles.stageRow}>
              <View style={styles.railCol}>
                <View
                  style={[
                    styles.dot,
                    stage.done && styles.dotDone,
                    isActive && styles.dotActive,
                  ]}
                >
                  {stage.done ? <Text style={styles.check}>✓</Text> : null}
                </View>
                {i < stages.length - 1 ? (
                  <View style={[styles.line, stage.done && styles.lineDone]} />
                ) : null}
              </View>
              <Text
                style={[
                  styles.stageLabel,
                  stage.done && styles.stageLabelDone,
                  isActive && styles.stageLabelActive,
                ]}
              >
                {stage.label}
              </Text>
            </View>
          )
        })}
      </View>

      {nextStage ? (
        <GlassButton
          title={nextStage === 'in_progress' ? 'Mark as started' : 'Mark as completed'}
          variant="primary"
          onPress={() => onAdvance(nextStage)}
        />
      ) : null}
    </GlassCard>
  )
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.lg,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  vendor: { ...typography.bodyBold, color: colors.text },
  price: { ...typography.bodyBold, color: colors.accent },

  rail: { gap: 0 },
  stageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  railCol: { alignItems: 'center', width: 20 },
  dot: {
    width: 18,
    height: 18,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotDone: { backgroundColor: colors.accent, borderColor: colors.accent },
  dotActive: { borderColor: colors.accent },
  check: { fontSize: 10, color: colors.bg, fontWeight: '900' },
  line: { width: 2, height: 26, backgroundColor: colors.border },
  lineDone: { backgroundColor: colors.accent },

  stageLabel: { ...typography.caption, color: colors.textTertiary, paddingTop: 1 },
  stageLabelDone: { color: colors.textSecondary },
  stageLabelActive: { color: colors.text, fontWeight: '600' },
})
