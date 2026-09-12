/**
 * IntentService — the gate that runs BEFORE the taxonomy.
 *
 * Not every message is a service request. Without this gate:
 *   - "find a library near me" auto-creates a junk category with 0 vendors
 *   - "help me make friends" creates another one
 *   - the user dead-ends on a question that was actually answerable
 *   - the taxonomy fills with orphan categories nobody will ever join
 *
 * Only `service_request` is allowed to reach CategoryService. Everything else
 * gets answered, redirected, or honestly declined — and logged as unmet demand,
 * which is the highest-signal product input you have.
 */

import { query } from '../lib/db'
import { generateEmbedding } from '../lib/nim'
import { runTask } from '../ai/contract'
import { classifyIntentTask } from '../ai/tasks/classify-intent'
import { indexLocation, getSearchCells, H3_RES_MID } from '../lib/h3'
import { logger } from '../lib/logger'
import { z } from 'zod'
import { ScopeService } from './scope.service'

const scopeService = new ScopeService()

export type Intent =
  | 'service_request'
  | 'place_discovery'
  | 'social_community'
  | 'information'
  | 'unsupported'

export interface Classification {
  intent: Intent
  confidence: number
  reasoning: string
  topic: string | null
  secondaryIntents: Array<{ intent: Intent; topic: string }>
}

export interface IntentResponse {
  classification: Classification
  /** Whether the caller should proceed to CategoryService + vendor matching. */
  proceedToMatching: boolean
  /** What the agent should say. Null when proceeding to normal matching. */
  agentMessage: string | null
  /** Places found, for place_discovery intent. */
  places?: PlaceResult[]
}

export interface PlaceResult {
  id: string
  name: string
  placeType: string
  area: string | null
  address: string | null
  notes: string | null
  distanceKm?: number
}

export class IntentService {

  // ─── Classify + route ───────────────────────────────────────────────────────
  async classify(
    rawText: string,
    userId: string,
    coords?: { lat?: number; lng?: number }
  ): Promise<IntentResponse> {

    // ── Out-of-scope check first (cheap DB pattern match, no LLM) ──────────
    // Catches flights, trains, movies, government slots etc. before we spend
    // an LLM call or risk polluting the taxonomy.
    const outOfScope = await this.checkOutOfScope(rawText)
    if (outOfScope) {
      await this.logUnmetDemand(
        rawText,
        userId,
        'unsupported',
        outOfScope.slug,
        coords,
        outOfScope.message,
        false,
        'redirected'
      )
      return {
        classification: {
          intent: 'unsupported',
          confidence: 0.95,
          reasoning: `Out of scope: ${outOfScope.reason}`,
          topic: outOfScope.label,
          secondaryIntents: [],
        },
        proceedToMatching: false,
        agentMessage: outOfScope.message,
      }
    }

    const classification = await this.runClassifier(rawText)

    logger.info(
      {
        intent: classification.intent,
        confidence: classification.confidence,
        topic: classification.topic,
        secondary: classification.secondaryIntents.map((s) => s.intent),
      },
      'Intent classified'
    )

    // ── Service request → proceed to the normal pipeline ────────────────────
    if (classification.intent === 'service_request') {
      // But if the user ALSO asked something we can't do, acknowledge it
      const offTopic = classification.secondaryIntents.filter(
        (s) => s.intent === 'social_community' || s.intent === 'place_discovery'
      )
      if (offTopic.length > 0) {
        await this.logUnmetDemand(rawText, userId, offTopic[0].intent, offTopic[0].topic, coords, null)
      }

      return {
        classification,
        proceedToMatching: true,
        agentMessage: null,
      }
    }

    // ── Everything else stops here. Handle it honestly. ─────────────────────
    switch (classification.intent) {
      case 'place_discovery':
        return this.handlePlaceDiscovery(rawText, userId, classification, coords)

      case 'social_community':
        return this.handleSocialCommunity(rawText, userId, classification, coords)

      case 'information':
        return this.handleInformation(rawText, userId, classification, coords)

      default:
        return this.handleUnsupported(rawText, userId, classification, coords)
    }
  }

