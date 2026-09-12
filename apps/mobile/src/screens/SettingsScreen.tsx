import React from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Alert } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Location from 'expo-location'
import { useStore } from '../store'
import { clearToken } from '../api/client'
import { colors, spacing, radius, typography } from '../theme'

export default function SettingsScreen({ navigation }: any) {
  const insets = useSafeAreaInsets()
  const { role, logout, setAuth, userId } = useStore()

  const requestLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync()
    Alert.alert(
      status === 'granted' ? 'Location enabled' : 'Location denied',
      status === 'granted'
        ? 'We can now find vendors closer to you.'
        : 'You can still use Locogi — we just cannot rank vendors by distance.'
    )
  }

  const handleLogout = () => {
    Alert.alert('Log out?', 'You will need to sign in again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log out',
        style: 'destructive',
        onPress: async () => {
          await clearToken()
          logout()
        },
      },
    ])
  }

  const switchRole = () => {
    const next = role === 'customer' ? 'vendor' : 'customer'
    setAuth(userId ?? '', next)
    navigation.goBack()
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Section title="Account">
          <Row label="Mode" value={role === 'vendor' ? 'Vendor' : role === 'both' ? 'Both' : 'Customer'} />
          <Action label="Switch mode" onPress={switchRole} />
        </Section>

        <Section title="Permissions">
          <Action label="Enable location" onPress={requestLocation} />
        </Section>

        <Section title="Safety">
          <Action label="Add emergency contact" onPress={() => Alert.alert('Coming soon')} />
        </Section>

        <Section title="Legal">
          <Action label="Privacy policy" onPress={() => Alert.alert('Privacy policy', 'Locogi complies with the DPDP Act 2023.')} />
          <Action label="Delete my data" danger onPress={() => Alert.alert('Delete data', 'This will cancel active bookings and remove your personal data.')} />
        </Section>

        <Pressable style={styles.logout} onPress={handleLogout}>
          <Text style={styles.logoutTxt}>Log out</Text>
        </Pressable>

        <Text style={styles.version}>Locogi v1.0.0 · Hyderabad</Text>
      </ScrollView>
    </View>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  )
}

function Action({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Text style={[styles.rowLabel, danger && { color: colors.danger }]}>{label}</Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: { fontSize: 30, color: colors.text, lineHeight: 32 },
  title: { ...typography.h3, color: colors.text },
  body: { padding: spacing.lg, gap: spacing.xl },

  section: { gap: spacing.sm },
  sectionTitle: {
    ...typography.tiny,
    color: colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingLeft: spacing.xs,
  },
  sectionBody: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLabel: { ...typography.body, color: colors.text },
  rowValue: { ...typography.body, color: colors.textSecondary },
  chevron: { fontSize: 22, color: colors.textTertiary },

  logout: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  logoutTxt: { ...typography.bodyBold, color: colors.danger },
  version: { ...typography.tiny, color: colors.textTertiary, textAlign: 'center' },
})
