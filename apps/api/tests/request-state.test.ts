/**
 * Tests for the request lifecycle graph.
 *
 * These run with no database and no network — the graph is a pure module, so
 * there is no excuse for it to be untested. That matters more than usual here
 * because this graph now generates the WHERE clause of every status UPDATE in
 * the system: a wrong edge is not a cosmetic error, it either blocks a legal
 * booking or permits an illegal one.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSql } from '../scripts/generate-state-sql'
import {
  REQUEST_STATUSES,
  TRANSITIONS,
  canTransition,
  isTerminal,
  isActive,
  legalPredecessors,
  cancellableStates,
  isRequestStatus,
  explainRefusal,
  type RequestStatus,
} from '../src/domain/request-state'

describe('graph integrity', () => {
  it('gives every declared status an entry', () => {
    for (const s of REQUEST_STATUSES) {
      expect(TRANSITIONS[s], `no TRANSITIONS entry for '${s}'`).toBeDefined()
    }
  })

  it('never names a target that is not a real status', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        expect(isRequestStatus(to), `'${from}' -> '${to}' is not a real status`).toBe(
          true
        )
      }
    }
  })

  it('has no self-loops', () => {
    // A state is not its own predecessor. The whole guard derivation depends
    // on this: if a self-loop existed, `legalPredecessors` would let a
    // transition match rows already in the target state, and the "exactly one
    // winner" property of the race-lock would quietly weaken.
    for (const s of REQUEST_STATUSES) {
      expect(TRANSITIONS[s], `'${s}' loops to itself`).not.toContain(s)
    }
  })

  it('lists no duplicate targets', () => {
    for (const s of REQUEST_STATUSES) {
      const t = TRANSITIONS[s]
      expect(new Set(t).size, `'${s}' repeats a target`).toBe(t.length)
    }
  })

  it('leaves no state unreachable except the entry state', () => {
    // Anything unreachable is dead schema — either a missing edge or a status
    // that should be deleted.
    const reachable = new Set<RequestStatus>()
    for (const s of REQUEST_STATUSES) TRANSITIONS[s].forEach((t) => reachable.add(t))

    const orphans = REQUEST_STATUSES.filter((s) => s !== 'open' && !reachable.has(s))
    expect(orphans, `unreachable states: ${orphans.join(', ')}`).toEqual([])
  })

  it('lets every non-terminal state reach a terminal one', () => {
    // Guards against a cycle that traps a request in limbo forever.
    const terminals = REQUEST_STATUSES.filter(isTerminal)

    for (const start of REQUEST_STATUSES.filter((s) => !isTerminal(s))) {
      const seen = new Set<RequestStatus>([start])
      const queue: RequestStatus[] = [start]
      let escaped = false

      while (queue.length > 0) {
        const cur = queue.shift()!
        if (terminals.includes(cur)) {
          escaped = true
          break
        }
        for (const next of TRANSITIONS[cur]) {
          if (!seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      }
      expect(escaped, `'${start}' can never reach a terminal state`).toBe(true)
    }
  })
})

describe('schema agreement', () => {
  it('keeps the generated migration in step with the graph', () => {
    // The database used to hold its own hand-written copy of the state list
    // in migration 006. Two hand-maintained lists that must agree is the very
    // bug this graph was built to remove, so the schema is now GENERATED from
    // the graph. This test is the tripwire: edit the graph, forget to run
    // `npm run db:generate-state`, and CI fails instead of production.
    const generated = buildSql()
    const onDisk = readFileSync(
      join(__dirname, '..', 'migrations', '011_request_state_machine.sql'),
      'utf8'
    )

    expect(
      onDisk,
      'migrations/011 is stale — run: npm run db:generate-state'
    ).toBe(generated)
  })

  it('emits one INSERT row per edge in the graph', () => {
    const sql = buildSql()
    const edgeCount = REQUEST_STATUSES.reduce(
      (n, s) => n + TRANSITIONS[s].length,
      0
    )
    const emitted = [...sql.matchAll(/^ {2}\('[a-z_]+', '[a-z_]+'\)[,;]$/gm)]
    expect(emitted.length).toBe(edgeCount)
  })

  it('emits every state into the CHECK constraint', () => {
    const sql = buildSql()
    const check = sql.slice(sql.indexOf('CHECK (status IN ('))
    const listed = [...check.slice(0, check.indexOf('));')).matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1]
    )
    expect(listed.sort()).toEqual([...REQUEST_STATUSES].sort())
  })

  it('is deterministic, so regeneration produces no spurious diff', () => {
    expect(buildSql()).toBe(buildSql())
  })

  it('never emits an edge the graph does not contain', () => {
    const sql = buildSql()
    for (const m of sql.matchAll(/^ {2}\('([a-z_]+)', '([a-z_]+)'\)[,;]$/gm)) {
      const [, from, to] = m
      expect(
        canTransition(from as RequestStatus, to as RequestStatus),
        `SQL contains ${from} -> ${to}, which the graph forbids`
      ).toBe(true)
    }
  })
})

describe('the drift this graph was built to kill', () => {
  it('gives one answer for which states are cancellable', () => {
    // Two call sites disagreed: one allowed in_progress, the other didn't.
    // Whatever the answer is, there must now be exactly one of them.
    const states = cancellableStates()
    expect(states).toContain('open')
    expect(states).toContain('negotiating')
    expect(states).toContain('confirmed')
    expect(states).toContain('in_progress') // the disputed one
    expect(states).not.toContain('completed')
    expect(states).not.toContain('cancelled')
  })

  it('lets a short job complete without passing through in_progress', () => {
    // advanceStage's private map said completed came only from in_progress,
    // while the confirm-attended route allowed it from confirmed too. A
    // haircut never has an in_progress step.
    expect(canTransition('confirmed', 'completed')).toBe(true)
    expect(canTransition('in_progress', 'completed')).toBe(true)
    expect(legalPredecessors('completed').sort()).toEqual(['confirmed', 'in_progress'])
  })
})

describe('transitions that must never be legal', () => {
  const forbidden: Array<[RequestStatus, RequestStatus]> = [
    ['completed', 'confirmed'], // reopening settled work
    ['completed', 'in_progress'],
    ['cancelled', 'confirmed'], // resurrecting an abandoned request
    ['cancelled', 'open'],
    ['expired', 'confirmed'], // rematching makes a NEW request
    ['no_match', 'confirmed'],
    ['no_show_customer', 'confirmed'],
    ['no_show_vendor', 'completed'],
    ['rescheduled', 'confirmed'], // the successor row owns the booking
    ['open', 'in_progress'], // work cannot start before a vendor commits
    ['open', 'completed'],
    ['negotiating', 'completed'],
    ['in_progress', 'no_show_customer'], // somebody clearly turned up
    ['in_progress', 'no_show_vendor'],
    ['negotiating', 'no_match'], // a vendor already engaged
  ]

  for (const [from, to] of forbidden) {
    it(`refuses ${from} -> ${to}`, () => {
      expect(canTransition(from, to)).toBe(false)
      expect(explainRefusal(from, to)).not.toBe('')
    })
  }
})

describe('transitions that must be legal', () => {
  const allowed: Array<[RequestStatus, RequestStatus]> = [
    ['open', 'negotiating'],
    ['open', 'confirmed'], // direct slot booking, no bargaining
    ['open', 'no_match'],
    ['open', 'expired'],
    ['open', 'waitlisted'],
    ['negotiating', 'confirmed'],
    ['negotiating', 'expired'],
    ['waitlisted', 'confirmed'], // claimed an offered slot
    ['waitlisted', 'disrupted'],
    ['confirmed', 'in_progress'],
    ['confirmed', 'rescheduled'],
    ['confirmed', 'no_show_customer'],
    ['confirmed', 'no_show_vendor'],
    ['confirmed', 'disrupted'],
    ['disrupted', 'confirmed'], // rebooked elsewhere
    ['in_progress', 'completed'],
  ]

  for (const [from, to] of allowed) {
    it(`permits ${from} -> ${to}`, () => {
      expect(canTransition(from, to)).toBe(true)
      expect(explainRefusal(from, to)).toBe('')
    })
  }
})

describe('terminality', () => {
  const terminal: RequestStatus[] = [
    'completed',
    'cancelled',
    'expired',
    'no_match',
    'rescheduled',
    'no_show_customer',
    'no_show_vendor',
  ]

  it('marks exactly the intended states terminal', () => {
    expect(REQUEST_STATUSES.filter(isTerminal).sort()).toEqual([...terminal].sort())
  })

  it('treats terminal and active as exact opposites', () => {
    for (const s of REQUEST_STATUSES) {
      expect(isActive(s)).toBe(!isTerminal(s))
    }
  })

  it('lets nothing escape a terminal state', () => {
    for (const s of terminal) {
      expect(TRANSITIONS[s]).toEqual([])
    }
  })
})

describe('guard derivation', () => {
  it('makes legalPredecessors the exact inverse of TRANSITIONS', () => {
    // Every repository guard is built from legalPredecessors. If this is not a
    // true inverse, the guards are wrong everywhere at once.
    for (const to of REQUEST_STATUSES) {
      const derived = legalPredecessors(to).sort()
      const manual = REQUEST_STATUSES.filter((from) =>
        TRANSITIONS[from].includes(to)
      ).sort()
      expect(derived).toEqual(manual)
    }
  })

  it('gives every reachable state at least one predecessor', () => {
    // transition() throws on an empty predecessor list, so an unreachable
    // target is a latent crash rather than a silent no-op.
    for (const s of REQUEST_STATUSES) {
      if (s === 'open') continue // the entry state, created not transitioned
      expect(legalPredecessors(s).length, `'${s}' has no way in`).toBeGreaterThan(0)
    }
  })
})

describe('isRequestStatus', () => {
  it('accepts real statuses and rejects everything else', () => {
    expect(isRequestStatus('confirmed')).toBe(true)
    expect(isRequestStatus('waitlisted')).toBe(true)
    // 'no_show' was never a real value — the constraint has no_show_customer
    // and no_show_vendor. Writing the short form would fail at the database.
    expect(isRequestStatus('no_show')).toBe(false)
    expect(isRequestStatus('')).toBe(false)
    expect(isRequestStatus(null)).toBe(false)
    expect(isRequestStatus(undefined)).toBe(false)
    expect(isRequestStatus(42)).toBe(false)
  })
})
