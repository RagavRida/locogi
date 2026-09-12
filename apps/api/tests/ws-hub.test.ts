/**
 * The realtime hub.
 *
 * No server, no Redis — the hub takes a `Sendable` and a publisher interface,
 * so all of this runs against fakes. That matters because the bugs worth
 * catching here are invisible in manual testing: index leaks that only show
 * after thousands of connections, and double-delivery that only appears when
 * publisher and subscriber share an instance.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  WebSocketHub,
  WS_OPEN,
  topicKey,
  MAX_TOPICS_PER_CONNECTION,
  REDIS_CHANNEL,
  type Sendable,
  type WireEnvelope,
} from '../src/lib/ws-hub'
import type { WsServerMessage } from '@locogi/types'

function fakeSocket(readyState = WS_OPEN) {
  return {
    sent: [] as string[],
    closed: null as { code?: number; reason?: string } | null,
    readyState,
    send(data: string) {
      this.sent.push(data)
    },
    close(code?: number, reason?: string) {
      this.closed = { code, reason }
      this.readyState = 3 // CLOSED
    },
  }
}

function msg(over: Partial<WsServerMessage> = {}): WsServerMessage {
  return { type: 'booking.changed', ts: new Date().toISOString(), ...over }
}

let hub: WebSocketHub

beforeEach(() => {
  hub = new WebSocketHub()
})

// ═════════════════════════════════════════════════════════════════════════════

describe('connection lifecycle', () => {
  it('tracks a connection', () => {
    const s = fakeSocket()
    const conn = hub.add('u1', s)

    expect(hub.get(conn.id)).toBeDefined()
    expect(hub.stats().connections).toBe(1)
    expect(hub.stats().users).toBe(1)
  })

  it('supports several devices for one user', () => {
    hub.add('u1', fakeSocket())
    hub.add('u1', fakeSocket())

    expect(hub.stats().connections).toBe(2)
    expect(hub.stats().users).toBe(1)
  })

  it('leaves no index entries behind on remove', () => {
    // The leak that matters: a stale id in byTopic makes every future fan-out
    // on that topic do a lookup that misses, and the sets grow forever.
    const conn = hub.add('u1', fakeSocket())
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })
    hub.subscribe(conn.id, { kind: 'tracking', id: 'b1' })

    expect(hub.stats().topics).toBe(2)

    hub.remove(conn.id)

    expect(hub.stats()).toEqual({ connections: 0, users: 0, topics: 0 })
  })

  it('keeps a topic alive while another subscriber remains', () => {
    const a = hub.add('u1', fakeSocket())
    const b = hub.add('u2', fakeSocket())
    hub.subscribe(a.id, { kind: 'booking', id: 'b1' })
    hub.subscribe(b.id, { kind: 'booking', id: 'b1' })

    hub.remove(a.id)
    expect(hub.stats().topics).toBe(1)
  })

  it('ignores removal of an unknown connection', () => {
    expect(() => hub.remove('nope')).not.toThrow()
  })
})

describe('subscriptions', () => {
  it('refuses to subscribe an unknown connection', () => {
    expect(hub.subscribe('nope', { kind: 'booking', id: 'b1' })).toBe(false)
  })

  it('dedupes repeated subscribes', () => {
    const conn = hub.add('u1', fakeSocket())
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })

    expect(hub.get(conn.id)!.topics.size).toBe(1)
  })

  it('caps topics per connection', () => {
    // Subscribing is free for the client and costs the server a set entry.
    // Without a cap that is a memory attack.
    const conn = hub.add('u1', fakeSocket())
    for (let i = 0; i < MAX_TOPICS_PER_CONNECTION; i++) {
      expect(hub.subscribe(conn.id, { kind: 'booking', id: `b${i}` })).toBe(true)
    }
    expect(hub.subscribe(conn.id, { kind: 'booking', id: 'one-too-many' })).toBe(false)
  })

  it('distinguishes topic kinds on the same id', () => {
    expect(topicKey({ kind: 'booking', id: 'x' })).not.toBe(
      topicKey({ kind: 'tracking', id: 'x' })
    )
  })
})

describe('delivery — the authorization boundary', () => {
  it('delivers to a subscribed connection in the audience', () => {
    const s = fakeSocket()
    const conn = hub.add('u1', s)
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })

    const sent = hub.deliverLocal({
      audience: ['u1'],
      message: msg({ topic: { kind: 'booking', id: 'b1' } }),
    })

    expect(sent).toBe(1)
    expect(s.sent).toHaveLength(1)
  })

  it('does NOT deliver to a subscriber outside the audience', () => {
    // The attack this blocks: a client subscribes to a guessed booking id.
    // The topic index would match; the audience check is what saves us.
    const s = fakeSocket()
    const attacker = hub.add('attacker', s)
    hub.subscribe(attacker.id, { kind: 'booking', id: 'someone-elses-booking' })

    const sent = hub.deliverLocal({
      audience: ['legitimate-owner'],
      message: msg({ topic: { kind: 'booking', id: 'someone-elses-booking' } }),
    })

    expect(sent).toBe(0)
    expect(s.sent).toHaveLength(0)
  })

  it('does not deliver to someone in the audience who never subscribed', () => {
    const s = fakeSocket()
    hub.add('u1', s)

    const sent = hub.deliverLocal({
      audience: ['u1'],
      message: msg({ topic: { kind: 'booking', id: 'b1' } }),
    })

    expect(sent).toBe(0)
  })

  it('skips a socket that is not open', () => {
    const s = fakeSocket(3 /* CLOSED */)
    const conn = hub.add('u1', s)
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })

    expect(
      hub.deliverLocal({
        audience: ['u1'],
        message: msg({ topic: { kind: 'booking', id: 'b1' } }),
      })
    ).toBe(0)
  })

  it('drops a connection whose send throws', () => {
    const conn = hub.add('u1', {
      readyState: WS_OPEN,
      send() {
        throw new Error('EPIPE')
      },
      close() {},
    } as Sendable)
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })

    hub.deliverLocal({
      audience: ['u1'],
      message: msg({ topic: { kind: 'booking', id: 'b1' } }),
    })

    // Not left in the maps to fail again on every future publish.
    expect(hub.stats().connections).toBe(0)
  })

  it('reaches every device a user has', () => {
    const a = fakeSocket()
    const b = fakeSocket()
    const ca = hub.add('u1', a)
    const cb = hub.add('u1', b)
    hub.subscribe(ca.id, { kind: 'booking', id: 'b1' })
    hub.subscribe(cb.id, { kind: 'booking', id: 'b1' })

    expect(
      hub.deliverLocal({
        audience: ['u1'],
        message: msg({ topic: { kind: 'booking', id: 'b1' } }),
      })
    ).toBe(2)
  })

  it('broadcasts a topicless message to all of a user\'s connections', () => {
    const s = fakeSocket()
    hub.add('u1', s) // no subscription at all
    hub.add('u2', fakeSocket())

    const sent = hub.deliverLocal({ audience: ['u1'], message: msg({ type: 'pong' }) })

    expect(sent).toBe(1)
  })
})

