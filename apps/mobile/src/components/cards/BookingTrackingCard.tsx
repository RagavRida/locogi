/**
 * Where the provider is.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS CARD MUST NOT LIE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other card being wrong is an inconvenience. This one being wrong
 * changes what the customer DOES: told "on the way, 12 minutes", they stop
 * calling and wait by the door. If the provider is not actually sharing
 * location, that wait is indefinite and the app caused it.
 *
 * So the unavailable states are rendered as first-class content with a reason
 * and a way to act, not as an empty map with a spinner. And the ETA is
 * labelled as an estimate from straight-line distance, because Hyderabad
 * traffic makes any other claim a fiction.
 */

import React, { useEffect, useState } from 'react'
import { Text, View, StyleSheet, ActivityIndicator } from 'react-native'
import { CardShell, CardError, type ServerCardProps } from '../registry'
import { CardButton } from './bookingBits'
import { colors, spacing } from '../../theme'
import { api } from '../../api/client'
import { useRealtimeTopic } from '../../hooks/useRealtime'

type Tracking = Awaited<ReturnType<typeof api.getBookingTracking>>

/**
 * Fallback refresh cadence.
 *
 * The socket is the primary path now, so this is a safety net for when it is
 * down or the device is on a network that blocks WebSockets — not the
 * mechanism. It is deliberately slow: with realtime working, polling this
 * often would be pure waste.
 */
const FALLBACK_POLL_MS = 120_000

export default function BookingTrackingCard({ data, onSend }: ServerCardProps) {
  const bookingId = typeof data.bookingId === 'string' ? data.bookingId : undefined
  const [tracking, setTracking] = useState<Tracking | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!bookingId) return
    let alive = true

    const load = async () => {
      try {
        const t = await api.getBookingTracking(bookingId)
        if (alive) setTracking(t)
      } catch {
        if (alive) setFailed(true)
      }
    }

    void load()
    // Polling stops with the component. A location that stopped updating is
    // handled server-side by treating a stale fix as no fix at all.
    const timer = setInterval(load, FALLBACK_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [bookingId])

  // Refetch the moment the provider moves or changes phase, instead of
  // discovering it up to a poll-interval later.
  useRealtimeTopic(bookingId ? { kind: 'tracking', id: bookingId } : null, () => {
    if (!bookingId) return
    void api
      .getBookingTracking(bookingId)
      .then(setTracking)
      .catch(() => {
        /* the fallback poll will retry */
      })
  })

  if (failed) return <CardError message="Could not load tracking." />
  if (!tracking) {
    return (
      <CardShell>
        <ActivityIndicator color={colors.accent} />
      </CardShell>
    )
  }

  if (!tracking.available) {
    const reason =
      {
        no_vendor: 'No provider has been assigned to this booking yet.',
        not_started: 'Live location starts once the booking is under way.',
        not_sharing: `${tracking.vendorName ?? 'Your provider'} is not sharing their location right now.`,
      }[tracking.why ?? ''] ?? 'Live location is not available.'

    return (
      <CardShell testID="booking-tracking-unavailable">
        <Text style={styles.heading}>Location unavailable</Text>
        <Text style={styles.reason}>{reason}</Text>
        <View style={styles.actions}>
          <CardButton label="Message provider" onPress={() => onSend('message my provider')} />
        </View>
      </CardShell>
    )
  }

  return (
    <CardShell testID="booking-tracking">
      <Text style={styles.heading}>Provider is on the way</Text>
      {tracking.vendorName ? <Text style={styles.vendor}>{tracking.vendorName}</Text> : null}

      <View style={styles.stats}>
        {tracking.etaMinutes != null ? (
          <View>
            <Text style={styles.statValue}>~{tracking.etaMinutes} min</Text>
            <Text style={styles.statLabel}>Estimated</Text>
          </View>
        ) : null}
        {tracking.distanceKm != null ? (
          <View>
            <Text style={styles.statValue}>{tracking.distanceKm} km</Text>
            <Text style={styles.statLabel}>Straight line</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.caveat}>
        Estimated from straight-line distance — traffic will change it.
      </Text>

      <View style={styles.actions}>
        <CardButton label="Message provider" onPress={() => onSend('message my provider')} />
      </View>
    </CardShell>
  )
}

const styles = StyleSheet.create({
  heading: { color: colors.text, fontSize: 16, fontWeight: '700' },
  vendor: { color: colors.textSecondary, fontSize: 14, marginTop: 2 },
  reason: { color: colors.textSecondary, fontSize: 14, marginTop: spacing.sm, lineHeight: 20 },
  stats: { flexDirection: 'row', gap: spacing.xl, marginTop: spacing.lg },
  statValue: { color: colors.accent, fontSize: 22, fontWeight: '700' },
  statLabel: { color: colors.textTertiary, fontSize: 11, marginTop: 2 },
  caveat: { color: colors.textTertiary, fontSize: 11, marginTop: spacing.md, fontStyle: 'italic' },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
})
