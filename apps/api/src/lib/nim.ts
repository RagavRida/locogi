import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractionResult } from '@locogi/types'
import { logger } from './logger'

// OpenAI-compatible client — supports 3 backends:
//   1. OpenRouter (preferred) — any model, no project restrictions
//   2. OpenAI direct — if OPENAI_API_KEY set
//   3. NVIDIA NIM — if NIM_API_KEY set
//
// Constructed lazily, not at import time. Eager construction meant that ANY
// module transitively importing this one — including the deterministic safety
// ruleset, which must never touch the network — needed an API key present
// merely to be loaded. That made the safety tests unrunnable without a live
// API key, and turned a missing env var into a crash at an unrelated import
// rather than a clear failure at the point of use.
let client: OpenAI | null = null

type LlmBackend = 'openrouter' | 'openai' | 'nim'

function detectBackend(): { backend: LlmBackend; apiKey: string } {
  if (process.env.OPENROUTER_API_KEY) {
    return { backend: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY }
  }
  if (process.env.OPENAI_API_KEY) {
    return { backend: 'openai', apiKey: process.env.OPENAI_API_KEY }
  }
  if (process.env.NIM_API_KEY) {
    return { backend: 'nim', apiKey: process.env.NIM_API_KEY }
  }
  throw new Error(
    'No LLM API key set. Set OPENROUTER_API_KEY, OPENAI_API_KEY, or NIM_API_KEY.'
  )
}

function llmClient(): OpenAI {
  if (client) return client

  const { backend, apiKey } = detectBackend()

  const config: Record<LlmBackend, { baseURL?: string; defaultHeaders?: Record<string, string> }> = {
    openrouter: {
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://locogi.com',
        'X-Title': 'Locogi — ChatGPT for local services',
      },
    },
    openai: {},
    nim: { baseURL: 'https://integrate.api.nvidia.com/v1' },
  }

  client = new OpenAI({
    apiKey,
    ...config[backend],
  })

  logger.info({ backend }, 'LLM client initialized')
  return client
}

// Model selection: env override > backend default
const MODEL_DEFAULTS: Record<LlmBackend, string> = {
  openrouter: 'openai/gpt-4.1',       // OpenRouter prefixes provider
  openai: 'gpt-4.1',
  nim: 'meta/llama-3.1-70b-instruct',
}

const { backend: activeBackend } = (() => {
  try { return detectBackend() } catch { return { backend: 'openai' as LlmBackend } }
})()

const LLM_MODEL = process.env.LLM_MODEL ?? MODEL_DEFAULTS[activeBackend]
const EMBED_MODEL = process.env.EMBED_MODEL ?? (activeBackend === 'nim' ? 'nvidia/nv-embed-v1' : 'text-embedding-3-small')
const EMBED_DIMENSIONS = 1536

// ─── Extraction Schema ────────────────────────────────────────────────────────
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await llmClient().embeddings.create({
    model: EMBED_MODEL,
    input: text,
    dimensions: EMBED_DIMENSIONS,
    encoding_format: 'float',
  } as Parameters<OpenAI['embeddings']['create']>[0])

  return response.data[0]?.embedding ?? []
}

// ─── Agent Chat (for conversational flows) ───────────────────────────────────
/** The shape the AI contract layer speaks in, so it need not import OpenAI. */
export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam

/**
 * One model call, returning the FULL completion.
 *
 * Replaced `agentChat`, which returned only `choices[0]` — throwing away
 * `usage`, so no caller could log what a call cost, and none did. It also had
 * no way to be cancelled, so a hung request held a worker until the socket
 * gave up. `runTask` needs both.
 */
export async function chatRaw(params: {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}): Promise<OpenAI.Chat.ChatCompletion> {
  return llmClient().chat.completions.create(
    {
      model: LLM_MODEL,
      messages: params.messages,
      temperature: params.temperature ?? 0.3,
      max_tokens: params.maxTokens ?? 1000,
    },
    { signal: params.signal }
  )
}

// ─── Emergency check ─────────────────────────────────────────────────────────
const EMERGENCY_KEYWORDS = [
  'help me', 'emergency', 'accident', 'danger', 'hurt',
  'hospital', 'police', '100', '112', 'injured', 'attacked',
  'bachao', 'help karo', 'danger lo unna',
]

export function checkEmergencyFlags(text: string): {
  isEmergency: boolean
  response?: string
} {
  const lower = text.toLowerCase()
  const isEmergency = EMERGENCY_KEYWORDS.some((kw) => lower.includes(kw))
  if (isEmergency) {
    return {
      isEmergency: true,
      response:
        '🚨 This sounds like an emergency. Please call:\n' +
        '• Police: 100\n• Emergency: 112\n• Ambulance: 108\n\n' +
        'Are you safe? Reply YES or NO.',
    }
  }
  return { isEmergency: false }
}