  /**
   * Is this something Locogi structurally cannot do?
   *
   * Flights, trains, movie seats and government appointments all fail for
   * different reasons — monopolised inventory, required accreditation, or
   * regulatory prohibition. In every case the honest answer plus a redirect
   * beats pretending, and it keeps junk out of the taxonomy.
   */
  /**
   * Is this something Locogi structurally cannot do?
   *
   * Delegates to ScopeService, which compares SEMANTICALLY against boundary
   * definitions rather than substring-matching. So "need to fly to Delhi"
   * and "విమానం టికెట్" both land on the flights boundary, which the old
   * `includes('flight ticket')` check would have missed entirely.
   */
  private async checkOutOfScope(rawText: string): Promise<{
    slug: string
    label: string
    reason: string
    message: string
  } | null> {
    const verdict = await scopeService.checkScope(rawText)
    if (verdict.inScope) return null

    return {
      slug: verdict.boundarySlug!,
      label: verdict.boundaryLabel!,
      reason: verdict.reason!,
      message: verdict.message!,
    }
  }

  // ─── place_discovery: actually answer it ───────────────────────────────────
  private async handlePlaceDiscovery(
    rawText: string,
    userId: string,
    classification: Classification,
    coords?: { lat?: number; lng?: number }
  ): Promise<IntentResponse> {
    const places = await this.findPlaces(classification.topic ?? rawText, coords)

    let message: string
    let resolutionType: string

    if (places.length > 0) {
      const lines = places
        .slice(0, 4)
        .map((p) => {
          const dist = p.distanceKm ? ` · ${p.distanceKm.toFixed(1)} km` : ''
          const area = p.area ? ` · ${p.area}` : ''
          return `📍 **${p.name}**${area}${dist}\n${p.notes ?? ''}`
        })
        .join('\n\n')

      message =
        `I'm built for booking services, but here's what I know about ` +
        `${classification.topic ?? 'places'} in Hyderabad:\n\n${lines}\n\n` +
        `These aren't Locogi vendors — just local knowledge. ` +
        `Need someone to hire instead? Just tell me what for.`
      resolutionType = 'answered_directly'
    } else {
      message =
        `I can't look up ${classification.topic ?? 'places'} — Locogi is for ` +
        `booking services like photographers, plumbers, salons and rides.\n\n` +
        `Google Maps will do a better job of finding that. ` +
        `Anything I can book for you instead?`
      resolutionType = 'declined'
    }

    await this.logUnmetDemand(
      rawText,
      userId,
      'place_discovery',
      classification.topic,
      coords,
      message,
      places.length > 0,
      resolutionType
    )

    return {
      classification,
      proceedToMatching: false,
      agentMessage: message,
      places,
    }
  }

  // ─── social_community: be honest, don't pretend ────────────────────────────
  private async handleSocialCommunity(
    rawText: string,
    userId: string,
    classification: Classification,
    coords?: { lat?: number; lng?: number }
  ): Promise<IntentResponse> {
    // We can at least point them at real community spaces
    const spaces = await this.findPlaces('community space events meetup', coords)

    let message =
      `Honestly — making friends isn't something Locogi can do. ` +
      `I'm built for booking services you pay for: photographers, plumbers, ` +
      `salons, rides, tutors and so on.\n\n`

    if (spaces.length > 0) {
      const lines = spaces
        .slice(0, 2)
        .map((p) => `📍 **${p.name}**${p.area ? ` · ${p.area}` : ''}\n${p.notes ?? ''}`)
        .join('\n\n')
      message +=
        `That said, these places in Hyderabad run open community events — ` +
        `genuinely good for meeting people:\n\n${lines}\n\n`
    }

    message +=
      `For actual community, Meetup, Reddit r/hyderabad, or local WhatsApp ` +
      `groups will serve you far better than I can.\n\n` +
      `Anything I *can* book for you?`

    await this.logUnmetDemand(
      rawText,
      userId,
      'social_community',
      classification.topic,
      coords,
      message,
      false,
      'redirected'
    )

    return {
      classification,
      proceedToMatching: false,
      agentMessage: message,
      places: spaces.slice(0, 2),
    }
  }

