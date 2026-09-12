import React, { useRef, useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import * as Location from 'expo-location'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'

import { useStore } from '../store'
import type { CardType } from '../store'
import { useThemeColors, useGlassTokens, spacing, radius, typography } from '../theme'
import { GlassView } from '../components/glass/GlassView'
import { GlassInput } from '../components/glass/GlassInput'
import { api } from '../api/client'
import { getFollowUpQuestions } from '../hooks/useCategoryQuestions'
import type { RootStackParamList } from '../../App'

// Cards
import ConfirmationCard from '../components/cards/ConfirmationCard'
import VendorListCard from '../components/cards/VendorListCard'
import QuoteCard from '../components/cards/QuoteCard'
import SlotPickerCard from '../components/cards/SlotPickerCard'
import JobTrackerCard from '../components/cards/JobTrackerCard'
import ReviewCard from '../components/cards/ReviewCard'
import RebookCard from '../components/cards/RebookCard'
import FollowUpCard from '../components/cards/FollowUpCard'
import SearchingCard from '../components/cards/SearchingCard'
import CategoryCard from '../components/cards/CategoryCard'
// Server-driven cards render through the registry, not the switch below.
import { ServerCard } from '../components/registry'
import { invalidateBookings } from '../hooks/useBooking'
import { useRealtimeConnection } from '../hooks/useRealtime'
import TypingIndicator from '../components/TypingIndicator'

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>

export default function ChatScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets()
  const scrollRef = useRef<ScrollView>(null)
  const [input, setInput] = useState('')

  const {
    messages,
    isAgentTyping,
    addMessage,
    setTyping,
    setActiveRequest,
    setPendingExtraction,
    pendingExtraction,
    setFollowUps,
    pendingFollowUps,
    answerFollowUp,
    followUpAnswers,
    activeRequestId,
    role,
    removeCard,
    isAuthenticated,
  } = useStore()

  const colors = useThemeColors()
  const glass = useGlassTokens()

  // One socket for the whole app, opened while signed in and closed on
  // logout. Individual cards subscribe to their own topics through it.
  useRealtimeConnection(isAuthenticated)

  // ── Restore the conversation ────────────────────────────────────────────
  //
  // The store is in-memory zustand, so a restart used to lose everything and
  // greet the user as though they were new. History now comes from the server,
  // and each restored card carries only ids — the components re-fetch, so a
  // booking cancelled while the app was closed shows as cancelled rather than
  // as whatever it was when the card was first drawn.
  useEffect(() => {
    if (messages.length > 0 || role === 'vendor') return

    let alive = true
    ;(async () => {
      try {
        const { messages: history } = await api.chatHistory(50)
        if (!alive || history.length === 0) return

        for (const m of history) {
          addMessage({
            role: m.role,
            text: m.text ?? undefined,
            card: m.ui ? { type: m.ui.type as CardType, data: m.ui.data } : undefined,
            fromServer: m.ui !== undefined,
          })
        }
      } catch {
        // Offline or a fresh account: the greeting below still runs.
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // Greeting on first mount
  useEffect(() => {
    if (messages.length === 0) {
      addMessage({
        role: 'agent',
        text:
          role === 'vendor'
            ? "Hey! 👋 I'll send you new job requests here as they come in.\n\nTell me about your services to get started."
            : "Hey! 👋 I'm Locogi.\n\nJust tell me what you need — a photographer, plumber, auto ride, salon appointment, anything. I'll find someone good for you.",
      })
    }
  }, [])

  const scrollToEnd = useCallback(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100)
  }, [])

  useEffect(scrollToEnd, [messages.length, isAgentTyping])

  // ─── Send message ──────────────────────────────────────────────────────────
  const handleSend = async () => {
    const text = input.trim()
    if (!text) return

    // Answering a follow-up question by typing?
    if (pendingFollowUps.length > 0) {
      setInput('')
      handleFollowUpAnswer(pendingFollowUps[0], text)
      return
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    addMessage({ role: 'user', text })
    setInput('')

    // ── Is this about something they already booked? ──────────────────────
    //
    // Runs BEFORE the short-message guard below, which would otherwise
    // swallow exactly the messages this feature depends on: "yes", "no",
    // and "cancel it" are all under ten characters.
    //
    // `handled: false` means it was not a booking question, and everything
    // continues down the original path untouched.
    if (role !== 'vendor') {
      setTyping(true)
      try {
        const chat = await api.chat(text)
        if (chat.handled) {
          setTyping(false)
          addMessage({
            role: 'agent',
            text: chat.message,
            card: chat.ui
              ? { type: chat.ui.type as CardType, data: chat.ui.data }
              : undefined,
            fromServer: true,
          })
          return
        }
      } catch {
        // A failure here must not cost the user their message — fall through
        // to the flow that has always handled it.
      }
      setTyping(false)
    }

    // New request → extract
    if (text.length < 10) {
      addMessage({
        role: 'agent',
        text: "Could you tell me a bit more? The more detail, the better the match 🙏",
      })
      return
    }

    setTyping(true)
    try {
      // Pass location so place lookups can be distance-ranked
      let coords: { lat?: number; lng?: number } = {}
      try {
        const { status } = await Location.getForegroundPermissionsAsync()
        if (status === 'granted') {
          const pos = await Location.getLastKnownPositionAsync()
          if (pos) coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        }
      } catch { /* optional */ }

      const extraction =
        role === 'vendor'
          ? await api.extractVendor(text)
          : await api.extractRequest(text, coords)

      setTyping(false)

      // ── Intent gate handled it outside the service pipeline ─────────────
      // Place lookups, social asks, general questions and off-topic messages
      // never reach vendor matching. The agent answers honestly instead.
      if (extraction.handled && extraction.agentMessage) {
        addMessage({ role: 'agent', text: extraction.agentMessage })

        // Nudge back toward something we can actually do
        if (
          extraction.intent === 'social_community' ||
          extraction.intent === 'unsupported'
        ) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
        }
        return
      }

      // Ambiguous?
      if (extraction.ambiguityFlag && extraction.ambiguityNote) {
        addMessage({
          role: 'agent',
          text: `Just to be sure — ${extraction.ambiguityNote}`,
        })
        return
      }

      // Defensive: gate said proceed but extraction came back empty
      if (!extraction.categoryTags || !extraction.attributeSchema) {
        addMessage({
          role: 'agent',
          text: "I couldn't work out what service you need. Could you describe it differently?",
        })
        return
      }

      setPendingExtraction(extraction)

      // ── Vendor path: resolve into canonical categories first ─────────────
      if (role === 'vendor' || role === 'both') {
        setTyping(true)
        try {
          const { resolved } = await api.resolveCategories(extraction.categoryTags)
          setTyping(false)

          if (resolved.length === 0) {
            addMessage({
              role: 'agent',
              text: "I couldn't work out what service that is. Could you describe it differently?",
            })
            return
          }

          addMessage({
            role: 'agent',
            card: {
              type: 'category',
              data: { resolved, rawDescription: text, extraction },
            },
          })
        } catch {
          setTyping(false)
          addMessage({
            role: 'agent',
            text: 'Had trouble categorising that. Try describing your service again?',
          })
        }
        return
      }

      // Category-specific follow-ups (customer path)
      // The vendor/both branch above always returns, so this is the customer
      // path by construction — the old `&& role !== 'vendor'` here was dead.
      const followUps = getFollowUpQuestions(extraction.categoryTags, text)
      if (followUps.length > 0) {
        followUpQueue.current = followUps.map((f) => ({
          question: f.question,
          options: f.options,
        }))
        setFollowUps(followUps.map((f) => f.question))
        addMessage({
          role: 'agent',
          card: {
            type: 'follow_up',
            data: { question: followUps[0].question, options: followUps[0].options },
          },
        })
        return
      }

      // Show confirmation card
      addMessage({
        role: 'agent',
        text: 'Got it! Quick check —',
        card: {
          type: 'confirmation',
          data: {
            attributes: extraction.attributes,
            attributeSchema: extraction.attributeSchema,
            categoryTags: extraction.categoryTags,
            bookingType: extraction.bookingTypeSuggestion,
          },
        },
      })
    } catch (err) {
      setTyping(false)
      addMessage({
        role: 'agent',
        text: "Hmm, I had trouble with that. Mind rephrasing? 😅",
      })
    }
  }

  // ─── Handle a follow-up answer (from card tap or typed text) ───────────────
  const followUpQueue = useRef<{ question: string; options: string[] }[]>([])

  const handleFollowUpAnswer = (question: string, answer: string) => {
    Haptics.selectionAsync()
    addMessage({ role: 'user', text: answer })
    answerFollowUp(question, answer)
    removeCard('follow_up')

    // Pop the next question off the queue
    followUpQueue.current = followUpQueue.current.filter((f) => f.question !== question)
    const next = followUpQueue.current[0]

    if (next) {
      addMessage({
        role: 'agent',
        card: { type: 'follow_up', data: { question: next.question, options: next.options } },
      })
    } else if (pendingExtraction) {
      createAndMatch(pendingExtraction)
    }
  }

  // ─── Vendor: submit profile after category confirmation ────────────────────
  const submitVendorProfile = async (
    rawDescription: string,
    extraction: NonNullable<typeof pendingExtraction>,
    resolved: Array<{ name: string; yourTag: string }>
  ) => {
    removeCard('category')
    setTyping(true)

    let coords: { lat?: number; lng?: number } = {}
    try {
      const { status } = await Location.getForegroundPermissionsAsync()
      if (status === 'granted') {
        const pos = await Location.getLastKnownPositionAsync()
        if (pos) coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }
      }
    } catch { /* optional */ }

    const attrs = (extraction.attributes ?? {}) as Record<string, unknown>
    const area = (attrs.area ?? attrs.location ?? attrs.service_area) as string | undefined

    try {
      const result = await api.createVendor({
        rawDescription,
        categoryTags: extraction.categoryTags ?? [],
        attributes: attrs,
        attributeSchema: extraction.attributeSchema ?? {},
        serviceAreaDescription: area,
        ...coords,
      })
      setTyping(false)
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)

      addMessage({ role: 'agent', text: result.message })

      // The backend tells us which fields other vendors in this role have.
      // Ask for the top missing one to strengthen the profile.
      if (result.missingFields.length > 0) {
        const first = result.missingFields[0]
        addMessage({
          role: 'agent',
          card: {
            type: 'follow_up',
            data: { question: first.question, options: [] },
          },
        })
        followUpQueue.current = result.missingFields.map((f) => ({
          question: f.question,
          options: [],
        }))
        setFollowUps(result.missingFields.map((f) => f.question))
      } else if (result.isLive) {
        addMessage({
          role: 'agent',
          text: "Want to set your working hours? Just say something like \"Monday to Saturday, 9am to 8pm\".",
        })
      }
    } catch {
      setTyping(false)
      addMessage({
        role: 'agent',
        text: "Couldn't save your profile just now. Mind trying again?",
      })
    }
  }

  // ─── Confirm → create request → match ──────────────────────────────────────
  const createAndMatch = async (
    extraction: typeof pendingExtraction,
    editedAttrs?: Record<string, unknown>
  ) => {
    if (!extraction) return
    removeCard('confirmation')

    // Get location if permitted (improves H3 matching)
    let coords: { lat?: number; lng?: number } = {}
    try {
      const { status } = await Location.getForegroundPermissionsAsync()
      if (status === 'granted') {
        const pos = await Location.getLastKnownPositionAsync()
        if (pos) coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }
      }
    } catch { /* location optional */ }

    addMessage({
      role: 'agent',
      card: { type: 'searching', data: { count: 0 } },
    })

    try {
      const result = await api.createRequest({
        rawDescription: (extraction.attributes?.raw as string) ?? '',
        categoryTags: extraction.categoryTags ?? [],
        attributes: { ...(extraction.attributes ?? {}), ...editedAttrs, ...followUpAnswers },
        bookingType: extraction.bookingTypeSuggestion ?? 'quote',
        idempotencyKey: `r_${Date.now()}`,
        ...coords,
      })

      setActiveRequest(result.id)
      removeCard('searching')

      if (result.matchedCount === 0) {
        addMessage({
          role: 'agent',
          text:
            "No vendors available for this in your area yet 😕\n\n" +
            "I've saved your request — I'll ping you the moment someone joins.",
        })
        return
      }

      addMessage({
        role: 'agent',
        text: `Found ${result.matchedCount} vendor${result.matchedCount > 1 ? 's' : ''} nearby — notifying them now ⚡\n\nI'll let you know as soon as someone quotes.`,
      })

      // Poll for quotes
      pollForQuotes(result.id)
    } catch {
      removeCard('searching')
      addMessage({ role: 'agent', text: "Something went wrong creating your request. Try again?" })
    }
  }

  // ─── Poll for incoming quotes ──────────────────────────────────────────────
  const pollForQuotes = (requestId: string) => {
    let attempts = 0
    // Explicitly typed: the callback references `interval` before the const is
    // initialised, so inference has nothing to work from (TS7022).
    const interval: ReturnType<typeof setInterval> = setInterval(async () => {
      attempts++
      if (attempts > 40) return clearInterval(interval) // stop after ~3 min

      try {
        const { quotes } = await api.getQuotes(requestId)
        if (quotes.length > 0) {
          clearInterval(interval)
          quotes.forEach((q) => {
            addMessage({
              role: 'agent',
              card: { type: 'quote', data: { ...q, requestId } },
            })
          })
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        }
      } catch { /* keep polling */ }
    }, 5000)
  }

  // ─── Accept a quote ────────────────────────────────────────────────────────
  const handleAcceptQuote = async (
    requestId: string,
    responseId: string,
    price: number,
    vendorName: string
  ) => {
    try {
      const res = await api.acceptQuote(requestId, responseId, price)
      if (!res.success) {
        addMessage({
          role: 'agent',
          text: "That quote was just taken by someone else 😬 Let me find more options...",
        })
        return
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      removeCard('quote')

      addMessage({
        role: 'agent',
        text: `Booked with ${vendorName} for ₹${price} ✅`,
        card: {
          type: 'job_tracker',
          data: {
            requestId,
            vendorName,
            price,
            stages: [
              { label: 'Request Sent', done: true },
              { label: 'Vendor Confirmed', done: true },
              { label: 'In Progress', done: false },
              { label: 'Completed', done: false },
            ],
          },
        },
      })
    } catch {
      addMessage({ role: 'agent', text: 'Could not confirm that booking. Try again?' })
    }
  }

  // ─── Render a card ─────────────────────────────────────────────────────────
  /** Send text as though the user typed it, so cards can drive the chat. */
  const sendAsUser = (text: string) => {
    setInput(text)
    // Defer so the controlled input has committed before handleSend reads it.
    setTimeout(() => { void handleSend() }, 0)
  }

  /** Resolve an ambiguity by tapping, with no typing required. */
  const selectBooking = async (bookingId: string, forIntent?: string) => {
    setTyping(true)
    try {
      const res = await api.chatSelect(bookingId, forIntent)
      addMessage({
        role: 'agent',
        text: res.message,
        card: { type: res.ui.type as CardType, data: res.ui.data },
        fromServer: true,
      })
    } catch {
      addMessage({ role: 'agent', text: "I couldn't open that booking." })
    } finally {
      setTyping(false)
    }
  }

  const renderCard = (msg: typeof messages[0]) => {
    const card = msg.card!
    const d = card.data as any

    // Server-chosen components go through the registry, which renders only
    // approved types and nothing at all for anything else.
    if (msg.fromServer) {
      return (
        <ServerCard
          type={card.type}
          data={card.data}
          onSend={sendAsUser}
          onSelectBooking={selectBooking}
          onChanged={invalidateBookings}
        />
      )
    }

    switch (card.type) {
      case 'confirmation':
        return (
          <ConfirmationCard
            attributes={d.attributes}
            attributeSchema={d.attributeSchema}
            categoryTags={d.categoryTags}
            onConfirm={(edited) => createAndMatch(pendingExtraction, edited)}
          />
        )

      case 'searching':
        return <SearchingCard count={d.count} />

      case 'category':
        return (
          <CategoryCard
            resolved={d.resolved}
            onConfirm={() => submitVendorProfile(d.rawDescription, d.extraction, d.resolved)}
          />
        )

      case 'follow_up':
        return (
          <FollowUpCard
            question={d.question}
            options={d.options ?? []}
            onAnswer={(answer) => handleFollowUpAnswer(d.question, answer)}
          />
        )

      case 'vendor_list':
        return (
          <VendorListCard
            vendors={d.vendors}
            onSelect={(vendorId) => {
              addMessage({
                role: 'agent',
                card: { type: 'slot_picker', data: { vendorId, requestId: activeRequestId } },
              })
            }}
          />
        )

      case 'quote':
        return (
          <QuoteCard
            {...d}
            onAccept={() =>
              handleAcceptQuote(d.requestId, d.responseId, d.quotedPrice, d.vendorName)
            }
            onCounter={(price: number) => {
              api.counterQuote(d.requestId, d.responseId, price)
              addMessage({ role: 'user', text: `Counter: ₹${price}` })
              addMessage({
                role: 'agent',
                text: `Sent your counter of ₹${price} to ${d.vendorName}. Waiting for their reply...`,
              })
            }}
          />
        )

      case 'slot_picker':
        return (
          <SlotPickerCard
            vendorId={d.vendorId}
            requestId={d.requestId}
            onBooked={(slotTime) => {
              removeCard('slot_picker')
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
              addMessage({
                role: 'agent',
                text: `Booked for ${slotTime} ✅\n\nYou'll get a reminder an hour before.`,
                card: {
                  type: 'job_tracker',
                  data: {
                    requestId: d.requestId,
                    stages: [
                      { label: 'Booked', done: true },
                      { label: 'Reminder Sent', done: false },
                      { label: 'In Progress', done: false },
                      { label: 'Completed', done: false },
                    ],
                  },
                },
              })
            }}
          />
        )

      case 'job_tracker':
        return (
          <JobTrackerCard
            {...d}
            onAdvance={async (stage) => {
              await api.advanceStage(d.requestId, stage)
              if (stage === 'completed') {
                removeCard('job_tracker')
                addMessage({
                  role: 'agent',
                  text: 'Job complete! How was it?',
                  card: {
                    type: 'review',
                    data: { requestId: d.requestId, vendorName: d.vendorName },
                  },
                })
              }
            }}
          />
        )

      case 'review':
        return (
          <ReviewCard
            vendorName={d.vendorName}
            onSubmit={async (rating, comment) => {
              await api.submitReview(d.requestId, rating, comment)
              removeCard('review')
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
              if (rating === 5) {
                addMessage({
                  role: 'agent',
                  text: 'Glad you loved it! 🎉',
                  card: {
                    type: 'rebook',
                    data: { vendorName: d.vendorName, vendorId: d.vendorId },
                  },
                })
              } else {
                addMessage({ role: 'agent', text: 'Thanks for the feedback 🙏' })
              }
            }}
          />
        )

      case 'rebook':
        return (
          <RebookCard
            vendorName={d.vendorName}
            onRebook={() => {
              removeCard('rebook')
              addMessage({ role: 'agent', text: `Let's book ${d.vendorName} again — when works for you?` })
            }}
            onDismiss={() => removeCard('rebook')}
          />
        )

      default:
        return null
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      {/* Header - Floating Glass */}
      <View style={[styles.headerWrapper, { paddingTop: insets.top }]}>
        <GlassView style={styles.header} intensity={40}>
          <View style={styles.logoRow}>
            <View style={[styles.logoDot, { backgroundColor: colors.accent }]} />
            <Text style={[styles.logo, { color: colors.text }]}>locogi</Text>
          </View>
          <View style={styles.headerActions}>
            {role === 'vendor' || role === 'both' ? (
              <Pressable
                onPress={() => navigation.navigate('VendorInbox')}
                style={styles.iconBtn}
                hitSlop={8}
              >
                <Text style={styles.iconTxt}>📬</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => navigation.navigate('History')}
              style={styles.iconBtn}
              hitSlop={8}
            >
              <Text style={styles.iconTxt}>🕘</Text>
            </Pressable>
            <Pressable
              onPress={() => navigation.navigate('Settings')}
              style={[styles.avatar, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
              hitSlop={8}
            >
              <Text style={styles.avatarTxt}>
                {role === 'vendor' ? '🛠' : '👤'}
              </Text>
            </Pressable>
          </View>
        </GlassView>
      </View>

      {/* Chat thread */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.thread}
          contentContainerStyle={[styles.threadContent, { paddingTop: insets.top + 70 }]}
          keyboardDismissMode="interactive"
          indicatorStyle={colors.bg === '#000000' ? 'white' : 'black'}
        >
          {messages.map((msg) => (
            <View key={msg.id}>
              {msg.text ? (
                <View
                  style={[
                    styles.bubble,
                    msg.role === 'user' ? [styles.bubbleUser, { backgroundColor: colors.accent }] : [styles.bubbleAgent, { backgroundColor: colors.surface }],
                  ]}
                >
                  <Text
                    style={[
                      styles.bubbleTxt,
                      { color: msg.role === 'user' ? '#FFFFFF' : colors.text },
                      msg.role === 'user' && { fontWeight: '500' },
                    ]}
                  >
                    {msg.text}
                  </Text>
                </View>
              ) : null}
              {msg.card ? <View style={styles.cardWrap}>{renderCard(msg)}</View> : null}
            </View>
          ))}

          {isAgentTyping ? <TypingIndicator /> : null}
        </ScrollView>

        {/* Input bar */}
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: Math.max(insets.bottom, spacing.sm), paddingTop: spacing.sm, backgroundColor: 'transparent' }}>
          <GlassView style={styles.inputContainer} intensity={40}>
            <TextInput
              style={[styles.input, { color: colors.text }]}
              value={input}
              onChangeText={setInput}
              placeholder={
                role === 'vendor'
                  ? 'Describe your services...'
                  : 'What do you need?'
              }
              placeholderTextColor={colors.textTertiary}
              multiline
              maxLength={2000}
              onSubmitEditing={handleSend}
            />
            <Pressable
              onPress={handleSend}
              disabled={!input.trim()}
              style={[
                styles.sendBtn, 
                { backgroundColor: input.trim() ? colors.accent : colors.surface }
              ]}
            >
              <Text style={[styles.sendTxt, { color: input.trim() ? '#FFFFFF' : colors.textTertiary }]}>↑</Text>
            </Pressable>
          </GlassView>
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  headerWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  logoDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  logo: {
    ...typography.h3,
    letterSpacing: -0.5,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconTxt: { fontSize: 18 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  avatarTxt: { fontSize: 16 },

  thread: { flex: 1 },
  threadContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },

  bubble: {
    maxWidth: '86%',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xl,
    marginBottom: spacing.xs,
  },
  bubbleAgent: {
    alignSelf: 'flex-start',
    borderTopLeftRadius: radius.sm,
    // Soft shadow for depth
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 5,
    elevation: 1,
  },
  bubbleUser: {
    alignSelf: 'flex-end',
    borderTopRightRadius: radius.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 5,
    elevation: 2,
  },
  bubbleTxt: { ...typography.body },

  cardWrap: { marginTop: spacing.sm, marginBottom: spacing.sm },

  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    // Add subtle shadow for the floating composer
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 4,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    ...typography.body,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendTxt: { fontSize: 18, fontWeight: '700' },
})
