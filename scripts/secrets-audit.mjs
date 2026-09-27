#!/usr/bin/env node
/**
 * Fulfilment tool for a paid secrets audit.
 *
 *   node scripts/secrets-audit.mjs <dir> [--client "Name"] [--json]
 *
 * Produces the report a client receives: findings with file and line, severity,
 * and what to do about each, plus a git-history pass, because a key removed from
 * the latest commit is still live in history and rotating is the only real fix.
 *
 * The scan is deliberately bounded and says so in its own output. A report that
 * claims completeness it cannot support is worse than one that states its limits,
 * because the client will trust it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, sep } from 'node:path'
import { verifySecrets } from '../netlify/functions/verifylane-engine.mjs'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  'vendor', '.venv', 'venv', '__pycache__', '.cache', 'tmp',
])
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.env', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.sh', '.bash', '.zsh', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.php', '.cs', '.sql', '.md', '.txt', '.xml', '.html',
  '.htm', '.tf', '.tfvars', '.properties', '.gradle', '.lock', '.pem', '.key',
])
const MAX_FILE_BYTES = 512 * 1024
const MAX_HISTORY_BYTES = 8 * 1024 * 1024
const MAX_HISTORY_COMMITS = 500

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const clientIdx = args.indexOf('--client')
const client = clientIdx >= 0 ? args[clientIdx + 1] : null
const target = args.find((a, i) => !a.startsWith('--') && i !== clientIdx + 1) || '.'

function walk(dir, root, out = [], skipped = { dirs: 0, big: 0, binary: 0 }) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) { skipped.dirs += 1; continue }
      walk(full, root, out, skipped)
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : ''
    if (!TEXT_EXT.has(ext) && !entry.name.startsWith('.env')) continue
    let size = 0
    try { size = statSync(full).size } catch { continue }
    if (size > MAX_FILE_BYTES) { skipped.big += 1; continue }
    let content = ''
    try { content = readFileSync(full, 'utf8') } catch { continue }
    if (content.includes('\u0000')) { skipped.binary += 1; continue }
    out.push({ path: relative(root, full).split(sep).join('/'), content })
  }
  return { files: out, skipped }
}

const { files, skipped } = walk(target, target)
const scan = verifySecrets({ files })

// History pass: a secret removed from HEAD is still live in history until rotated.
let history = { ran: false, findings: 0, note: '' }
try {
  const log = execFileSync('git', ['-C', target, 'log', '-p', '--all', '--no-color',
    `-n`, String(MAX_HISTORY_COMMITS)],
    { maxBuffer: MAX_HISTORY_BYTES, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const h = verifySecrets({ text: log, path: '(git history)' })
  history = { ran: true, findings: h.summary.total, summary: h.summary, note: `last ${MAX_HISTORY_COMMITS} commits, capped at ${Math.round(MAX_HISTORY_BYTES / 1048576)}MB of diff` }
} catch (err) {
  history = { ran: false, findings: 0, note: `not a git repository, or the log exceeded the cap (${err.code || 'error'})` }
}

if (asJson) {
  console.log(JSON.stringify({
    target, client, scannedFiles: files.length, skipped, history,
    findings: scan.findings, summary: scan.summary,
  }, null, 2))
  process.exit(0)
}

const ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
const rows = scan.findings
  .filter((f) => f.severity !== 'info')
  .sort((a, b) => (ORDER[a.severity] - ORDER[b.severity]) || a.path.localeCompare(b.path))

const counts = scan.summary
const lines = []
lines.push(`# Secrets audit — ${client || target}`)
lines.push('')
lines.push(`Reported ${new Date().toISOString().slice(0, 10)}. ${files.length} files scanned.`)
lines.push('')
lines.push('## Summary')
lines.push('')
lines.push(`| Severity | Findings |`)
lines.push(`|---|---|`)
for (const sev of ['critical', 'high', 'medium', 'low']) {
  lines.push(`| ${sev} | ${counts[sev] || 0} |`)
}
lines.push('')
if (history.ran) {
  lines.push(`**Git history:** ${history.findings} additional match(es) in ${history.note}. A credential removed from the latest commit but present in history is still live — anyone with the repository can read it, and rotating is the only fix that works.`)
} else {
  lines.push(`**Git history:** not checked (${history.note}).`)
}
lines.push('')

if (!rows.length) {
  lines.push('## Findings')
  lines.push('')
  lines.push('No credential patterns matched in the scanned files.')
} else {
  lines.push('## Findings')
  lines.push('')
  lines.push('| Severity | Finding | Location |')
  lines.push('|---|---|---|')
  for (const f of rows.slice(0, 200)) {
    lines.push(`| ${f.severity} | ${f.message} | \`${f.path}:${f.line}\` |`)
  }
  lines.push('')
  lines.push('## What to do')
  lines.push('')
  lines.push('1. **Rotate first, clean up second.** Every credential listed above should be treated as compromised and replaced at its source. Deleting a key from code does not make it stop working.')
  lines.push('2. **Remove from the working tree** and add the file to `.gitignore` so it cannot return.')
  lines.push('3. **Purge history only after rotation.** Rewriting history is safe once the old credentials are dead, and pointless until then.')
  lines.push('4. **Move secrets to environment variables**, and add a pre-commit check so this does not recur.')
}

lines.push('')
lines.push('## Scope and limits')
lines.push('')
lines.push(`- Scanned ${files.length} text files. Skipped ${skipped.dirs} vendor/build directories, ${skipped.big} files over ${Math.round(MAX_FILE_BYTES / 1024)}KB, and binary files.`)
lines.push('- Detection is pattern-based. It finds credentials that look like credentials, and it can miss unusual formats or keys that appear valid but are not.')
lines.push('- A clean report means nothing matched these patterns. It is not a guarantee that no credential is exposed, and it is not a security certification.')

console.log(lines.join('\n'))
