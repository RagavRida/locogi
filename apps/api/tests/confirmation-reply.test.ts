/**
 * Tests for reading "yes" and "no" before a destructive action.
 *
 * The asymmetry under test: a missed "yes" costs the user one repeated
 * message. A false "yes" destroys a booking. Every ambiguous case below must
 * therefore come back `unrelated`, not `affirmative`.
 */

import { describe, it, expect } from 'vitest'
import { readConfirmationReply } from '../src/domain/confirmation-reply'

describe('clear affirmatives', () => {
  const yes = [
    'yes', 'Yes', 'YES', 'y', 'yeah', 'yep', 'yup',
    'ok', 'okay', 'sure', 'confirm', 'proceed',
    'go ahead', 'do it', 'yes please',
    'cancel it', 'cancel the booking',
  ]
  for (const t of yes) {
    it(`reads "${t}" as yes`, () => {
      expect(readConfirmationReply(t)).toBe('affirmative')
    })
  }

  it('handles trailing punctuation and whitespace', () => {
    expect(readConfirmationReply('  yes!  ')).toBe('affirmative')
    expect(readConfirmationReply('Yes.')).toBe('affirmative')
  })
})

describe('clear negatives', () => {
  const no = [
    'no', 'No', 'nope', 'nah', 'n',
    'keep it', 'keep the booking', 'never mind', 'stop',
    'not now', 'leave it', "don't",
  ]
  for (const t of no) {
    it(`reads "${t}" as no`, () => {
      expect(readConfirmationReply(t)).toBe('negative')
    })
  }
})

describe('mixed-language replies', () => {
  // This app's users routinely answer in romanised Hindi or Telugu.
  it('reads Hindi affirmatives', () => {
    expect(readConfirmationReply('haan')).toBe('affirmative')
    expect(readConfirmationReply('theek hai')).toBe('affirmative')
  })

  it('reads Telugu affirmatives', () => {
    expect(readConfirmationReply('avunu')).toBe('affirmative')
    expect(readConfirmationReply('sare')).toBe('affirmative')
  })

  it('reads Hindi and Telugu negatives', () => {
    expect(readConfirmationReply('nahi')).toBe('negative')
    expect(readConfirmationReply('vaddu')).toBe('negative')
  })
})

describe('refusing to over-read — the cases that would cancel wrongly', () => {
  it('does not treat a sentence containing "yes" as consent', () => {
    expect(
      readConfirmationReply('yesterday you said the photographer was confirmed')
    ).toBe('unrelated')
  })

  it('does not match "yes" as a substring', () => {
    expect(readConfirmationReply('yesterday')).toBe('unrelated')
  })

  it('does not treat a new question as consent', () => {
    expect(
      readConfirmationReply('actually what about my AC repair, is that still on?')
    ).toBe('unrelated')
  })

  it('does not read "ok" inside a longer thought as consent', () => {
    expect(
      readConfirmationReply('okay so I was thinking about the other booking instead')
    ).toBe('unrelated')
  })

  it('prefers the negative when a short reply carries both', () => {
    // "no, yes to the other one" is not consent to THIS action.
    expect(readConfirmationReply('no yes')).toBe('negative')
  })

  it('reads a short answer with a trailing word', () => {
    expect(readConfirmationReply('yes please cancel')).toBe('affirmative')
    expect(readConfirmationReply('no keep it')).toBe('negative')
  })

  it('gives up past four words rather than guessing', () => {
    expect(readConfirmationReply('yes I would like you to cancel that booking now')).toBe(
      'unrelated'
    )
  })

  it('treats an empty or whitespace message as unrelated', () => {
    expect(readConfirmationReply('')).toBe('unrelated')
    expect(readConfirmationReply('   ')).toBe('unrelated')
  })

  it('treats emoji-only replies as unrelated', () => {
    // A thumbs-up is probably consent, but "probably" is not good enough to
    // delete a booking on.
    expect(readConfirmationReply('👍')).toBe('unrelated')
  })
})
