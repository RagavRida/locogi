/**
 * The realtime connection.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SOCKET IS A NUDGE, NOT A DATA SOURCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A message says "booking X changed". This hook invalidates the cache and the
 * card refetches through the normal authorized API. Nothing renders from the
 * socket payload.
 *
 * That is what makes reconnection simple. There is no missed-event problem to
 * solve, no replay cursor, no sequence numbers — a client that was offline
 * for an hour just refetches on reconnect and is correct. Trying to deliver
 * every event reliably over a socket means an ack protocol and a per-client
 * outbox, to reproduce what one HTTP GET already does.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RECONNECTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Exponential backoff with jitter. Jitter matters more than it looks: without
 * it, every client disconnected by the same server restart reconnects at the
 * same instant and knocks it over again.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import type { WsServerMessage, WsTopic } from '@locogi/types'

const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string) ?? 'http://localhost:3000'

/** The socket is NOT versioned — see UNVERSIONED_MODULES in the API. */
const WS_URL = API_URL.replace(/^http/, 'ws') + '/ws'

const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
/** Must be comfortably under the server's 90s idle timeout. */
const PING_INTERVAL_MS = 25_000

type Listener = (message: WsServerMessage) => void

/**
 * One socket for the whole app, not one per component.
 *
 * Several cards can be on screen watching different bookings; each opening
 * its own connection would multiply server sockets by the number of visible
 * cards for no benefit.
 */
class RealtimeClient {
  private socket: WebSocket | null = null
  private listeners = new Set<Listener>()
  private topics = new Set<string>()
  private attempts = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUs = false

  private topicOf(key: string): WsTopic {
    const [kind, ...rest] = key.split(':')
    return { kind: kind as WsTopic['kind'], id: rest.join(':') }
  }

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return

    const token = await SecureStore.getItemAsync('access_token').catch(() => null)
    if (!token) return // not signed in; nothing to listen for

    this.closedByUs = false

    // Token in the query string: React Native's WebSocket cannot set headers
    // on the handshake. Short-lived access token, never the refresh token.
    const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`)
    this.socket = socket

    socket.onopen = () => {
      this.attempts = 0
      // Re-subscribe everything: the server holds subscriptions per
      // connection, so a new connection starts with none.
      for (const key of this.topics) {
        this.send({ action: 'subscribe', topic: this.topicOf(key) })
      }
      this.startPing()
    }

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as WsServerMessage
        for (const listener of this.listeners) listener(message)
      } catch {
        // A frame we cannot parse is not worth crashing the app over.
      }
    }

    socket.onerror = () => {
      // onclose always follows; reconnection is handled there so it is not
      // scheduled twice.
    }

    socket.onclose = (event) => {
      this.stopPing()
      this.socket = null

      // 1008 is our "unauthorized". Retrying with the same bad token would
      // loop forever, so stop and let the next sign-in reconnect.
      if (this.closedByUs || event.code === 1008) return

      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** this.attempts, MAX_BACKOFF_MS)
    // Jitter: without it, every client dropped by one server restart comes
    // back at the same millisecond.
    const delay = backoff * (0.5 + Math.random() * 0.5)
    this.attempts++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      this.send({ action: 'ping' })
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload))
    }
  }

  subscribe(topic: WsTopic): void {
    const key = `${topic.kind}:${topic.id}`
    this.topics.add(key)
    this.send({ action: 'subscribe', topic })
    void this.connect()
  }

  unsubscribe(topic: WsTopic): void {
    const key = `${topic.kind}:${topic.id}`
    this.topics.delete(key)
    this.send({ action: 'unsubscribe', topic })
  }

  addListener(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  disconnect(): void {
    this.closedByUs = true
    this.stopPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.close(1000, 'client closed')
    this.socket = null
  }

  /** Backgrounded apps get their sockets killed by the OS anyway. */
  handleAppState(state: AppStateStatus): void {
    if (state === 'active') void this.connect()
  }
}

export const realtimeClient = new RealtimeClient()

/**
 * Watch a topic and be told when to refetch.
 *
 * `onChange` fires with the message so a caller can read a phase hint, but it
 * must not treat any of it as state — refetch instead.
 */
export function useRealtimeTopic(
  topic: WsTopic | null,
  onChange: (message: WsServerMessage) => void
): void {
  // Kept in a ref so a caller passing an inline arrow does not resubscribe on
  // every render.
  const handler = useRef(onChange)
  handler.current = onChange

  const key = topic ? `${topic.kind}:${topic.id}` : null

  useEffect(() => {
    if (!topic || !key) return

    realtimeClient.subscribe(topic)

    const remove = realtimeClient.addListener((message) => {
      if (!message.topic) return
      if (`${message.topic.kind}:${message.topic.id}` !== key) return
      handler.current(message)
    })

    return () => {
      remove()
      realtimeClient.unsubscribe(topic)
    }
  }, [key])
}

/** Mount once, near the root. Keeps the socket alive across the app. */
export function useRealtimeConnection(isAuthenticated: boolean): boolean {
  const [connected, setConnected] = useState(false)

  const onMessage = useCallback(() => setConnected(true), [])

  useEffect(() => {
    if (!isAuthenticated) {
      realtimeClient.disconnect()
      setConnected(false)
      return
    }

    void realtimeClient.connect()
    const remove = realtimeClient.addListener(onMessage)

    const sub = AppState.addEventListener('change', (s) =>
      realtimeClient.handleAppState(s)
    )

    return () => {
      remove()
      sub.remove()
    }
  }, [isAuthenticated, onMessage])

  return connected
}