describe('cross-instance publishing', () => {
  it('goes through Redis rather than delivering locally', async () => {
    // Delivering locally AS WELL as publishing would double-send whenever the
    // publisher and subscriber share an instance — a bug that only appears in
    // production, intermittently, for some users.
    const publisher = { publish: vi.fn().mockResolvedValue(1) }
    hub.setPublisher(publisher)

    const s = fakeSocket()
    const conn = hub.add('u1', s)
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })

    await hub.publish(['u1'], msg({ topic: { kind: 'booking', id: 'b1' } }))

    expect(publisher.publish).toHaveBeenCalledOnce()
    expect(publisher.publish.mock.calls[0][0]).toBe(REDIS_CHANNEL)
    // NOT sent directly — it will arrive back via the Redis subscription.
    expect(s.sent).toHaveLength(0)
  })

  it('delivers the envelope that comes back from Redis exactly once', async () => {
    const publisher = { publish: vi.fn().mockResolvedValue(1) }
    hub.setPublisher(publisher)

    const s = fakeSocket()
    const conn = hub.add('u1', s)
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })

    await hub.publish(['u1'], msg({ topic: { kind: 'booking', id: 'b1' } }))

    // Simulate the Redis subscriber handing it back.
    const envelope: WireEnvelope = JSON.parse(publisher.publish.mock.calls[0][1])
    hub.deliverLocal(envelope)

    expect(s.sent).toHaveLength(1)
  })

  it('falls back to local delivery when there is no publisher', async () => {
    // Single-process dev, where double delivery is impossible anyway.
    const s = fakeSocket()
    const conn = hub.add('u1', s)
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })

    await hub.publish(['u1'], msg({ topic: { kind: 'booking', id: 'b1' } }))
    expect(s.sent).toHaveLength(1)
  })

  it('falls back to local delivery when Redis publish throws', async () => {
    // Realtime is an enhancement. A Redis outage must not fail the caller's
    // request, and whoever is local should still get their nudge.
    hub.setPublisher({ publish: vi.fn().mockRejectedValue(new Error('down')) })

    const s = fakeSocket()
    const conn = hub.add('u1', s)
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })

    await expect(
      hub.publish(['u1'], msg({ topic: { kind: 'booking', id: 'b1' } }))
    ).resolves.toBeUndefined()
    expect(s.sent).toHaveLength(1)
  })

  it('does nothing for an empty audience', async () => {
    const publisher = { publish: vi.fn() }
    hub.setPublisher(publisher)
    await hub.publish([], msg())
    expect(publisher.publish).not.toHaveBeenCalled()
  })
})

describe('liveness', () => {
  it('reaps a connection that has gone quiet', () => {
    const s = fakeSocket()
    const conn = hub.add('u1', s)

    // A phone that lost signal in a lift keeps a TCP connection "open" for a
    // long time. Without reaping, those accumulate.
    const later = Date.now() + 120_000
    expect(hub.reapStale(60_000, later)).toBe(1)
    expect(hub.stats().connections).toBe(0)
    expect(s.closed?.code).toBe(1001)
  })

  it('keeps a connection that recently spoke', () => {
    const conn = hub.add('u1', fakeSocket())
    hub.touch(conn.id)

    expect(hub.reapStale(60_000, Date.now() + 1_000)).toBe(0)
    expect(hub.stats().connections).toBe(1)
  })

  it('cleans indexes when reaping', () => {
    const conn = hub.add('u1', fakeSocket())
    hub.subscribe(conn.id, { kind: 'booking', id: 'b1' })

    hub.reapStale(0, Date.now() + 1)
    expect(hub.stats()).toEqual({ connections: 0, users: 0, topics: 0 })
  })
})

describe('closeUser', () => {
  it('disconnects every session for a user', () => {
    // Used when an account is banned or logs out everywhere — a live socket
    // must not outlive the authorization that created it.
    const a = fakeSocket()
    const b = fakeSocket()
    hub.add('u1', a)
    hub.add('u1', b)
    hub.add('u2', fakeSocket())

    expect(hub.closeUser('u1')).toBe(2)
    expect(hub.stats().connections).toBe(1)
    expect(a.closed?.code).toBe(1008)
  })

  it('is a no-op for a user with no connections', () => {
    expect(hub.closeUser('nobody')).toBe(0)
  })
})
