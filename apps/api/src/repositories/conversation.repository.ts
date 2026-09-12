/**
 * ConversationContextRepository — what the user is implicitly talking about.
 *
 * Server-authoritative by design. The mobile store already tracks a little of
 * this (`activeRequestId`) but it is in-memory zustand with no persistence, so
 * it dies on app restart and can be edited by anyone holding the device. When
 * a "yes" is about to cancel a booking, the question that "yes" answers cannot
 * live on the client.
 *
 * Writes are UPSERTs on a single row per user, so callers never have to know
 * whether a context exists yet.
 */

import { BaseRepository, type Executor } from './base'
import type {
  ConversationContext,
  IntentName,
  ReferencedEntityType,
} from '@locogi/types'

interface ContextRow {
  active_booking_id: string | null
  active_service_request_id: string | null
  active_provider_id: string | null
  last_intent: string | null
  last_referenced_type: string | null
  last_referenced_id: string | null
  pending_intent: string | null
  pending_booking_id: string | null
  pending_expires_at: string | null
  updated_at: string
}

/** How long a pending confirmation stays answerable. */
export const CONFIRMATION_TTL_MINUTES = 5

export class ConversationContextRepository extends BaseRepository {
  async get(userId: string, executor?: Executor): Promise<ConversationContext | null> {
    const row = await this.one<ContextRow>(
      'conversation.get',
      `SELECT active_booking_id, active_service_request_id, active_provider_id,
              last_intent, last_referenced_type, last_referenced_id,
              pending_intent, pending_booking_id, pending_expires_at, updated_at
         FROM conversation_contexts
        WHERE user_id = $1`,
      [userId],
      executor
    )
    if (!row) return null

    // Expired confirmations are dropped on READ rather than swept by a job.
    // A stale "yes" must be inert the instant it is too late, and a sweeper
    // that runs every minute leaves a minute-wide window where it is not.
    const pendingLive =
      row.pending_intent !== null &&
      row.pending_expires_at !== null &&
      new Date(row.pending_expires_at).getTime() > Date.now()

    return {
      activeBookingId: row.active_booking_id ?? undefined,
      activeServiceRequestId: row.active_service_request_id ?? undefined,
      activeProviderId: row.active_provider_id ?? undefined,
      lastIntent: (row.last_intent as IntentName) ?? undefined,
      lastReferencedEntity:
        row.last_referenced_type && row.last_referenced_id
          ? {
              type: row.last_referenced_type as ReferencedEntityType,
              id: row.last_referenced_id,
            }
          : undefined,
      pendingConfirmation:
        pendingLive && row.pending_booking_id
          ? {
              intent: row.pending_intent as IntentName,
              bookingId: row.pending_booking_id,
              expiresAt: row.pending_expires_at!,
            }
          : undefined,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Merge a partial update into the user's context.
   *
   * Only the fields present in `patch` change; `undefined` leaves a column
   * alone, which is what almost every caller wants after a single turn.
   * Clearing is explicit — see `clearPending` and `clearActiveBooking`.
   */
  async update(
    userId: string,
    patch: {
      activeBookingId?: string
      activeServiceRequestId?: string
      activeProviderId?: string
      lastIntent?: IntentName
      lastReferencedEntity?: { type: ReferencedEntityType; id: string }
    },
    executor?: Executor
  ): Promise<void> {
    await this.run(
      'conversation.update',
      `INSERT INTO conversation_contexts
         (user_id, active_booking_id, active_service_request_id,
          active_provider_id, last_intent, last_referenced_type,
          last_referenced_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id) DO UPDATE SET
         active_booking_id =
           COALESCE(EXCLUDED.active_booking_id, conversation_contexts.active_booking_id),
         active_service_request_id =
           COALESCE(EXCLUDED.active_service_request_id, conversation_contexts.active_service_request_id),
         active_provider_id =
           COALESCE(EXCLUDED.active_provider_id, conversation_contexts.active_provider_id),
         last_intent =
           COALESCE(EXCLUDED.last_intent, conversation_contexts.last_intent),
         last_referenced_type =
           COALESCE(EXCLUDED.last_referenced_type, conversation_contexts.last_referenced_type),
         last_referenced_id =
           COALESCE(EXCLUDED.last_referenced_id, conversation_contexts.last_referenced_id),
         updated_at = now()`,
      [
        userId,
        patch.activeBookingId ?? null,
        patch.activeServiceRequestId ?? null,
        patch.activeProviderId ?? null,
        patch.lastIntent ?? null,
        patch.lastReferencedEntity?.type ?? null,
        patch.lastReferencedEntity?.id ?? null,
      ],
      executor
    )
  }

  /**
   * Arm a confirmation for a destructive action.
   *
   * The TTL is what makes a later bare "yes" safe: past the window the answer
   * has nothing to attach to and is treated as an ordinary message.
   */
  async setPending(
    userId: string,
    intent: IntentName,
    bookingId: string,
    executor?: Executor
  ): Promise<void> {
    await this.run(
      'conversation.setPending',
      `INSERT INTO conversation_contexts
         (user_id, pending_intent, pending_booking_id, pending_expires_at, updated_at)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, now())
       ON CONFLICT (user_id) DO UPDATE SET
         pending_intent = EXCLUDED.pending_intent,
         pending_booking_id = EXCLUDED.pending_booking_id,
         pending_expires_at = EXCLUDED.pending_expires_at,
         updated_at = now()`,
      [userId, intent, bookingId, CONFIRMATION_TTL_MINUTES],
      executor
    )
  }

  /**
   * Consume a pending confirmation, atomically.
   *
   * Returns the armed action only if it was still live, and clears it in the
   * same statement. Read-then-clear would let a double-tapped "yes" execute a
   * cancellation twice; a conditional UPDATE ... RETURNING cannot.
   */
  async consumePending(
    userId: string,
    executor?: Executor
  ): Promise<{ intent: IntentName; bookingId: string } | null> {
    const row = await this.one<{ pending_intent: string; pending_booking_id: string }>(
      'conversation.consumePending',
      `UPDATE conversation_contexts
          SET pending_intent = NULL,
              pending_booking_id = NULL,
              pending_expires_at = NULL,
              updated_at = now()
        WHERE user_id = $1
          AND pending_intent IS NOT NULL
          AND pending_booking_id IS NOT NULL
          AND pending_expires_at > now()
      RETURNING pending_intent, pending_booking_id`,
      [userId],
      executor
    )
    if (!row) return null
    return {
      intent: row.pending_intent as IntentName,
      bookingId: row.pending_booking_id,
    }
  }

  async clearPending(userId: string, executor?: Executor): Promise<void> {
    await this.run(
      'conversation.clearPending',
      `UPDATE conversation_contexts
          SET pending_intent = NULL,
              pending_booking_id = NULL,
              pending_expires_at = NULL,
              updated_at = now()
        WHERE user_id = $1`,
      [userId],
      executor
    )
  }

  /** After a cancellation, the cancelled booking should stop being "active". */
  async clearActiveBooking(
    userId: string,
    bookingId: string,
    executor?: Executor
  ): Promise<void> {
    await this.run(
      'conversation.clearActiveBooking',
      `UPDATE conversation_contexts
          SET active_booking_id = NULL, updated_at = now()
        WHERE user_id = $1 AND active_booking_id = $2`,
      [userId, bookingId],
      executor
    )
  }
}
