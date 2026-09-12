import React, { useEffect, useRef } from 'react'
import { View, Text, Animated, Easing, StyleSheet } from 'react-native'
import { colors, spacing, radius, typography } from '../../theme'

export default function SearchingCard({ count = 0 }: { count?: number }) {
  const pulse = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.ease, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.ease, useNativeDriver: true }),
      ])
    ).start()
  }, [])

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] })
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0.15] })

  return (
    <View style={styles.card}>
      <View style={styles.radar}>
        <Animated.View style={[styles.ring, { transform: [{ scale }], opacity }]} />
        <View style={styles.core} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>Finding vendors near you</Text>
        <Text style={styles.sub}>
          {count > 0 ? `${count} notified so far` : 'Searching your area...'}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  radar: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  core: {
    width: 12,
    height: 12,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  title: { ...typography.bodyBold, color: colors.text },
  sub: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
})
