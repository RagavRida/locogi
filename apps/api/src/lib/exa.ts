/**
 * Exa — Web-powered business discovery & enrichment.
 *
 * Two capabilities:
 *   1. enrichBusiness()    — given a known business, pull portfolio, reviews, photos from the web
 *   2. discoverBusinesses() — when Moss/SQL find 0 results, search the open web for matching businesses
 *
 * Exa's neural search understands "wedding photographer in Hyderabad" better than keyword matching.
 */

import { logger } from './logger'

let exaClient: any = null

async function getExaClient() {
  if (exaClient) return exaClient

  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return null

  const Exa = (await import('exa-js')).default
  exaClient = new Exa(apiKey)
  return exaClient
}

// ─── Enrich a known business with web data ──────────────────────────────────

export interface BusinessEnrichment {
  portfolio: Array<{ title: string; url: string; snippet: string }>
  reviews: Array<{ title: string; url: string; snippet: string }>
}

export async function enrichBusiness(
  businessName: string,
  city: string,
): Promise<BusinessEnrichment | null> {
  const exa = await getExaClient()
  if (!exa) return null

  try {
    const [portfolioResults, reviewResults] = await Promise.all([
      exa.searchAndContents(
        `${businessName} ${city} portfolio work gallery`,
        {
          numResults: 3,
          text: { maxCharacters: 300 },
          type: 'neural',
        },
      ).catch(() => ({ results: [] })),
      exa.searchAndContents(
        `${businessName} ${city} reviews ratings`,
        {
          numResults: 2,
          text: { maxCharacters: 200 },
          type: 'neural',
        },
      ).catch(() => ({ results: [] })),
    ])

    const enrichment: BusinessEnrichment = {
      portfolio: portfolioResults.results.map((r: any) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.text?.slice(0, 200) ?? '',
      })),
      reviews: reviewResults.results.map((r: any) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.text?.slice(0, 150) ?? '',
      })),
    }

    logger.info(
      { business: businessName, portfolioCount: enrichment.portfolio.length },
      '[exa] Business enriched',
    )
    return enrichment
  } catch (err) {
    logger.warn({ err, business: businessName }, '[exa] Enrichment failed')
    return null
  }
}

// ─── Discover businesses from the open web ──────────────────────────────────

export interface WebBusiness {
  name: string
  url: string
  description: string
}

export async function discoverBusinesses(
  query: string,
  city: string,
): Promise<WebBusiness[]> {
  const exa = await getExaClient()
  if (!exa) return []

  try {
    const results = await exa.searchAndContents(
      `${query} in ${city} booking contact phone`,
      {
        numResults: 5,
        text: { maxCharacters: 400 },
        type: 'neural',
      },
    )

    const businesses = results.results.map((r: any) => ({
      name: r.title ?? 'Unknown Business',
      url: r.url ?? '',
      description: r.text?.slice(0, 300) ?? '',
    }))

    logger.info(
      { query, city, count: businesses.length },
      '[exa] Web discovery complete',
    )
    return businesses
  } catch (err) {
    logger.warn({ err, query }, '[exa] Web discovery failed')
    return []
  }
}
