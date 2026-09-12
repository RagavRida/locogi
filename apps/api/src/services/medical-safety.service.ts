/**
 * MedicalSafetyService — health-data handling and the safety facade.
 *
 * The emergency PATTERNS moved to the database (see safety-ruleset.ts and
 * migration 008). This service now:
 *   • delegates detection to the compiled in-memory ruleset (synchronous)
 *   • owns health-data sanitisation before vendor fan-out
 *   • owns interception logging
 *
 * Detection stays deterministic and synchronous on purpose. The reasoning is
 * documented at length in safety-ruleset.ts — in short, nothing with a network
 * dependency belongs between a person in crisis and the number 108.
 */

import { query } from '../lib/db'
import { logger } from '../lib/logger'
import { SafetyRulesetService } from './safety-ruleset'

const ruleset = new SafetyRulesetService()

export interface EmergencyCheck {
  isEmergency: boolean
  severity: 'critical' | 'urgent' | 'none'
  matchedPattern?: string
  patternId?: string
  forcedResponse?: string
}

export class MedicalSafetyService {

  /**
   * Synchronous emergency check. Delegates to the compiled ruleset.
   * Zero I/O, sub-millisecond.
   */
  check(text: string): EmergencyCheck {
    const result = ruleset.check(text)

    if (!result.triggered || result.severity === 'advice') {
      return { isEmergency: false, severity: 'none' }
    }

    if (result.patternId) {
      ruleset.recordMatch(result.patternId).catch(() => {})
    }

    return {
      isEmergency: true,
      severity: result.severity as 'critical' | 'urgent',
      matchedPattern: result.label,
      patternId: result.patternId,
      forcedResponse: result.forcedResponse,
    }
  }

  /** Is the user asking for medical advice rather than a booking? */
  isSeekingAdvice(text: string): boolean {
    const result = ruleset.check(text)
    return result.triggered && result.severity === 'advice'
  }

  getAdviceRefusal(text = ''): string {
    const result = ruleset.check(text)
    return (
      result.forcedResponse ??
      "I can't give medical advice — I'm a booking app, not a doctor. " +
      'I can book you an appointment with a registered doctor instead. ' +
      'Tell me the speciality and your area.'
    )
  }

  /**
   * Semantic second pass, fire-and-forget. Runs only on messages the
   * deterministic check already cleared, so it cannot delay a real emergency.
   * Catches missed phrasings and proposes patterns for human review.
   */
  reviewForMissedEmergency(text: string, userId: string): void {
    ruleset.semanticSecondPass(text, userId).catch(() => {})
  }

  /**
   * Log the interception. This matters for two reasons:
   *   - Auditability: if something goes wrong, there is a record that the
   *     system did intercept and what it said.
   *   - Tuning: false positives ("chest pain" in "chest of drawers pain")
   *     show up here and can be refined.
   *
   * We deliberately do NOT store the raw message text for critical
   * interceptions — health data is a special category under the DPDP Act and
   * storing symptom text creates obligations we should not take on for a
   * booking app. We store only the matched pattern label.
   */
  async logInterception(
    userId: string,
    severity: string,
    matchedPattern: string,
    isAdviceRequest = false
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO events (event_type, user_id, metadata)
         VALUES ($1, $2, $3)`,
        [
          isAdviceRequest ? 'medical_advice_refused' : 'emergency_intercepted',
          userId,
          JSON.stringify({
            severity,
            matchedPattern,
            timestamp: new Date().toISOString(),
            // Deliberately no raw text — see comment above
          }),
        ]
      )

      logger.warn(
        { userId, severity, matchedPattern },
        '🚨 Emergency/medical interception fired'
      )
    } catch (err) {
      // Logging must never block the safety response reaching the user
      logger.error({ err }, 'Could not log interception — response still sent')
    }
  }

  /**
   * Guard for health-adjacent category bookings.
   * Even a legitimate appointment request must not carry symptom detail into
   * the vendor's inbox — that would be sharing health data with a third party
   * without a lawful basis.
   */
  sanitizeHealthRequest(rawText: string, attributes: Record<string, unknown>): {
    sanitizedText: string
    strippedFields: string[]
  } {
    const SYMPTOM_FIELDS = [
      'symptoms', 'symptom', 'condition', 'diagnosis', 'illness',
      'medication', 'medicines', 'medical_history', 'history',
      'pain_level', 'severity', 'complaint',
    ]

    const stripped: string[] = []
    for (const field of Object.keys(attributes)) {
      if (SYMPTOM_FIELDS.some((s) => field.toLowerCase().includes(s))) {
        stripped.push(field)
        delete attributes[field]
      }
    }

    // Replace the free-text description with a neutral booking summary.
    // The vendor sees "Consultation requested" not "sharp pain in my left side".
    const sanitizedText = stripped.length > 0 || this.looksClinical(rawText)
      ? 'Consultation appointment requested'
      : rawText

    if (stripped.length > 0) {
      logger.info(
        { strippedFields: stripped },
        'Stripped health data fields before vendor fan-out'
      )
    }

    return { sanitizedText, strippedFields: stripped }
  }

  private looksClinical(text: string): boolean {
    return /\b(pain|ache|fever|symptom|swelling|rash|infection|bleeding|nausea|dizzy)\b/i.test(
      text
    )
  }
}
