/**
 * Repository composition root.
 *
 * Single instances, exported directly. No DI container — the spec is explicit
 * about avoiding unnecessary abstraction, and these are stateless objects
 * whose only dependency is the connection pool.
 *
 * When a second implementation genuinely appears (an in-memory fake for tests,
 * a read-replica variant), extract interfaces then. Not before.
 */

export { VendorRepository } from './vendor.repository'
export { RequestRepository } from './request.repository'
export {
  BookingRepository,
  isScheduleConflict,
  EXCLUSION_VIOLATION,
} from './booking.repository'
export {
  ConversationContextRepository,
  CONFIRMATION_TTL_MINUTES,
} from './conversation.repository'
export { txExecutor, type Executor } from './base'

export type { VendorRecord, VendorTravelProfile } from './vendor.repository'
export type { RequestRecord, MatchingContext } from './request.repository'
export type { QuoteRecord, CommitmentRecord } from './booking.repository'
export type { BookingCandidate } from './request.repository'

import { VendorRepository } from './vendor.repository'
import { RequestRepository } from './request.repository'
import { BookingRepository } from './booking.repository'
import { ConversationContextRepository } from './conversation.repository'

export const vendorRepo = new VendorRepository()
export const requestRepo = new RequestRepository()
export const bookingRepo = new BookingRepository()
export const conversationRepo = new ConversationContextRepository()
