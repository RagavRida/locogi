#!/usr/bin/env npx tsx
/**
 * CLI Chat Tester — simulates a customer chatting with a business.
 *
 * Usage:
 *   npx tsx scripts/chat-cli.ts                    # auto-picks first org
 *   npx tsx scripts/chat-cli.ts <orgId>            # chat with specific org
 *   npx tsx scripts/chat-cli.ts --org-view <orgId> # see incoming as org owner
 *
 * Type messages and see AI responses in real-time.
 * Type "quit" to exit.
 */

import 'dotenv/config'
import * as readline from 'readline'
import { Pool } from 'pg'

const db = new Pool({ connectionString: process.env.DATABASE_URL })

// ── Colors ───────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  bg: '\x1b[44m',
}

// ── Lazy imports (avoid crashing if server modules aren't ready) ─────────────
async function getOrchestrator() {
  const { ChatOrchestratorService } = await import('../src/services/chat-orchestrator.service')
  return new ChatOrchestratorService()
}

// ── Create or get a test user ────────────────────────────────────────────────
async function getTestUser(): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (phone, name) VALUES ('cli_test_user', 'CLI Tester')
     ON CONFLICT (phone) DO UPDATE SET name = 'CLI Tester'
     RETURNING id`
  )
  return r.rows[0].id
}

// ── List available orgs ──────────────────────────────────────────────────────
async function listOrgs(): Promise<Array<{ id: string; name: string; type: string }>> {
  const r = await db.query<{ id: string; display_name: string; org_type: string }>(
    `SELECT id, display_name, org_type FROM organizations ORDER BY created_at DESC LIMIT 10`
  )
  return r.rows.map(row => ({ id: row.id, name: row.display_name, type: row.org_type }))
}

// ── Show recent messages for an org (org-view mode) ──────────────────────────
async function showOrgInbox(orgId: string) {
  const r = await db.query<{
    sender_id: string; text: string; message_type: string; created_at: Date
  }>(
    `SELECT m.sender_id, m.text, m.message_type, m.created_at
     FROM messages m
     WHERE m.text IS NOT NULL
     ORDER BY m.created_at DESC
     LIMIT 20`
  )

  console.log(`\n${C.bg}${C.bold} 📥 ORG INBOX ${C.reset}\n`)
  if (r.rows.length === 0) {
    console.log(`${C.dim}  No messages yet. Send a message from @locogi_bot on Telegram!${C.reset}`)
    return
  }

  r.rows.reverse().forEach(row => {
    const time = new Date(row.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    if (row.message_type === 'system') {
      console.log(`  ${C.cyan}🤖 Bot [${time}]:${C.reset} ${row.text.slice(0, 120)}`)
    } else {
      console.log(`  ${C.green}👤 Customer [${time}]:${C.reset} ${row.text}`)
    }
  })
  console.log()
}

// ── Format AI response for terminal ──────────────────────────────────────────
function formatReply(result: any): void {
  console.log()
  console.log(`  ${C.cyan}${C.bold}🤖 Locogi:${C.reset} ${result.message}`)

  if (result.ui) {
    const data = result.ui.data as any
    console.log(`  ${C.dim}[UI: ${result.ui.type}]${C.reset}`)

    // Show catalog items
    if (data?.items?.length) {
      data.items.forEach((item: any, i: number) => {
        if (item.topItems) {
          // It's a business listing
          console.log(`\n  ${C.yellow}━━━━━━━━━━━━━━━━${C.reset}`)
          console.log(`  ${C.bold}📸 ${item.name}${C.reset}  ⭐ ${item.rating ?? ''}`)
          if (item.area) console.log(`  📍 ${item.area}`)
          if (item.description) console.log(`  ${C.dim}${item.description.slice(0, 100)}${C.reset}`)
          if (item.topItems.length) {
            console.log(`  ${C.magenta}💼 Packages:${C.reset}`)
            item.topItems.forEach((pkg: any) => {
              console.log(`     • ${pkg.name} — ₹${pkg.price?.toLocaleString('en-IN')}`)
            })
          }
        } else {
          // It's a catalog item
          const vegIcon = item.isVeg ? '🟢' : item.isVeg === false ? '🔴' : '  '
          console.log(`  ${vegIcon} ${item.name} — ${C.green}₹${item.price?.toLocaleString('en-IN')}${C.reset}`)
        }
      })
    }

    // Show cart
    if (data?.cart?.length || data?.cartItems?.length) {
      const cart = data.cart ?? data.cartItems ?? []
      console.log(`\n  ${C.yellow}🛒 Cart:${C.reset}`)
      let total = 0
      cart.forEach((item: any) => {
        const lineTotal = item.price * (item.quantity ?? 1)
        total += lineTotal
        console.log(`     ${item.name} × ${item.quantity ?? 1} = ₹${lineTotal.toLocaleString('en-IN')}`)
      })
      console.log(`  ${C.bold}   Total: ₹${total.toLocaleString('en-IN')}${C.reset}`)
    }
  }

  if (result.intent) {
    console.log(`  ${C.dim}intent: ${result.intent}${C.reset}`)
  }
  console.log()
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const isOrgView = args.includes('--org-view')
  const orgArg = args.find(a => !a.startsWith('--'))

  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════╗${C.reset}`)
  console.log(`${C.bold}${C.cyan}║     Locogi CLI Chat Tester           ║${C.reset}`)
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════╝${C.reset}\n`)

  // List orgs
  const orgs = await listOrgs()
  if (orgs.length === 0) {
    console.log(`${C.red}No organizations found. Run the seed script first.${C.reset}`)
    process.exit(1)
  }

  console.log(`${C.bold}Available businesses:${C.reset}`)
  orgs.forEach((o, i) => {
    console.log(`  ${i + 1}. ${C.yellow}${o.name}${C.reset} (${o.type}) — ${C.dim}${o.id.slice(0, 8)}...${C.reset}`)
  })

  // Org view mode — just show inbox
  if (isOrgView) {
    const orgId = orgArg ?? orgs[0].id
    const orgName = orgs.find(o => o.id === orgId)?.name ?? orgId
    console.log(`\n${C.bold}Viewing inbox for: ${C.yellow}${orgName}${C.reset}\n`)
    await showOrgInbox(orgId)

    // Poll for new messages
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    console.log(`${C.dim}Press Enter to refresh, or type "quit" to exit${C.reset}`)
    rl.on('line', async (line) => {
      if (line.trim() === 'quit') { await db.end(); process.exit(0) }
      await showOrgInbox(orgId)
    })
    return
  }

  // Customer chat mode
  const orgId = orgArg ?? orgs[0].id
  const orgName = orgs.find(o => o.id === orgId)?.name ?? orgId

  console.log(`\n${C.bold}Chatting with: ${C.yellow}${orgName}${C.reset}`)
  console.log(`${C.dim}Type your messages below. Type "quit" to exit.${C.reset}\n`)

  const userId = await getTestUser()
  const orchestrator = await getOrchestrator()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.green}You > ${C.reset}`,
  })

  rl.prompt()

  rl.on('line', async (line) => {
    const text = line.trim()
    if (!text) { rl.prompt(); return }
    if (text === 'quit') { await db.end(); process.exit(0) }

    try {
      const result = await orchestrator.handle({
        userId,
        text,
        orgId,
      })

      if (!result) {
        console.log(`  ${C.red}⚠ No response from orchestrator${C.reset}`)
      } else {
        formatReply(result)
      }
    } catch (err: any) {
      console.log(`  ${C.red}❌ Error: ${err.message}${C.reset}`)
    }

    rl.prompt()
  })

  rl.on('close', async () => {
    await db.end()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
