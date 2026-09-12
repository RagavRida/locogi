import React, { useState } from 'react'
import {
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Modal,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import * as Haptics from 'expo-haptics'
import { api } from '../api/client'
import { useThemeColors, spacing, radius, typography } from '../theme'
import { GlassView } from '../components/glass/GlassView'
import { GlassCard } from '../components/glass/GlassCard'
import { GlassButton } from '../components/glass/GlassButton'
import { GlassInput } from '../components/glass/GlassInput'

export default function VendorInboxScreen({ navigation }: any) {
  const insets = useSafeAreaInsets()
  const qc = useQueryClient()
  const [quoting, setQuoting] = useState<string | null>(null)
  const [price, setPrice] = useState('')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  
  const colors = useThemeColors()

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['vendorInbox'],
    queryFn: api.getVendorInbox,
    refetchInterval: 15_000,
  })

  const submitQuote = async () => {
    const p = parseInt(price.replace(/\D/g, ''))
    if (!p || p <= 0 || !quoting) return
    setSending(true)
    try {
      await api.sendQuote(quoting, p, note || undefined)
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      setQuoting(null)
      setPrice('')
      setNote('')
      qc.invalidateQueries({ queryKey: ['vendorInbox'] })
    } finally {
      setSending(false)
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <GlassView style={[styles.header, { paddingTop: insets.top + spacing.md }]} intensity={40}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Text style={[styles.back, { color: colors.text }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Job requests</Text>
        <Pressable onPress={() => refetch()} hitSlop={10}>
          <Text style={[styles.refresh, { color: colors.accent }]}>↻</Text>
        </Pressable>
      </GlassView>

      {isLoading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xxl }} />
      ) : (
        <FlatList
          data={data?.requests ?? []}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.textTertiary }]}>
              No new requests right now.{'\n'}We'll notify you when something comes in.
            </Text>
          }
          renderItem={({ item }) => (
            <GlassCard style={styles.card}>
              <View style={styles.cardTop}>
                <View style={[styles.typeBadge, { backgroundColor: colors.accentSoft }]}>
                  <Text style={[styles.typeTxt, { color: colors.accent }]}>{item.bookingType}</Text>
                </View>
                <Text style={[styles.ago, { color: colors.textTertiary }]}>
                  {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                </Text>
              </View>

              <Text style={[styles.desc, { color: colors.text }]}>{item.rawDescription}</Text>

              <View style={styles.actions}>
                <GlassButton
                  style={{ flex: 2 }}
                  title={item.bookingType === 'hiring' ? 'Apply' : 'Send quote'}
                  variant="primary"
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
                    setQuoting(item.id)
                  }}
                />
                <GlassButton
                  style={{ flex: 1 }}
                  title="Pass"
                  variant="secondary"
                  onPress={() => {}}
                />
              </View>
            </GlassCard>
          )}
        />
      )}

      {/* Quote modal */}
      <Modal visible={quoting !== null} transparent animationType="slide">
        <Pressable style={styles.overlay} onPress={() => setQuoting(null)}>
          <Pressable style={styles.sheetContainer} onPress={(e) => e.stopPropagation()}>
            <GlassView intensity={60} style={styles.sheet}>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>Your quote</Text>
              <View style={styles.priceRow}>
                <Text style={[styles.rupee, { color: colors.textSecondary }]}>₹</Text>
                <GlassInput
                  containerStyle={{ flex: 1, backgroundColor: 'transparent' }}
                  style={[styles.priceInput, { color: colors.text }]}
                  value={price}
                  onChangeText={setPrice}
                  keyboardType="numeric"
                  placeholder="0"
                  autoFocus
                />
              </View>
              <GlassInput
                containerStyle={{ minHeight: 70 }}
                value={note}
                onChangeText={setNote}
                placeholder="Add a note (optional) — e.g. availability, what's included"
                multiline
              />
              <GlassButton
                title={sending ? 'Sending...' : 'Send quote'}
                variant="primary"
                onPress={submitQuote}
                disabled={!price || sending}
                style={(!price || sending) ? styles.sendOff : undefined}
              />
            </GlassView>
          </Pressable>
        </Pressable>
      </Modal>
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
  refresh: { fontSize: 22 },

  list: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  card: {
    gap: spacing.md,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  typeBadge: {
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    borderRadius: radius.full,
  },
  typeTxt: { ...typography.tiny, fontWeight: '600', textTransform: 'capitalize' },
  ago: { ...typography.tiny },
  desc: { ...typography.body },

  actions: { flexDirection: 'row', gap: spacing.sm },

  empty: {
    ...typography.body,
    textAlign: 'center',
    marginTop: spacing.xxl,
    lineHeight: 24,
  },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheetContainer: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
  },
  sheet: {
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  sheetTitle: { ...typography.h3 },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
  },
  rupee: { fontSize: 26 },
  priceInput: { flex: 1, fontSize: 26, paddingVertical: spacing.md },
  sendOff: { opacity: 0.5 },
})