  // ─── information: answer what we can ───────────────────────────────────────
  private async handleInformation(
    rawText: string,
    userId: string,
    classification: Classification,
    coords?: { lat?: number; lng?: number }
  ): Promise<IntentResponse> {
    // Pull the live category list so the answer reflects reality, not a
    // hardcoded marketing blurb
    const cats = await query<{ canonical_name: string; vendor_count: number }>(
      `SELECT canonical_name, vendor_count
       FROM service_categories
       WHERE vendor_count > 0
       ORDER BY vendor_count DESC
       LIMIT 12`
    )

    const available = cats.rows.length > 0
      ? cats.rows.map((c) => c.canonical_name).join(', ')
      : 'we are still onboarding our first vendors'

    const message =
      `Here's how I work: tell me what you need in plain language — ` +
      `"photographer in Madhapur this Sunday, around ₹5000" — and I'll find ` +
      `vendors nearby, collect quotes, and handle the booking.\n\n` +
      `Right now we have vendors in: ${available}.\n\n` +
      `Free to use. What do you need?`

    await this.logUnmetDemand(
      rawText,
      userId,
      'information',
      classification.topic,
      coords,
      message,
      true,
      'answered_directly'
    )

    return { classification, proceedToMatching: false, agentMessage: message }
  }

  // ─── unsupported: decline clearly ──────────────────────────────────────────
  private async handleUnsupported(
    rawText: string,
    userId: string,
    classification: Classification,
    coords?: { lat?: number; lng?: number }
  ): Promise<IntentResponse> {
    const message =
      `That's outside what I can help with. Locogi books local services in ` +
      `Hyderabad — photographers, plumbers, electricians, salons, cleaners, ` +
      `auto and bike rides, tutors, caterers and similar.\n\n` +
      `If you need any of those, just describe it and I'll take it from there.`

    await this.logUnmetDemand(
      rawText,
      userId,
      'unsupported',
      classification.topic,
      coords,
      message,
      false,
      'declined'
    )

    return { classification, proceedToMatching: false, agentMessage: message }
  }

  // ─── Find places (curated directory, H3-filtered) ──────────────────────────
  private async findPlaces(
    topic: string,
    coords?: { lat?: number; lng?: number }
  ): Promise<PlaceResult[]> {
    let embedding: string | null = null
    try {
      const vec = await generateEmbedding(topic)
      embedding = `[${vec.join(',')}]`
    } catch {
      // Embedding failed — fall back to text search below
    }

    // Geo-scoped semantic search when we know where they are
    if (coords?.lat && coords?.lng && embedding) {
      const cells = getSearchCells(coords.lat, coords.lng, H3_RES_MID, 3)
      const result = await query<PlaceRow & { distance_km: number }>(
        `SELECT id, name, place_type, area, address, notes,
                (ST_Distance(
                  ST_MakePoint(lng, lat)::geography,
                  ST_MakePoint($2, $3)::geography
                ) / 1000) AS distance_km
         FROM places
         WHERE h3_r7 = ANY($1::text[])
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $4::vector
         LIMIT 5`,
        [cells, coords.lng, coords.lat, embedding]
      )
      if (result.rows.length > 0) return result.rows.map(this.toPlaceResult)
    }

    // City-wide semantic search
    if (embedding) {
      const result = await query<PlaceRow>(
        `SELECT id, name, place_type, area, address, notes
         FROM places
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT 5`,
        [embedding]
      )
      if (result.rows.length > 0) return result.rows.map(this.toPlaceResult)
    }

    // Last resort: plain text match on type and name
    const result = await query<PlaceRow>(
      `SELECT id, name, place_type, area, address, notes
       FROM places
       WHERE place_type ILIKE '%' || $1 || '%'
          OR name ILIKE '%' || $1 || '%'
          OR notes ILIKE '%' || $1 || '%'
       LIMIT 5`,
      [topic.split(/\s+/)[0]]
    )
    return result.rows.map(this.toPlaceResult)
  }

  // ─── Log unmet demand (the product-signal goldmine) ────────────────────────
  private async logUnmetDemand(
    rawText: string,
    userId: string,
    intent: string,
    topic: string | null,
    coords: { lat?: number; lng?: number } | undefined,
    agentResponse: string | null,
    wasResolved = false,
    resolutionType?: string
  ): Promise<void> {
    let embedding: string | null = null
    let h3: string | null = null

    try {
      const vec = await generateEmbedding(topic ?? rawText)
      embedding = `[${vec.join(',')}]`
    } catch { /* non-fatal */ }

    if (coords?.lat && coords?.lng) {
      try {
        h3 = indexLocation(coords.lat, coords.lng).h3_r7
      } catch { /* non-fatal */ }
    }

    try {
      await query(
        `INSERT INTO unmet_demand
           (user_id, raw_text, intent, extracted_topic, embedding,
            lat, lng, h3_r7, agent_response, was_resolved, resolution_type)
         VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10, $11)`,
        [
          userId,
          rawText.slice(0, 1000),
          intent,
          topic?.slice(0, 60) ?? null,
          embedding,
          coords?.lat ?? null,
          coords?.lng ?? null,
          h3,
          agentResponse?.slice(0, 2000) ?? null,
          wasResolved,
          resolutionType ?? null,
        ]
      )
    } catch (err) {
      logger.error({ err }, 'Could not log unmet demand')
    }
  }

