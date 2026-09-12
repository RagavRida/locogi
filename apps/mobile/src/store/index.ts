import { create } from 'zustand'
import type { ExtractionResult, Quote, Vendor, Slot } from '../api/client'
import type { UIComponentType } from '@locogi/types'

// ─── Chat message types ───────────────────────────────────────────────────────
//
// The card vocabulary now lives in @locogi/types so the server and the client
// cannot disagree about it. `CardType` stays exported under its original name
// because the existing screen and its handlers reference it throughout, and
// renaming it would be churn for no gain.
export type CardType = UIComponentType

export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  text?: string
  card?: {
    type: CardType
    data: Record<string, unknown>
  }
  /**
   * True when the SERVER chose this component.
   *
   * Server-driven cards render through the registry, which only knows about an
   * approved set. Client-created cards keep going through ChatScreen's switch,
   * because they close over handlers that only exist in that screen. The flag
   * is what keeps the two populations apart.
   */
  fromServer?: boolean
  timestamp: number
}

interface AppState {
  // Auth
  isAuthenticated: boolean
  userId: string | null
  role: 'customer' | 'vendor' | 'both' | null

  // Chat
  messages: ChatMessage[]
  isAgentTyping: boolean

  // Active flow
  activeRequestId: string | null
  pendingExtraction: ExtractionResult | null
  pendingFollowUps: string[]
  followUpAnswers: Record<string, string>

  // Actions
  setAuth: (userId: string, role: 'customer' | 'vendor' | 'both' | null) => void
  logout: () => void
  addMessage: (msg: Omit<ChatMessage, 'id' | 'timestamp'>) => void
  updateLastCard: (data: Record<string, unknown>) => void
  removeCard: (type: CardType) => void
  setTyping: (typing: boolean) => void
  setActiveRequest: (id: string | null) => void
  setPendingExtraction: (e: ExtractionResult | null) => void
  setFollowUps: (qs: string[]) => void
  answerFollowUp: (question: string, answer: string) => void
  clearChat: () => void
}

let msgCounter = 0
const nextId = () => `m_${Date.now()}_${msgCounter++}`

export const useStore = create<AppState>((set, get) => ({
  isAuthenticated: false,
  userId: null,
  role: null,

  messages: [],
  isAgentTyping: false,

  activeRequestId: null,
  pendingExtraction: null,
  pendingFollowUps: [],
  followUpAnswers: {},

  setAuth: (userId, role) =>
    set({ isAuthenticated: true, userId, role }),

  logout: () =>
    set({
      isAuthenticated: false,
      userId: null,
      role: null,
      messages: [],
      activeRequestId: null,
    }),

  addMessage: (msg) =>
    set((s) => ({
      messages: [...s.messages, { ...msg, id: nextId(), timestamp: Date.now() }],
    })),

  updateLastCard: (data) =>
    set((s) => {
      const msgs = [...s.messages]
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].card) {
          msgs[i] = {
            ...msgs[i],
            card: { ...msgs[i].card!, data: { ...msgs[i].card!.data, ...data } },
          }
          break
        }
      }
      return { messages: msgs }
    }),

  removeCard: (type) =>
    set((s) => ({
      messages: s.messages.filter((m) => m.card?.type !== type),
    })),

  setTyping: (isAgentTyping) => set({ isAgentTyping }),
  setActiveRequest: (activeRequestId) => set({ activeRequestId }),
  setPendingExtraction: (pendingExtraction) => set({ pendingExtraction }),
  setFollowUps: (pendingFollowUps) => set({ pendingFollowUps }),

  answerFollowUp: (question, answer) =>
    set((s) => ({
      followUpAnswers: { ...s.followUpAnswers, [question]: answer },
      pendingFollowUps: s.pendingFollowUps.filter((q) => q !== question),
    })),

  clearChat: () => set({ messages: [], activeRequestId: null, pendingExtraction: null }),
}))
