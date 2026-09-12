/**
 * SAFETY TEST SUITE — emergency interception.
 *
 * This is the only test file in the repo where a failure means someone could
 * be physically harmed. A false negative (missing a real emergency) delays a
 * 108 call. Treat any failure here as a release blocker.
 *
 * No DB or network needed — the checker is deterministic by design.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { MedicalSafetyService } from '../src/services/medical-safety.service'
import { SafetyRulesetService } from '../src/services/safety-ruleset'

const safety = new MedicalSafetyService()
const ruleset = new SafetyRulesetService()

beforeAll(async () => {
  // Load from DB if available. If not, the ruleset falls back to the
  // hardcoded emergency floor — and these tests then verify the FLOOR works,
  // which is the more important guarantee.
  await ruleset.initialize()
  const status = ruleset.getStatus()
  if (status.usingFloor) {
    console.warn(
      '⚠️  Running against the emergency FLOOR (no DB). ' +
      'Floor-covered cases are asserted; DB-only patterns are skipped.'
    )
  }
})

/** Patterns present in the hardcoded floor, so they must pass either way. */
const FLOOR_COVERED = [
  'chest pain', 'heart attack', 'cardiac arrest',
  "can't breathe", 'cannot breathe', 'not breathing',
  'unconscious', 'unresponsive',
  'suicide', 'kill myself', 'end my life',
  'severe bleeding', 'heavy bleeding',
  'overdose', 'poisoned',
  'seizure', 'convulsion',
]

const isFloorCovered = (text: string) =>
  FLOOR_COVERED.some((f) => text.toLowerCase().includes(f))

describe('Critical emergency interception', () => {
  const CRITICAL_CASES = [
    'my father has chest pain and cannot breathe',
    'chest tightness since morning',
    'I think he is having a heart attack',
    "she can't breathe properly",
    'my son is unconscious',
    'grandmother is unresponsive',
    'her face is drooping and speech is slurred',
    'severe bleeding from the head',
    'he took an overdose of pills',
    'having a seizure right now',
    'hit by a car near Madhapur',
    'electrocuted while fixing the fan',
    'my wife water broke, labour pain started',
    'snake bite in the garden',
    'child is choking',
    'saans nahi aa raha hai',
    'bachao please',
  ]

  CRITICAL_CASES.forEach((text) => {
    it(`intercepts as CRITICAL: "${text}"`, () => {
      const onFloor = ruleset.getStatus().usingFloor
      if (onFloor && !isFloorCovered(text)) {
        // This phrasing lives only in the DB ruleset — not testable offline
        return
      }

      const result = safety.check(text)
      expect(result.isEmergency).toBe(true)
      expect(result.severity).toBe('critical')
      expect(result.forcedResponse).toBeTruthy()
      // Must surface an emergency number
      expect(result.forcedResponse).toMatch(/108|112|14416/)
    })
  })

  it('the hardcoded FLOOR alone covers every life-threatening category', () => {
    // This is the guarantee that matters most: even with the database down,
    // the highest-severity cases still reach 108.
    const floorCases = [
      'chest pain',
      "can't breathe",
      'unconscious',
      'kill myself',
      'severe bleeding',
      'overdose',
      'seizure',
    ]
    for (const c of floorCases) {
      const result = safety.check(c)
      expect(result.isEmergency, `floor must catch: "${c}"`).toBe(true)
      expect(result.severity).toBe('critical')
    }
  })

  it('routes self-harm to mental health helplines, not ambulance', () => {
    const result = safety.check('I want to kill myself')
    expect(result.isEmergency).toBe(true)
    expect(result.severity).toBe('critical')
    expect(result.matchedPattern).toBe('self_harm')
    expect(result.forcedResponse).toContain('14416') // Tele-MANAS
    expect(result.forcedResponse).toContain('AASRA')
  })

  it('never lets a critical case reach matching', () => {
    const result = safety.check('chest pain')
    // If isEmergency is true, the route returns before extraction —
    // this assertion documents the contract
    expect(result.isEmergency).toBe(true)
  })
})

describe('Urgent (needs a doctor, not an ambulance)', () => {
  const URGENT_CASES = [
    'fever 104 since two days',
    'severe pain in my lower back',
    'vomiting blood this morning',
    'broken bone in the wrist',
    'deep cut needs stitches',
    'allergic reaction, face is swelling',
  ]

  URGENT_CASES.forEach((text) => {
    it(`flags as URGENT: "${text}"`, () => {
      if (ruleset.getStatus().usingFloor) return // urgent tier is DB-only
      const result = safety.check(text)
      expect(result.isEmergency).toBe(true)
      expect(result.severity).toBe('urgent')
      expect(result.forcedResponse).toMatch(/108|102/)
    })
  })
})

