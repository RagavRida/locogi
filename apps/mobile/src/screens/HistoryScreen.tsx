import React from 'react'
import { View, Text, Pressable, FlatList, StyleSheet, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { api } from '../api/client'
import { useThemeColors, spacing, radius, typography } from '../theme'
import { GlassView } from '../components/glass/GlassView'
import { GlassCard } from '../components/glass/GlassCard'
import { GlassButton } from '../components/glass/GlassButton'

const getStatusMeta = (colors: any) => ({
  completed: { label: 'Completed', color: colors.success },
  confirmed: { label: 'Confirmed', color: colors.info },
  in_progress: { label: 'In progress', color: colors.warning },
  cancelled: { label: 'Cancelled', color: colors.danger },
  expired: { label: 'Expired', color: colors.textTertiary },
  open: { label: 'Searching', color: colors.accent },
  no_match: { label: 'No vendors yet', color: colors.textTertiary },
})

export default function HistoryScreen({ navigation }: any) {
  const insets = useSafeAreaInsets()
  const { data, isLoading } = useQuery({
    queryKey: ['history'],
    queryFn: api.getHistory,
  })
  
  const colors = useThemeColors()
  const STATUS_META = getStatusMeta(colors)

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <GlassView style={[styles.header, { paddingTop: insets.top + spacing.md }]} intensity={40}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Text style={[styles.back, { color: colors.text }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Past requests</Text>
        <View style={{ width: 24 }} />
      </GlassView>

      {isLoading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xxl }} />
      ) : (
        <FlatList
          data={data?.requests ?? []}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.textTertiary }]}>No requests yet.{'\n'}Start a conversation to book something.</Text>
          }
          renderItem={({ item }) => {
            const meta = STATUS_META[item.status as keyof typeof STATUS_META] ?? STATUS_META.open
            return (
              <GlassCard style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.desc, { color: colors.text }]} numberOfLines={2}>
                    {item.rawDescription}
                  </Text>
                  <View style={styles.metaRow}>
                    <View style={[styles.badge, { backgroundColor: `${meta.color}22` }]}>
                      <Text style={[styles.badgeTxt, { color: meta.color }]}>{meta.label}</Text>
                    </View>
                    <Text style={[styles.date, { color: colors.textTertiary }]}>
                      {format(new Date(item.createdAt), 'd MMM')}
                    </Text>
                    {item.rating ? (
                      <Text style={[styles.rating, { color: colors.accent }]}>{'★'.repeat(item.rating)}</Text>
                    ) : null}
                  </View>
                </View>
                {item.status === 'completed' ? (
                  <GlassButton
                    title="Book again"
                    variant="secondary"
                    onPress={() => {}}
                  />
                ) : null}
              </GlassCard>
            )
          }}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  back: { fontSize: 30, lineHeight: 32 },
  title: { ...typography.h3 },
  list: { padding: spacing.lg, gap: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  desc: { ...typography.body },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  badge: { paddingHorizontal: spacing.md, paddingVertical: 3, borderRadius: radius.full },
  badgeTxt: { ...typography.tiny, fontWeight: '600' },
  date: { ...typography.tiny },
  rating: { ...typography.tiny },
  empty: {
    ...typography.body,
    textAlign: 'center',
    marginTop: spacing.xxl,
    lineHeight: 24,
  },
})
