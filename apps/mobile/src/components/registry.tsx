/**
 * The component registry.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A REGISTRY AND NOT THE SWITCH THAT WAS HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ChatScreen had a 150-line `switch (card.type)` that decided what to render.
 * It worked, and for cards the client itself creates it still does — those
 * stay where they are, because they close over handlers like
 * `createAndMatch(pendingExtraction, edited)` that only make sense inside that
 * screen.
 *
 * What the switch could not do is render a component the SERVER chose. A
 * server-driven card arrives as `{ type, data }` from an API response, and
 * the set of legal types has to be a closed, checkable list rather than
 * whatever string came over the wire.
 *
 * So this registry covers exactly the server-driven components. Two rules make
 * it safe:
 *
 *  1. A type not in this map renders nothing. It never falls through to
 *     `eval`, `dangerouslySetInnerHTML`, or a dynamic import — the server can
 *     only ever pick from components that were compiled into this build.
 *  2. Every component receives IDS and fetches its own data. Nothing renders
 *     from whatever was serialised into chat history, so an old message shows
 *     the booking's current state rather than a snapshot that has since become
 *     a lie.
 */

import React from 'react'
import { Text, StyleSheet } from 'react-native'
import type { UIComponentType } from '@locogi/types'
import { colors, radius, spacing } from '../theme'
import { GlassCard } from './glass/GlassCard'

import BookingListCard from './cards/BookingListCard'
import BookingDetailCard from './cards/BookingDetailCard'
import BookingStatusCard from './cards/BookingStatusCard'
import BookingTrackingCard from './cards/BookingTrackingCard'
import BookingSelectorCard from './cards/BookingSelectorCard'
import ConfirmActionCard from './cards/ConfirmActionCard'
import EmptyStateCard from './cards/EmptyStateCard'

/** What every server-driven card receives. */
export interface ServerCardProps {
  data: Record<string, unknown>
  /** Send a follow-up message as if the user typed it. */
  onSend: (text: string) => void
  /** Resolve an ambiguity by id, without the user typing. */
  onSelectBooking: (bookingId: string, forIntent?: string) => void
  /** Something changed server-side; refresh anything showing this booking. */
  onChanged: () => void
}

type ServerComponent = React.ComponentType<ServerCardProps>

/**
 * Server-renderable components.
 *
 * Partial over UIComponentType on purpose: the union also contains the
 * client-orchestrated card types (confirmation, slot_picker, ...) which
 * ChatScreen still owns. Listing them here would imply the server may drive
 * them, which it may not.
 */
export const componentRegistry: Partial<Record<UIComponentType, ServerComponent>> = {
  booking_list: BookingListCard,
  booking_detail: BookingDetailCard,
  booking_status: BookingStatusCard,
  booking_tracking: BookingTrackingCard,
  booking_selector: BookingSelectorCard,
  confirm_action: ConfirmActionCard,
  empty_state: EmptyStateCard,
}

export function isRenderableByServer(type: string): type is UIComponentType {
  return Object.prototype.hasOwnProperty.call(componentRegistry, type)
}

/**
 * Render a server-chosen component, or nothing.
 *
 * Failing to a blank space rather than an error card is deliberate. An unknown
 * type almost always means an older app build meeting a newer server, and the
 * accompanying text message still says something useful — so a loud red
 * "unsupported component" box would turn a graceful degradation into a visible
 * fault. It is logged in development so the mismatch is not invisible to us.
 */
export function ServerCard({
  type,
  ...props
}: ServerCardProps & { type: string }): React.ReactElement | null {
  const Component = isRenderableByServer(type) ? componentRegistry[type] : undefined

  if (!Component) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(
        `[registry] no component for "${type}" — this build may be older than the server.`
      )
    }
    return null
  }

  return <Component {...props} />
}

/** Shared shell so every card looks like it belongs to the same product. */
export function CardShell({
  children,
  testID,
}: {
  children: React.ReactNode
  testID?: string
}) {
  return (
    <GlassCard style={styles.shell} elevation="elevation1">
      {children}
    </GlassCard>
  )
}

export function CardError({ message }: { message: string }) {
  return (
    <CardShell>
      <Text style={styles.error}>{message}</Text>
    </CardShell>
  )
}

const styles = StyleSheet.create({
  shell: {
    // Styling is handled by GlassCard, we just need inner padding if necessary,
    // though GlassCard defaults to 16px.
  },
  error: { color: colors.textSecondary, fontSize: 14 },
})
