import React, { useState, useRef, useEffect } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import { useStore } from '../store'
import { api, setToken } from '../api/client'
import { colors, spacing, radius, typography } from '../theme'

export default function LoginScreen() {
  const insets = useSafeAreaInsets()
  const { setAuth } = useStore()

  const [step, setStep] = useState<'phone' | 'otp'>('phone')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resendIn, setResendIn] = useState(0)

  useEffect(() => {
    if (resendIn <= 0) return
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [resendIn])

  const sendOtp = async () => {
    const clean = phone.replace(/\D/g, '')
    if (clean.length !== 10) {
      setError('Enter a valid 10-digit mobile number')
      return
    }
    setLoading(true)
    setError('')
    try {
      await api.sendOtp(`+91${clean}`)
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      setStep('otp')
      setResendIn(60)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send OTP')
    } finally {
      setLoading(false)
    }
  }

  const verifyOtp = async () => {
    if (otp.length !== 6) {
      setError('Enter the 6-digit code')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await api.verifyOtp(`+91${phone.replace(/\D/g, '')}`, otp)
      await setToken(res.accessToken)
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      setAuth(res.userId, null)
    } catch (e) {
      setError('Incorrect code. Try again.')
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top + spacing.xxl }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.brand}>
        <View style={styles.dot} />
        <Text style={styles.logo}>locogi</Text>
      </View>

      <Text style={styles.headline}>
        {step === 'phone' ? 'Your city.\nYour services.\nJust ask.' : 'Enter the code'}
      </Text>

      <Text style={styles.sub}>
        {step === 'phone'
          ? 'Sign in with your mobile number to get started'
          : `We sent a 6-digit code to +91 ${phone}`}
      </Text>

      {step === 'phone' ? (
        <View style={styles.inputRow}>
          <View style={styles.prefix}>
            <Text style={styles.prefixTxt}>+91</Text>
          </View>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={(v) => {
              setPhone(v.replace(/\D/g, '').slice(0, 10))
              setError('')
            }}
            placeholder="98765 43210"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            maxLength={10}
            autoFocus
          />
        </View>
      ) : (
        <TextInput
          style={styles.otpInput}
          value={otp}
          onChangeText={(v) => {
            setOtp(v.replace(/\D/g, '').slice(0, 6))
            setError('')
          }}
          placeholder="······"
          placeholderTextColor={colors.textTertiary}
          keyboardType="number-pad"
          maxLength={6}
          autoFocus
        />
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.cta, loading && styles.ctaOff]}
        onPress={step === 'phone' ? sendOtp : verifyOtp}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color={colors.bg} />
        ) : (
          <Text style={styles.ctaTxt}>
            {step === 'phone' ? 'Send code' : 'Verify & continue'}
          </Text>
        )}
      </Pressable>

      {step === 'otp' ? (
        <Pressable
          onPress={() => resendIn === 0 && sendOtp()}
          disabled={resendIn > 0}
          style={styles.resend}
        >
          <Text style={styles.resendTxt}>
            {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
          </Text>
        </Pressable>
      ) : null}

      <Text style={styles.legal}>
        By continuing you agree to our Terms and Privacy Policy. We comply with the
        DPDP Act 2023.
      </Text>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.xl },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xxl },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  logo: { ...typography.h2, color: colors.text, letterSpacing: -0.8 },

  headline: { ...typography.h1, color: colors.text, marginBottom: spacing.md, lineHeight: 40 },
  sub: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.xl },

  inputRow: { flexDirection: 'row', gap: spacing.sm },
  prefix: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  },
  prefixTxt: { ...typography.body, color: colors.textSecondary },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    color: colors.text,
    fontSize: 18,
    letterSpacing: 1,
  },
  otpInput: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    color: colors.text,
    fontSize: 28,
    letterSpacing: 14,
    textAlign: 'center',
  },

  error: { ...typography.caption, color: colors.danger, marginTop: spacing.md },

  cta: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  ctaOff: { opacity: 0.6 },
  ctaTxt: { ...typography.bodyBold, color: colors.bg, fontSize: 16 },

  resend: { alignItems: 'center', marginTop: spacing.lg },
  resendTxt: { ...typography.caption, color: colors.accent },

  legal: {
    ...typography.tiny,
    color: colors.textTertiary,
    marginTop: 'auto',
    marginBottom: spacing.xl,
    lineHeight: 16,
  },
})