  // ─── Run the LLM classifier ────────────────────────────────────────────────
  private async runClassifier(rawText: string): Promise<Classification> {
    const result = await runTask(classifyIntentTask, { text: rawText })

    if (!result.ok) {
      // The contract already logged why, with the raw response attached.
      // Distinguishing the reasons matters: 'unavailable' is an outage worth
      // paging on, 'invalid_output' is a prompt-quality problem. Previously
      // both looked identical from here.
      logger.warn(
        { reason: result.reason },
        'Intent classification unavailable — using heuristic fallback'
      )
      return this.heuristicFallback(rawText)
    }

    return {
      intent: result.data.intent,
      confidence: result.data.confidence,
      reasoning: result.data.reasoning,
      topic: result.data.topic,
      secondaryIntents: result.data.secondaryIntents.map((s) => ({
        intent: s.intent as Intent,
        topic: s.topic,
      })),
    }
  }

  /**
   * Deterministic fallback when the LLM is unavailable.
   *
   * Deliberately biased toward service_request: a false negative (rejecting a
   * real service request) loses a booking, which is worse than a false positive
   * (letting an odd query through to matching, where it just finds nothing).
   */
  private heuristicFallback(text: string): Classification {
    const t = text.toLowerCase()

    const PLACE_WORDS = [
      'library', 'park', 'cafe', 'coffee shop', 'restaurant', 'mall',
      'gym near', 'hospital', 'clinic near', 'atm', 'metro station',
      'bus stop', 'co-working', 'coworking', 'study place', 'study space',
      'where can i study', 'reading room',
    ]
    const SOCIAL_WORDS = [
      'make friends', 'making friends', 'find friends', 'meet people',
      'meet new people', 'social group', 'community group', 'book club',
      'cricket group', 'gym buddy', 'study buddy', 'dating', 'girlfriend',
      'boyfriend', 'hang out', 'hangout', 'lonely', 'companion',
    ]
    const INFO_WORDS = [
      'how does this work', 'how do you work', 'what is locogi',
      'what services', 'do you charge', 'is this free', 'which areas',
      'what can you do',
    ]

    if (SOCIAL_WORDS.some((w) => t.includes(w))) {
      return {
        intent: 'social_community',
        confidence: 0.75,
        reasoning: 'Heuristic: social/community keyword matched',
        topic: 'friends',
        secondaryIntents: [],
      }
    }

    if (PLACE_WORDS.some((w) => t.includes(w))) {
      return {
        intent: 'place_discovery',
        confidence: 0.7,
        reasoning: 'Heuristic: place keyword matched',
        topic: PLACE_WORDS.find((w) => t.includes(w)) ?? 'place',
        secondaryIntents: [],
      }
    }

    if (INFO_WORDS.some((w) => t.includes(w))) {
      return {
        intent: 'information',
        confidence: 0.8,
        reasoning: 'Heuristic: information question matched',
        topic: null,
        secondaryIntents: [],
      }
    }

    // Default: assume it's a service request and let matching decide
    return {
      intent: 'service_request',
      confidence: 0.4,
      reasoning: 'Heuristic fallback: no off-topic signal, assuming service request',
      topic: null,
      secondaryIntents: [],
    }
  }

  private toPlaceResult(row: PlaceRow & { distance_km?: number }): PlaceResult {
    return {
      id: row.id,
      name: row.name,
      placeType: row.place_type,
      area: row.area,
      address: row.address,
      notes: row.notes,
      distanceKm: row.distance_km,
    }
  }
}

interface PlaceRow {
  id: string
  name: string
  place_type: string
  area: string | null
  address: string | null
  notes: string | null
}