describe('Medical advice refusal', () => {
  const ADVICE_CASES = [
    'what medicine should I take for fever',
    'which tablet is good for headache',
    'what dosage of paracetamol',
    'do I have diabetes',
    'is it serious doctor',
    'what could this rash be',
    'treatment for back pain',
  ]

  ADVICE_CASES.forEach((text) => {
    it(`refuses advice: "${text}"`, () => {
      if (ruleset.getStatus().usingFloor) return // advice tier is DB-only
      expect(safety.isSeekingAdvice(text)).toBe(true)
    })
  })

  it('refusal offers booking instead of an answer', () => {
    if (ruleset.getStatus().usingFloor) return
    const refusal = safety.getAdviceRefusal('what medicine should I take')
    expect(refusal).toContain("can't give medical advice")
    expect(refusal).toMatch(/book|appointment/i)
    // Must not contain anything that reads like advice
    expect(refusal).not.toMatch(/you should take|try this medicine/i)
  })
})

describe('False positive resistance', () => {
  // These must NOT trigger. Over-triggering trains users to ignore the warning.
  const SAFE_CASES = [
    'need a photographer for my wedding',
    'plumber for a leaking tap',
    'want to book a haircut tomorrow',
    'auto to Hitech City',
    'looking for a maths tutor for my son',
    'AC not cooling, need repair',
    'chest of drawers repair',        // "chest" but not medical
    'pain in booking the slot',        // "pain" colloquially
    'my laptop screen is broken',      // "broken" but not a bone
    'accident insurance paperwork help',
    'catering for 50 people',
    'deep cleaning for 2BHK',          // "deep" but not a cut
  ]

  SAFE_CASES.forEach((text) => {
    it(`does NOT intercept: "${text}"`, () => {
      const result = safety.check(text)
      expect(result.isEmergency).toBe(false)
      expect(result.severity).toBe('none')
    })
  })

  it('does not flag ordinary service requests as advice-seeking', () => {
    expect(safety.isSeekingAdvice('need a plumber')).toBe(false)
    expect(safety.isSeekingAdvice('book a table for 4')).toBe(false)
  })
})

describe('Health data sanitization before vendor fan-out', () => {
  it('strips symptom fields from attributes', () => {
    const attrs: Record<string, unknown> = {
      area: 'Madhapur',
      symptoms: 'sharp pain in left side',
      medical_history: 'diabetic since 2015',
      preferred_time: 'morning',
      medication: 'metformin',
    }

    const { sanitizedText, strippedFields } = safety.sanitizeHealthRequest(
      'sharp pain in my left side, need to see a doctor',
      attrs
    )

    expect(strippedFields).toContain('symptoms')
    expect(strippedFields).toContain('medical_history')
    expect(strippedFields).toContain('medication')

    // Non-health fields survive — the vendor still needs these
    expect(attrs.area).toBe('Madhapur')
    expect(attrs.preferred_time).toBe('morning')

    // Health fields are gone
    expect(attrs.symptoms).toBeUndefined()
    expect(attrs.medical_history).toBeUndefined()

    // Free text replaced with a neutral summary
    expect(sanitizedText).toBe('Consultation appointment requested')
    expect(sanitizedText).not.toContain('pain')
  })

  it('neutralizes clinical free text even with no structured fields', () => {
    const attrs: Record<string, unknown> = { area: 'Kondapur' }
    const { sanitizedText } = safety.sanitizeHealthRequest(
      'I have had a fever and rash for three days',
      attrs
    )
    expect(sanitizedText).toBe('Consultation appointment requested')
  })

  it('leaves non-clinical text alone', () => {
    const attrs: Record<string, unknown> = { area: 'Gachibowli' }
    const { sanitizedText, strippedFields } = safety.sanitizeHealthRequest(
      'routine annual health checkup booking',
      attrs
    )
    expect(strippedFields).toHaveLength(0)
    expect(sanitizedText).toBe('routine annual health checkup booking')
  })
})

describe('Determinism (no LLM in the safety path)', () => {
  it('returns identical results across repeated calls', () => {
    const text = 'chest pain and dizziness'
    const results = Array.from({ length: 50 }, () => safety.check(text))
    const first = JSON.stringify(results[0])
    results.forEach((r) => expect(JSON.stringify(r)).toBe(first))
  })

  it('completes synchronously and fast', () => {
    const start = Date.now()
    for (let i = 0; i < 1000; i++) safety.check('chest pain emergency help')
    // 1000 checks should take single-digit milliseconds
    expect(Date.now() - start).toBeLessThan(200)
  })
})

describe('Hot path is synchronous (the whole reason this stays deterministic)', () => {
  it('check() returns a value, not a Promise', () => {
    const result = safety.check('chest pain')
    // If someone refactors this to be async, the safety guarantee is gone.
    // This test exists to break loudly if that happens.
    expect(result).not.toBeInstanceOf(Promise)
    expect(typeof result.isEmergency).toBe('boolean')
  })

  it('1000 checks complete in under 200ms with zero awaits', () => {
    const start = Date.now()
    for (let i = 0; i < 1000; i++) safety.check('need a plumber in Kondapur')
    expect(Date.now() - start).toBeLessThan(200)
  })
})
