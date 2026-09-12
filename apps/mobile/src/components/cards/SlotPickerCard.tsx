import React, { useState, useEffect } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native'
import { format, addDays } from 'date-fns'
import { colors, spacing, radius, typography } from '../../theme'
import { GlassCard } from '../glass/GlassCard'
import { api, type Slot } from '../../api/client'

interface Props {
  vendorId: string
  requestId: string
  onBooked: (slotTime: string) => void
}

export default function SlotPickerCard({ vendorId, requestId, onBooked }: Props) {
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [slots, setSlots] = useState<Slot[]>([])
  const [loading, setLoading] = useState(true)
  const [booking, setBooking] = useState<string | null>(null)

  const dates = Array.from({ length: 14 }, (_, i) => addDays(new Date(), i))

  useEffect(() => {
    setLoading(true)
    api
      .getSlots(vendorId, format(selectedDate, 'yyyy-MM-dd'))
      .then((r) => setSlots(r.slots ?? []))
      .catch(() => setSlots([]))
      .finally(() => setLoading(false))
  }, [vendorId, selectedDate])

  const isAvailable = (s: Slot) =>
    !s.isCancelled &&
    s.capacityBooked < s.capacityTotal &&
    new Date(s.slotTime) > new Date()

  const handleBook = async (slot: Slot) => {
    setBooking(slot.id)
    try {
      const res = await api.bookSlot(requestId, slot.id)
      if (res.success) {
        onBooked(format(new Date(slot.slotTime), "d MMM 'at' h:mm a"))
      } else {
        // Slot taken — refresh
        const r = await api.getSlots(vendorId, format(selectedDate, 'yyyy-MM-dd'))
        setSlots(r.slots ?? [])
      }
    } finally {
      setBooking(null)
    }
  }

  return (
    <GlassCard style={styles.card}>
      <Text style={styles.title}>Pick a time</Text>

      {/* Date scroller */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.dateRow}
      >
        {dates.map((d) => {
          const active = format(d, 'yyyy-MM-dd') === format(selectedDate, 'yyyy-MM-dd')
          return (
            <Pressable
              key={d.toISOString()}
              onPress={() => setSelectedDate(d)}
              style={[styles.dateChip, active && styles.dateChipActive]}
            >
              <Text style={[styles.dayTxt, active && styles.dateTxtActive]}>
                {format(d, 'EEE')}
              </Text>
              <Text style={[styles.dateNum, active && styles.dateTxtActive]}>
                {format(d, 'd')}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>

      {/* Slots */}
      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ paddingVertical: spacing.xl }} />
      ) : slots.length === 0 ? (
        <Text style={styles.empty}>No slots available this day</Text>
      ) : (
        <View style={styles.slotGrid}>
          {slots.map((s) => {
            const avail = isAvailable(s)
            return (
              <Pressable
                key={s.id}
                disabled={!avail || booking !== null}
                onPress={() => handleBook(s)}
                style={[styles.slot, !avail && styles.slotOff]}
              >
                {booking === s.id ? (
                  <ActivityIndicator size="small" color={colors.bg} />
                ) : (
                  <Text style={[styles.slotTxt, !avail && styles.slotTxtOff]}>
                    {format(new Date(s.slotTime), 'h:mm a')}
                  </Text>
                )}
              </Pressable>
            )
          })}
        </View>
      )}
    </GlassCard>
  )
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
  },
  title: { ...typography.h3, color: colors.text },
  dateRow: { gap: spacing.sm, paddingVertical: spacing.xs },
  dateChip: {
    width: 52,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: 'center',
    gap: 2,
  },
  dateChipActive: { backgroundColor: colors.accent },
  dayTxt: { ...typography.tiny, color: colors.textSecondary },
  dateNum: { ...typography.bodyBold, color: colors.text },
  dateTxtActive: { color: colors.bg },

  slotGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  slot: {
    minWidth: 84,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  slotOff: { backgroundColor: colors.surface },
  slotTxt: { ...typography.caption, color: colors.bg, fontWeight: '600' },
  slotTxtOff: { color: colors.textTertiary, textDecorationLine: 'line-through' },
  empty: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
})
