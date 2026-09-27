#!/usr/bin/env node
/**
 * Token risk report, runnable today with no deploy.
 *
 * This exists so the check can be sold before any of it is hosted: a customer
 * sends a mint, this prints the report, and the credits are granted by hand
 * until the API is deployable. It is deliberately the same code the API route
 * uses, so a report produced now and a report produced later cannot disagree.
 *
 *   node scripts/token-report.mjs <mint> [mint ...]      human readable
 *   node scripts/token-report.mjs --json <mint>          machine readable
 *
 * Requires JUPITER_API_KEY in the environment (or .env).
 */
import { readFileSync } from 'node:fs'
import { verifyTokenIdentity } from '../netlify/functions/cmc.mjs'

// Load .env without a dependency, so this runs on a fresh machine.
try {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {
  /* no .env present; rely on the real environment */
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const mints = args.filter((a) => !a.startsWith('--'))
if (!mints.length) {
  console.error('usage: node scripts/token-report.mjs [--json] <mint> [mint ...]')
  process.exit(1)
}

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

for (const mint of mints) {
  const r = await verifyTokenIdentity({ address: mint })
  if (asJson) {
    console.log(JSON.stringify({ mint, ok: r.ok, tokens: r.tokens, findings: r.findings, upstream: r.upstream }, null, 2))
    continue
  }
  const t = r.tokens[0]
  console.log('')
  console.log('─'.repeat(64))
  if (!t) {
    console.log(`  ${mint}`)
    for (const f of r.findings) console.log(`  [${f.severity}] ${f.message}`)
    continue
  }
  console.log(`  ${t.name}${t.symbol ? ` (${t.symbol})` : ''}`)
  console.log(`  ${t.address}`)
  console.log(`  ${t.platform}   price $${t.priceUsd ?? '?'}`)
  const ch = []
  if (t.website) ch.push(`site ${t.website}`)
  if (t.x) ch.push(`x ${t.x}`)
  console.log(`  ${ch.length ? ch.join('   ') : 'no official channels published'}`)
  const findings = [...r.findings]
    .filter((f) => f.rule !== 'token.match')
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))
  console.log('')
  if (!findings.length) console.log('  no risk signals raised')
  for (const f of findings) console.log(`  [${f.severity.toUpperCase().padEnd(8)}] ${f.message}`)
  console.log('')
  console.log('  Signals are judgement calls from public market and audit data, not an audit.')
  console.log('  A clean report is not a recommendation and is not investment advice.')
}
console.log('')
