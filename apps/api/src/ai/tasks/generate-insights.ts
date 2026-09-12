/**
 * Generate AI-powered business insights from booking data.
 *
 * Instead of hardcoded dashboard charts, the AI analyzes the business's
 * real data and generates:
 *   - Natural language insights ("Your busiest day is Saturday")
 *   - Actionable recommendations ("Consider adding a 7pm slot — 12 requests last week got no match")
 *   - Pricing suggestions ("Your Biryani is 15% below area average")
 *   - Demand patterns ("Order volume spikes 30% on weekends")
 */

import { z } from 'zod'
import { type LlmTask, untrusted } from '../contract'

const Input = z.object({
  orgType: z.string(),
  orgName: z.string(),
  // Summary stats passed in, not raw data
  totalBookings7d: z.number(),
  totalRevenue7d: z.number(),
  completionRate: z.number(),
  noShowRate: z.number(),
  avgBookingValue: z.number(),
  topItems: z.array(z.object({
    name: z.string(),
    count: z.number(),
    revenue: z.number(),
  })),
  peakHours: z.array(z.object({
    hour: z.number(),
    count: z.number(),
  })),
  cancellationReasons: z.array(z.string()),
  unmetDemand: z.number(), // requests with no match
})

const Output = z.object({
  headline: z.string().max(100),
  insights: z.array(z.object({
    type: z.enum(['positive', 'warning', 'suggestion', 'info']),
    title: z.string().max(60),
    body: z.string().max(200),
    metric: z.string().max(30).nullable(),
  })).min(3).max(6),
  recommendations: z.array(z.object({
    action: z.string().max(80),
    impact: z.string().max(100),
    priority: z.enum(['high', 'medium', 'low']),
  })).max(3),
})

export interface BusinessInsights {
  headline: string
  insights: Array<{
    type: 'positive' | 'warning' | 'suggestion' | 'info'
    title: string
    body: string
    metric: string | null
  }>
  recommendations: Array<{
    action: string
    impact: string
    priority: 'high' | 'medium' | 'low'
  }>
}

const SYSTEM = `You are a business analytics AI for local service businesses in India.

Given summary statistics about a business's last 7 days, generate:
1. A headline summarizing performance
2. 3-6 insights about their business
3. Up to 3 actionable recommendations

Rules:
- Be specific and data-driven. "Revenue is up 12%" not "Business is good".
- Highlight problems: high no-show rates, unmet demand, cancellation patterns.
- Suggest concrete actions: "Add a 7pm slot", "Raise Biryani price to ₹380", "Enable auto-confirmation".
- Metric field should be a short stat like "+12%" or "₹18,450" or "94%".
- For restaurants: focus on popular items, peak hours, average order value.
- For clinics: focus on appointment utilization, no-show rates, slot gaps.
- Currency is INR (₹).

Return ONLY valid JSON.`

export const generateInsightsTask: LlmTask<
  z.infer<typeof Input>,
  z.infer<typeof Output>,
  BusinessInsights
> = {
  name: 'generate_insights',
  version: 1,
  input: Input,
  output: Output,

  prompt: (input) => [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: untrusted(JSON.stringify(input)),
    },
  ],

  map: (d) => ({
    headline: d.headline,
    insights: d.insights.map(i => ({
      type: i.type,
      title: i.title,
      body: i.body,
      metric: i.metric,
    })),
    recommendations: d.recommendations.map(r => ({
      action: r.action,
      impact: r.impact,
      priority: r.priority,
    })),
  }),

  temperature: 0.3,
  maxTokens: 1200,
  timeoutMs: 15_000,
  maxAttempts: 2,
}
