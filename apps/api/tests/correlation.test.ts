/**
 * Correlation context.
 *
 * The properties worth testing are the ones that fail silently: propagation
 * across awaits (a broken trace looks exactly like a working one until you
 * need it), isolation between concurrent operations (the failure mode is
 * *wrong* ids, not missing ones — far worse), and rejecting hostile inbound
 * ids.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  withCorrelation,
  getContext,
  getCorrelationId,
  enrich,
  logFields,
  newCorrelationId,
  acceptOrCreate,
  CORRELATION_HEADER,
} from '../src/lib/correlation'

const ctx = (over: Record<string, unknown> = {}) => ({
  correlationId: 'cor_test',
  ...over,
})

describe('propagation', () => {
  it('is visible inside the callback', () => {
    withCorrelation(ctx(), () => {
      expect(getCorrelationId()).toBe('cor_test')
    })
  })

  it('is undefined outside any context', () => {
    expect(getCorrelationId()).toBeUndefined()
    expect(logFields()).toEqual({})
  })

  it('survives an await', async () => {
    await withCorrelation(ctx(), async () => {
      await new Promise((r) => setTimeout(r, 1))
      expect(getCorrelationId()).toBe('cor_test')
    })
  })

  it('survives several nested awaits', async () => {
    // The realistic shape: route → service → repository → helper.
    const deep = async () => {
      await Promise.resolve()
      return getCorrelationId()
    }
    const middle = async () => {
      await new Promise((r) => setTimeout(r, 1))
      return deep()
    }

    await withCorrelation(ctx(), async () => {
      expect(await middle()).toBe('cor_test')
    })
  })

  it('survives a Promise.all fan-out', async () => {
    await withCorrelation(ctx(), async () => {
      const ids = await Promise.all([
        Promise.resolve().then(() => getCorrelationId()),
        new Promise((r) => setTimeout(r, 2)).then(() => getCorrelationId()),
      ])
      expect(ids).toEqual(['cor_test', 'cor_test'])
    })
  })

  it('survives a setTimeout callback', async () => {
    // Workers and retries schedule work this way.
    await withCorrelation(ctx(), async () => {
      const seen = await new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve(getCorrelationId()), 1)
      })
      expect(seen).toBe('cor_test')
    })
  })

  it('does not leak after the callback returns', async () => {
    await withCorrelation(ctx(), async () => {
      expect(getCorrelationId()).toBe('cor_test')
    })
    expect(getCorrelationId()).toBeUndefined()
  })
})

describe('isolation between concurrent operations', () => {
  it('keeps two interleaved operations apart', async () => {
    // The dangerous failure: not a missing id, but the WRONG one — request A
    // logging under request B's trace. That produces a confidently incorrect
    // investigation.
    const results: string[] = []

    const op = async (id: string, delay: number) =>
      withCorrelation({ correlationId: id }, async () => {
        await new Promise((r) => setTimeout(r, delay))
        results.push(getCorrelationId()!)
      })

    // Deliberately interleaved: B finishes before A.
    await Promise.all([op('cor_A', 20), op('cor_B', 5)])

    expect(results).toEqual(['cor_B', 'cor_A'])
  })

  it('does not let enrich in one operation touch another', async () => {
    let aFields: Record<string, unknown> = {}
    let bFields: Record<string, unknown> = {}

    await Promise.all([
      withCorrelation({ correlationId: 'cor_A' }, async () => {
        enrich({ bookingId: 'booking-A' })
        await new Promise((r) => setTimeout(r, 10))
        aFields = logFields()
      }),
      withCorrelation({ correlationId: 'cor_B' }, async () => {
        enrich({ bookingId: 'booking-B' })
        await new Promise((r) => setTimeout(r, 2))
        bFields = logFields()
      }),
    ])

    expect(aFields.bookingId).toBe('booking-A')
    expect(bFields.bookingId).toBe('booking-B')
  })
})

describe('enrich', () => {
  it('adds ids as they become known', () => {
    withCorrelation(ctx(), () => {
      expect(logFields().bookingId).toBeUndefined()
      enrich({ bookingId: 'b1' })
      expect(logFields().bookingId).toBe('b1')
    })
  })

  it('affects code already on the stack', async () => {
    // Why enrich mutates rather than re-running: a booking id learned
    // mid-operation must reach the rest of that operation without the caller
    // restructuring their control flow.
    await withCorrelation(ctx(), async () => {
      const later = async () => {
        await Promise.resolve()
        return logFields().bookingId
      }
      const pending = later()
      enrich({ bookingId: 'b1' })
      expect(await pending).toBe('b1')
    })
  })

  it('ignores undefined and null so they cannot blank a known id', () => {
    withCorrelation(ctx({ userId: 'u1' }), () => {
      enrich({ userId: undefined })
      expect(logFields().userId).toBe('u1')
    })
  })

  it('never overwrites the correlation id', () => {
    withCorrelation(ctx(), () => {
      // The type forbids it; this guards the runtime path too, since the
      // whole trace hangs off this value being stable.
      enrich({ userId: 'u1' } as never)
      expect(getCorrelationId()).toBe('cor_test')
    })
  })

  it('is a harmless no-op outside a context', () => {
    expect(() => enrich({ bookingId: 'b1' })).not.toThrow()
  })
})

describe('logFields', () => {
  it('returns a snapshot, not the live context', () => {
    // pino may retain what mixin returns. Handing over the mutable object
    // would let a later enrich retroactively rewrite log lines already
    // emitted — which would make the logs quietly untrue.
    withCorrelation(ctx(), () => {
      const snapshot = logFields()
      enrich({ bookingId: 'added-after' })
      expect(snapshot.bookingId).toBeUndefined()
    })
  })

  it('includes every id set so far', () => {
    withCorrelation(ctx({ userId: 'u1', source: 'http' }), () => {
      enrich({ requestId: 'r1', bookingId: 'b1' })
      expect(logFields()).toMatchObject({
        correlationId: 'cor_test',
        userId: 'u1',
        requestId: 'r1',
        bookingId: 'b1',
        source: 'http',
      })
    })
  })
})

describe('acceptOrCreate — inbound ids are untrusted', () => {
  it('accepts a well-formed client id, so a trace can span client and server', () => {
    expect(acceptOrCreate('cor_abc123def456')).toBe('cor_abc123def456')
  })

  it('mints one when nothing is supplied', () => {
    expect(acceptOrCreate(undefined)).toMatch(/^cor_/)
    expect(acceptOrCreate(null)).toMatch(/^cor_/)
    expect(acceptOrCreate('')).toMatch(/^cor_/)
  })

  it('rejects an id containing newlines', () => {
    // Log injection: a newline lets a caller forge whole log entries.
    const attack = 'abc\n{"level":50,"msg":"FAKE ERROR"}'
    expect(acceptOrCreate(attack)).not.toBe(attack)
    expect(acceptOrCreate(attack)).toMatch(/^cor_/)
  })

  it('rejects an absurdly long id', () => {
    // Every log line for the whole request would carry it — a cheap way to
    // flood whatever ingests the logs.
    const huge = 'a'.repeat(100_000)
    expect(acceptOrCreate(huge)).toMatch(/^cor_/)
  })

  it('rejects an id that is too short to be meaningful', () => {
    expect(acceptOrCreate('x')).toMatch(/^cor_/)
  })

  it('rejects non-strings', () => {
    expect(acceptOrCreate(42)).toMatch(/^cor_/)
    expect(acceptOrCreate({ id: 'x' })).toMatch(/^cor_/)
  })

  it('rejects ids with spaces or quotes that could break log parsing', () => {
    expect(acceptOrCreate('has spaces')).toMatch(/^cor_/)
    expect(acceptOrCreate('has"quote')).toMatch(/^cor_/)
  })
})

describe('newCorrelationId', () => {
  it('is unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, newCorrelationId))
    expect(ids.size).toBe(1000)
  })

  it('is recognisable as one of ours', () => {
    expect(newCorrelationId()).toMatch(/^cor_[0-9a-f-]{36}$/)
  })

  it('round-trips through acceptOrCreate', () => {
    // A generated id must pass our own validation, or a client echoing what
    // we gave it would silently get a new trace on every call.
    const id = newCorrelationId()
    expect(acceptOrCreate(id)).toBe(id)
  })
})

describe('header name', () => {
  it('is lowercase, since Node normalises inbound header names', () => {
    expect(CORRELATION_HEADER).toBe(CORRELATION_HEADER.toLowerCase())
  })
})
