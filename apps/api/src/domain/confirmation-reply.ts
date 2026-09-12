/**
 * Reading "yes" and "no" when a destructive action is pending.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS DETERMINISTIC AND NOT AN LLM CALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the same argument the emergency ruleset makes, for the same reason.
 * The moment a user answers "are you sure you want to cancel?", two things are
 * true:
 *
 *  - a network round-trip can fail, and a timeout would swallow the answer to
 *    a question we just asked, which is a maddening experience
 *  - a model that reads "no, don't cancel" as affirmative destroys a booking
 *
 * A model is better than a word list at nuance. Nuance is not what this needs.
 * It needs to be right about "yes" and "no" with certainty, and to abstain
 * everywhere else — which a conservative matcher does and a probabilistic
 * classifier cannot promise.
 *
 * The bias is deliberate and asymmetric: an unrecognised reply is NOT taken as
 * consent. It cancels the pending action and is handled as an ordinary
 * message, so the worst case is the user repeats themselves.
 */

export type ConfirmationReply = 'affirmative' | 'negative' | 'unrelated'

/**
 * Whole-phrase affirmatives.
 *
 * Matched against the entire normalised message, never as substrings. "Yes"
 * inside "yesterday I said no" must not read as consent, and a substring
 * match on "ok" would fire on "okay so about the other booking".
 */
const AFFIRMATIVE = new Set([
  'y', 'ya', 'yes', 'yeah', 'yep', 'yup', 'yess',
  'ok', 'okay', 'k', 'sure', 'confirm', 'confirmed',
  'go ahead', 'do it', 'please do', 'yes please', 'go for it',
  'cancel it', 'cancel booking', 'cancel the booking',
  'proceed', 'affirmative', 'correct', 'right',
  // Hindi / Telugu, romanised — this app's users mix languages constantly
  'haan', 'han', 'haa', 'ha', 'theek hai', 'thik hai', 'sari', 'saree',
  'avunu', 'sare', 'ok chey', 'cheyyi',
])

const NEGATIVE = new Set([
  'n', 'no', 'nope', 'nah', 'dont', "don't", 'do not',
  'keep it', 'keep booking', 'keep the booking', 'stop',
  'cancel that', 'never mind', 'nevermind', 'no thanks',
  'leave it', 'not now', 'wait', 'abort',
  'nahi', 'nahin', 'na', 'vaddu', 'venda',
])

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Classify a reply to a pending confirmation.
 *
 * Only short messages are considered answers at all. Someone who writes a
 * sentence has moved on to a new thought, even if the word "yes" appears in
 * it — treating that as consent is how a booking disappears mid-conversation.
 */
export function readConfirmationReply(text: string): ConfirmationReply {
  const t = normalise(text)
  if (!t) return 'unrelated'

  // Negative first. If a message somehow matches both lists, refusing is the
  // safe reading.
  if (NEGATIVE.has(t)) return 'negative'
  if (AFFIRMATIVE.has(t)) return 'affirmative'

  // A short leading answer with a trailing remark: "yes please cancel it".
  // Capped at four words so this cannot swallow a real sentence.
  const words = t.split(' ')
  if (words.length <= 4) {
    if (words.some((w) => NEGATIVE.has(w))) return 'negative'
    if (words.some((w) => AFFIRMATIVE.has(w))) return 'affirmative'
  }

  return 'unrelated'
}
