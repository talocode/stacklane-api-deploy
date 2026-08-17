/**
 * VerifyLane engine — deterministic checks for agent/AI-generated code & artifacts.
 * Ported from Stacklane monorepo apps/api/src/services/verifylane.ts. No LLM required.
 */
export const VERIFYLANE_VERSION = '0.2.0'

function summarize(findings) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: findings.length }
  for (const f of findings) summary[f.severity]++
  return summary
}

function linesOf(text) {
  return text.replace(/\r\n/g, '\n').split('\n')
}

const SECRET_PATTERNS = [
  { id: 'secret.aws_key', re: /AKIA[0-9A-Z]{16}/g, message: 'Possible AWS access key id', severity: 'critical' },
  { id: 'secret.generic_api_key', re: /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi, message: 'Hardcoded API key-like assignment', severity: 'high' },
  { id: 'secret.bearer', re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, message: 'Bearer token literal', severity: 'high' },
  { id: 'secret.private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, message: 'Private key material', severity: 'critical' },
  { id: 'secret.password_assign', re: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi, message: 'Hardcoded password assignment', severity: 'high' },
  { id: 'secret.jwt', re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, message: 'JWT-like token literal', severity: 'medium' },
  { id: 'secret.slack', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g, message: 'Slack token pattern', severity: 'critical' },
  { id: 'secret.github_pat', re: /ghp_[A-Za-z0-9]{36}/g, message: 'GitHub personal access token', severity: 'critical' },
  { id: 'secret.openai', re: /sk-[A-Za-z0-9]{20,}/g, message: 'OpenAI-style secret key', severity: 'high' },
]

const SECURITY_PATTERNS = [
  { id: 'sec.eval', re: /\beval\s*\(/g, message: 'Use of eval()', severity: 'high' },
  { id: 'sec.function_ctor', re: /new\s+Function\s*\(/g, message: 'Dynamic Function constructor', severity: 'high' },
  { id: 'sec.child_process', re: /child_process\.(exec|execSync|spawn)\s*\(/g, message: 'Shell execution via child_process', severity: 'medium' },
  { id: 'sec.dangerously_set', re: /dangerouslySetInnerHTML/g, message: 'dangerouslySetInnerHTML (XSS risk)', severity: 'medium' },
  { id: 'sec.inner_html', re: /\.innerHTML\s*=/g, message: 'innerHTML assignment', severity: 'medium' },
  { id: 'sec.sql_concat', re: /(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,80}\+\s*['"`]/gi, message: 'Possible SQL string concatenation', severity: 'high' },
  { id: 'sec.http_cleartext', re: /http:\/\/(?!localhost|127\.0\.0\.1)/gi, message: 'Cleartext http URL', severity: 'low' },
  { id: 'sec.disable_tls', re: /rejectUnauthorized\s*:\s*false/g, message: 'TLS verification disabled', severity: 'high' },
  { id: 'sec.md5', re: /\bcreateHash\s*\(\s*['"]md5['"]\s*\)/g, message: 'MD5 used for hashing', severity: 'low' },
]

const QUALITY_PATTERNS = [
  { id: 'quality.any_ts', re: /:\s*any\b/g, message: 'TypeScript any type', severity: 'low' },
  { id: 'quality.todo', re: /\bTODO\b|\bFIXME\b|\bHACK\b/g, message: 'TODO/FIXME/HACK marker', severity: 'info' },
  { id: 'quality.console_log', re: /console\.(log|debug|info)\s*\(/g, message: 'console.log left in code', severity: 'info' },
  { id: 'quality.eslint_disable', re: /eslint-disable/g, message: 'eslint-disable directive', severity: 'low' },
  { id: 'quality.ts_ignore', re: /@ts-ignore|@ts-nocheck/g, message: 'TypeScript check suppression', severity: 'medium' },
  { id: 'quality.empty_catch', re: /catch\s*\([^)]*\)\s*\{\s*\}/g, message: 'Empty catch block', severity: 'medium' },
]

function scanPatterns(text, path, patterns) {
  const findings = []
  const lines = linesOf(text)
  for (const p of patterns) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g')
    let m
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(0, m.index)
      const line = before.split('\n').length
      const col = before.length - before.lastIndexOf('\n')
      findings.push({
        id: `${p.id}:${line}:${col}`,
        rule: p.id,
        severity: p.severity,
        message: p.message,
        line,
        column: col,
        path,
        snippet: (lines[line - 1] || '').trim().slice(0, 200),
      })
      if (findings.length > 500) return findings
    }
  }
  return findings
}

function filesOf(input) {
  return input.files?.length
    ? input.files
    : input.text != null
      ? [{ path: input.path, content: input.text }]
      : []
}

export function verifySecrets(input) {
  const started = Date.now()
  const files = filesOf(input)
  if (!files.length) throw new Error('text or files required')
  const findings = []
  for (const f of files) {
    findings.push(...scanPatterns(f.content, f.path, SECRET_PATTERNS))
  }
  const summary = summarize(findings)
  return {
    ok: summary.critical === 0 && summary.high === 0,
    product: 'verifylane',
    version: VERIFYLANE_VERSION,
    mode: 'secrets',
    findings,
    summary,
    durationMs: Date.now() - started,
  }
}

export function verifySecurity(input) {
  const started = Date.now()
  const files = filesOf(input)
  if (!files.length) throw new Error('text or files required')
  const findings = []
  for (const f of files) {
    findings.push(...scanPatterns(f.content, f.path, SECURITY_PATTERNS))
  }
  const summary = summarize(findings)
  return {
    ok: summary.critical === 0 && summary.high === 0,
    product: 'verifylane',
    version: VERIFYLANE_VERSION,
    mode: 'security',
    findings,
    summary,
    durationMs: Date.now() - started,
  }
}

export function verifyQuality(input) {
  const started = Date.now()
  const files = filesOf(input)
  if (!files.length) throw new Error('text or files required')
  const findings = []
  for (const f of files) {
    findings.push(...scanPatterns(f.content, f.path, QUALITY_PATTERNS))
  }
  const summary = summarize(findings)
  return {
    ok: true,
    product: 'verifylane',
    version: VERIFYLANE_VERSION,
    mode: 'quality',
    findings,
    summary,
    durationMs: Date.now() - started,
  }
}

export function verifyCode(input) {
  const started = Date.now()
  const modes = input.modes?.length ? input.modes : ['secrets', 'security', 'quality']
  const findings = []
  if (modes.includes('secrets')) findings.push(...verifySecrets(input).findings)
  if (modes.includes('security')) findings.push(...verifySecurity(input).findings)
  if (modes.includes('quality')) findings.push(...verifyQuality(input).findings)
  const seen = new Set()
  const unique = findings.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)))
  const summary = summarize(unique)
  return {
    ok: summary.critical === 0 && summary.high === 0,
    product: 'verifylane',
    version: VERIFYLANE_VERSION,
    mode: modes.join('+'),
    findings: unique,
    summary,
    durationMs: Date.now() - started,
  }
}

export function verifyDiff(input) {
  const started = Date.now()
  if (!input.diff?.trim()) throw new Error('diff is required')
  const added = []
  let currentPath
  const buf = []
  const flush = () => {
    if (buf.length) {
      added.push({ path: currentPath, content: buf.join('\n') })
      buf.length = 0
    }
  }
  for (const line of linesOf(input.diff)) {
    if (line.startsWith('+++ ')) {
      flush()
      currentPath = line.slice(4).replace(/^b\//, '').trim()
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      buf.push(line.slice(1))
    }
  }
  flush()
  if (!added.length) {
    return {
      ok: true,
      product: 'verifylane',
      version: VERIFYLANE_VERSION,
      mode: 'diff',
      findings: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 },
      durationMs: Date.now() - started,
    }
  }
  const result = verifyCode({ files: added, modes: input.modes })
  return { ...result, mode: `diff:${result.mode}`, durationMs: Date.now() - started }
}

export function verifyAgentOutput(input) {
  const started = Date.now()
  const findings = []
  const text =
    input.text ??
    (input.messages || [])
      .map((m) => m.content || '')
      .join('\n')
  const maxChars = input.maxChars ?? 200_000
  if (!text.trim()) {
    findings.push({ id: 'agent.empty', rule: 'agent.empty', severity: 'high', message: 'Agent output is empty' })
  }
  if (text.length > maxChars) {
    findings.push({
      id: 'agent.too_large',
      rule: 'agent.too_large',
      severity: 'medium',
      message: `Agent output exceeds maxChars (${text.length} > ${maxChars})`,
    })
  }
  if (/\b(as an ai|i cannot|i can't assist|i'm unable to)\b/i.test(text) && text.length < 400) {
    findings.push({ id: 'agent.refusal', rule: 'agent.refusal', severity: 'medium', message: 'Output looks like a model refusal / non-answer' })
  }
  const loopish = text.match(/(\b\w{4,}\b)(?:\s+\1){4,}/g)
  if (loopish?.length) {
    findings.push({
      id: 'agent.repeat_loop',
      rule: 'agent.repeat_loop',
      severity: 'medium',
      message: 'Repetitive loop-like text detected',
      snippet: loopish[0].slice(0, 120),
    })
  }
  findings.push(...scanPatterns(text, undefined, SECRET_PATTERNS))
  const summary = summarize(findings)
  return {
    ok: summary.critical === 0 && summary.high === 0,
    product: 'verifylane',
    version: VERIFYLANE_VERSION,
    mode: 'agent-output',
    findings,
    summary,
    durationMs: Date.now() - started,
  }
}

// ─── Data validation (email / phone / IP) ─────────────────────────────

const DATA_EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/

const DATA_ROLE_ACCOUNTS = new Set([
  'admin', 'administrator', 'abuse', 'billing', 'contact', 'devnull',
  'help', 'helpdesk', 'info', 'jobs', 'marketing', 'no-reply', 'noreply',
  'office', 'postmaster', 'press', 'privacy', 'sales', 'security',
  'support', 'team', 'test', 'testing', 'webmaster',
])

const DATA_DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', 'mailinator.com', 'mailinator.net', 'guerrillamail.com',
  'guerrillamail.net', 'sharklasers.com', 'temp-mail.org', 'temp-mail.io',
  'throwawaymail.com', 'dispostable.com', 'yopmail.com', 'yopmail.net',
  'maildrop.cc', 'mailnesia.com', 'trashmail.com', 'spamgourmet.com',
  'getnada.com', 'mailtemp.net', 'tempmail.com', 'fakeinbox.com',
  'mytemp.email', 'maileater.com', 'jetable.org', 'meltmail.com',
  'spam.la', 'discard.email', 'emailsensei.com', 'inboxbear.com',
])

const DATA_EMAIL_TYPOS = [
  { id: 'email.typo.gmail', re: /gm[ai]l[.]?c[o0]m$|gmail[.]c[o0]m$/i, correct: 'gmail.com' },
  { id: 'email.typo.gmail_co', re: /gmail[.]co$|gmail[.]cm$/i, correct: 'gmail.com' },
  { id: 'email.typo.hotmail', re: /hotm[aio]l[.]c[o0]m$|hotmail[.]c[o0]m$/i, correct: 'hotmail.com' },
  { id: 'email.typo.yahoo', re: /yahoo[.]co[.]?uk$|yahoo[.]c[o0]m$|yahoocom$/i, correct: 'yahoo.com' },
  { id: 'email.typo.outlook', re: /out[lo]+k[.]c[o0]m$|outlook[.]c[o0]$/i, correct: 'outlook.com' },
]

const DATA_FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'outlook.co.uk',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'zoho.com', 'gmx.com', 'mail.com', 'tutanota.com',
])

const DATA_COUNTRY_CODES = [
  { code: '1', name: 'United States / Canada', region: 'NA', maxNationalLength: 10 },
  { code: '234', name: 'Nigeria', region: 'AF', maxNationalLength: 10 },
  { code: '44', name: 'United Kingdom', region: 'EU', maxNationalLength: 10 },
  { code: '49', name: 'Germany', region: 'EU', maxNationalLength: 11 },
  { code: '33', name: 'France', region: 'EU', maxNationalLength: 9 },
  { code: '34', name: 'Spain', region: 'EU', maxNationalLength: 9 },
  { code: '39', name: 'Italy', region: 'EU', maxNationalLength: 10 },
  { code: '31', name: 'Netherlands', region: 'EU', maxNationalLength: 9 },
  { code: '91', name: 'India', region: 'AS', maxNationalLength: 10 },
  { code: '86', name: 'China', region: 'AS', maxNationalLength: 11 },
  { code: '81', name: 'Japan', region: 'AS', maxNationalLength: 10 },
  { code: '82', name: 'South Korea', region: 'AS', maxNationalLength: 9 },
  { code: '65', name: 'Singapore', region: 'AS', maxNationalLength: 8 },
  { code: '60', name: 'Malaysia', region: 'AS', maxNationalLength: 9 },
  { code: '62', name: 'Indonesia', region: 'AS', maxNationalLength: 10 },
  { code: '63', name: 'Philippines', region: 'AS', maxNationalLength: 10 },
  { code: '66', name: 'Thailand', region: 'AS', maxNationalLength: 9 },
  { code: '84', name: 'Vietnam', region: 'AS', maxNationalLength: 10 },
  { code: '27', name: 'South Africa', region: 'AF', maxNationalLength: 9 },
  { code: '233', name: 'Ghana', region: 'AF', maxNationalLength: 9 },
  { code: '254', name: 'Kenya', region: 'AF', maxNationalLength: 9 },
  { code: '256', name: 'Uganda', region: 'AF', maxNationalLength: 9 },
  { code: '20', name: 'Egypt', region: 'AF', maxNationalLength: 9 },
  { code: '55', name: 'Brazil', region: 'SA', maxNationalLength: 10 },
  { code: '52', name: 'Mexico', region: 'NA', maxNationalLength: 10 },
  { code: '61', name: 'Australia', region: 'OC', maxNationalLength: 9 },
  { code: '64', name: 'New Zealand', region: 'OC', maxNationalLength: 9 },
  { code: '7', name: 'Russia / Kazakhstan', region: 'EU', maxNationalLength: 10 },
  { code: '90', name: 'Turkey', region: 'EU', maxNationalLength: 10 },
  { code: '971', name: 'United Arab Emirates', region: 'ME', maxNationalLength: 9 },
  { code: '966', name: 'Saudi Arabia', region: 'ME', maxNationalLength: 9 },
  { code: '972', name: 'Israel', region: 'ME', maxNationalLength: 9 },
  { code: '380', name: 'Ukraine', region: 'EU', maxNationalLength: 9 },
  { code: '48', name: 'Poland', region: 'EU', maxNationalLength: 9 },
  { code: '351', name: 'Portugal', region: 'EU', maxNationalLength: 9 },
  { code: '30', name: 'Greece', region: 'EU', maxNationalLength: 10 },
]

function dataCountryForCode(dial) {
  const byLen = DATA_COUNTRY_CODES.slice().sort((a, b) => b.code.length - a.code.length)
  for (const c of byLen) {
    if (dial.startsWith(c.code) && dial.length > c.code.length) return c
  }
  return undefined
}

function dataCleanPhone(raw) {
  return raw.replace(/[\s\-().]/g, '').replace(/^00/, '+')
}

export function verifyEmail(input) {
  const started = Date.now()
  const value = (input ?? '').trim().toLowerCase()
  const findings = []
  let normalized = null
  const meta = {}

  if (!value) {
    findings.push({ id: 'email.empty', severity: 'high', message: 'Email address is empty.' })
  } else if (!DATA_EMAIL_RE.test(value)) {
    const at = value.split('@')
    if (at.length !== 2) findings.push({ id: 'email.syntax', severity: 'high', message: 'Email must contain exactly one @ and a local/domain part.' })
    else {
      if (!at[0]) findings.push({ id: 'email.local_empty', severity: 'high', message: 'Email is missing the local part.' })
      else if (at[0].length > 64) findings.push({ id: 'email.local_too_long', severity: 'medium', message: 'Local part exceeds 64 characters.' })
      const domain = at[1]
      if (!domain) findings.push({ id: 'email.domain_empty', severity: 'high', message: 'Email is missing the domain part.' })
      else {
        const labels = domain.split('.')
        if (labels.some((l) => !l || l.length > 63)) findings.push({ id: 'email.domain_labels', severity: 'medium', message: 'Domain has an empty or over-long label.' })
        if (!domain.includes('.')) findings.push({ id: 'email.domain_tld', severity: 'high', message: 'Domain must include a top-level label (e.g. example.com).' })
      }
    }
  } else {
    normalized = value
    const [, domain] = value.split('@')
    const local = value.split('@')[0]
    if (DATA_ROLE_ACCOUNTS.has(local)) findings.push({ id: 'email.role_account', severity: 'low', message: `Role account (${local}@) — may be a shared mailbox.` })
    if (DATA_DISPOSABLE_DOMAINS.has(domain)) findings.push({ id: 'email.disposable', severity: 'high', message: `Disposable email domain: ${domain}.` })
    if (DATA_FREE_PROVIDERS.has(domain)) findings.push({ id: 'email.free_provider', severity: 'info', message: `Free consumer provider: ${domain}.` })
    for (const t of DATA_EMAIL_TYPOS) {
      if (t.re.test(domain)) findings.push({ id: t.id, severity: 'medium', message: `Possible typo for "${t.correct}" — confirm before sending.` })
    }
  }

  if (normalized) {
    meta.local = normalized.split('@')[0]
    meta.domain = normalized.split('@')[1]
    meta.disposable = DATA_DISPOSABLE_DOMAINS.has(normalized.split('@')[1])
    meta.role = DATA_ROLE_ACCOUNTS.has(normalized.split('@')[0])
    meta.freeProvider = DATA_FREE_PROVIDERS.has(normalized.split('@')[1])
  }

  const ok = !findings.some((f) => f.severity === 'high')
  return { ok, product: 'verifylane', version: VERIFYLANE_VERSION, type: 'email', input, normalized, findings, meta, durationMs: Date.now() - started }
}

export function verifyPhone(input, options = {}) {
  const started = Date.now()
  const value = (input ?? '').trim()
  const findings = []
  let normalized = null
  const meta = {}

  if (!value) {
    findings.push({ id: 'phone.empty', severity: 'high', message: 'Phone number is empty.' })
  } else {
    const cleaned = dataCleanPhone(value)
    if (!/^\+?\d{6,15}$/.test(cleaned)) {
      if (cleaned.length === 0) findings.push({ id: 'phone.no_digits', severity: 'high', message: 'Phone number contains no digits.' })
      else if (cleaned.length > 15) findings.push({ id: 'phone.too_long', severity: 'medium', message: 'Phone number exceeds 15 digits.' })
      else if (cleaned.length < 6) findings.push({ id: 'phone.too_short', severity: 'high', message: 'Phone number is too short to be valid.' })
      else findings.push({ id: 'phone.invalid_chars', severity: 'high', message: 'Phone number contains unexpected characters.' })
    } else if (cleaned.startsWith('+')) {
      const country = dataCountryForCode(cleaned.slice(1))
      if (!country) findings.push({ id: 'phone.unknown_country', severity: 'medium', message: 'Could not match a known country dialing code.' })
      else {
        normalized = `+${cleaned.slice(1)}`
        meta.countryCode = `+${country.code}`
        meta.country = country.name
        meta.region = country.region
        const national = cleaned.slice(1).slice(country.code.length)
        meta.national = national
        if (national.length < 6 || national.length > country.maxNationalLength + 2) {
          findings.push({ id: 'phone.national_length', severity: 'medium', message: `National number length looks implausible for ${country.name}.` })
        }
      }
    } else {
      if (options.country) {
        const target = DATA_COUNTRY_CODES.find((c) => c.name.includes(options.country))
        if (target) {
          meta.countryCode = `+${target.code}`
          meta.country = target.name
          meta.region = target.region
          normalized = `+${target.code}${cleaned}`
          meta.national = cleaned
        } else {
          findings.push({ id: 'phone.unknown_country_hint', severity: 'low', message: `Could not map country hint "${options.country}" to a dialing code.` })
          normalized = cleaned
        }
      } else {
        findings.push({ id: 'phone.no_country_code', severity: 'medium', message: 'No + country code and no country hint provided — cannot verify international validity.' })
        normalized = cleaned
      }
    }
  }

  const ok = !findings.some((f) => f.severity === 'high') && !findings.some((f) => f.id === 'phone.unknown_country' || f.id === 'phone.no_country_code')
  return { ok, product: 'verifylane', version: VERIFYLANE_VERSION, type: 'phone', input, normalized, findings, meta, durationMs: Date.now() - started }
}

function dataClassifyIpv4(octets) {
  const [a, b] = octets
  if (a === 127) return 'loopback'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade-nat'
  if (a >= 224 && a <= 239) return 'multicast'
  if (a >= 240) return 'reserved'
  if (a === 0) return 'reserved'
  return 'public'
}

function dataClassifyIpv6(groups) {
  const first = groups[0]?.toLowerCase()
  const text = groups.join(':')
  if (text === '::1') return 'loopback'
  if (text === '::') return 'unspecified'
  if (first === 'fc' || first === 'fd') return 'unique-local'
  const f2 = first?.slice(0, 2)
  if (f2 === 'ff') return 'multicast'
  if (first?.startsWith('fe8')) return 'link-local'
  return 'public'
}

export function verifyIp(input) {
  const started = Date.now()
  const value = (input ?? '').trim()
  const findings = []
  let normalized = null
  const meta = {}

  if (!value) {
    findings.push({ id: 'ip.empty', severity: 'high', message: 'IP address is empty.' })
  } else {
    const colonCount = (value.match(/:/g) || []).length
    const dotCount = (value.match(/\./g) || []).length

    if (dotCount === 3 && colonCount === 0) {
      const octets = value.split('.').map((o) => {
        if (!/^\d{1,3}$/.test(o)) return -1
        return Number(o)
      })
      if (octets.every((o) => o >= 0 && o <= 255)) {
        normalized = octets.join('.')
        meta.version = 4
        meta.classification = dataClassifyIpv4(octets)
        meta.isPrivate = ['private', 'loopback', 'link-local', 'carrier-grade-nat'].includes(meta.classification)
        return { ok: true, product: 'verifylane', version: VERIFYLANE_VERSION, type: 'ip', input, normalized, findings, meta, durationMs: Date.now() - started }
      }
      findings.push({ id: 'ip.v4_octet_range', severity: 'high', message: 'IPv4 octet out of 0–255 range.' })
    } else if (colonCount >= 2 && dotCount === 0) {
      let addr = value.toLowerCase()
      let groups = []
      if (addr.includes('::')) {
        const sides = addr.split('::')
        const left = sides[0] ? sides[0].split(':') : []
        const right = sides[1] ? sides[1].split(':') : []
        const missing = 8 - left.length - right.length
        if (missing < 1) findings.push({ id: 'ip.v6_compression', severity: 'high', message: 'IPv6 :: compression used incorrectly (too many groups).' })
        else groups = [...left, ...Array(missing).fill('0'), ...right]
      } else {
        groups = addr.split(':')
      }
      const validGroups = groups.length === 8 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))
      if (validGroups) {
        const expanded = groups.join(':')
        normalized = expanded
        meta.version = 6
        meta.classification = dataClassifyIpv6(groups)
        meta.isPrivate = ['loopback', 'unique-local', 'link-local'].includes(meta.classification)
        meta.expanded = expanded
        return { ok: true, product: 'verifylane', version: VERIFYLANE_VERSION, type: 'ip', input, normalized, findings, meta, durationMs: Date.now() - started }
      }
      findings.push({ id: 'ip.v6_hextets', severity: 'high', message: 'IPv6 must have 8 hextets of 0–4 hex digits each.' })
    } else {
      findings.push({ id: 'ip.syntax', severity: 'high', message: 'Not a valid IPv4 or IPv6 address.' })
    }
  }

  return { ok: false, product: 'verifylane', version: VERIFYLANE_VERSION, type: 'ip', input, normalized, findings, meta, durationMs: Date.now() - started }
}

export function verifyData(input) {
  const started = Date.now()
  const values = input.values ?? []
  const results = values.map((v) => {
    if (v.type === 'email') return verifyEmail(v.value)
    if (v.type === 'phone') return verifyPhone(v.value, { country: v.country })
    return verifyIp(v.value)
  })
  const valid = results.filter((r) => r.ok).length
  return {
    ok: valid === results.length,
    product: 'verifylane',
    version: VERIFYLANE_VERSION,
    mode: 'data',
    checked: results.length,
    valid,
    invalid: results.length - valid,
    results,
    durationMs: Date.now() - started,
  }
}

export function getVerifyLanePricing() {
  return {
    product: 'verifylane',
    version: VERIFYLANE_VERSION,
    credits: {
      'verifylane.secrets': 3,
      'verifylane.security': 5,
      'verifylane.quality': 3,
      'verifylane.code': 8,
      'verifylane.diff': 8,
      'verifylane.agent-output': 5,
      'verifylane.email': 1,
      'verifylane.phone': 1,
      'verifylane.ip': 1,
      'verifylane.data': 2,
    },
    note: 'Deterministic verification — no LLM. Secrets/security/quality heuristics for agent code and diffs, plus email/phone/IP data validation.',
  }
}

export function getVerifyLaneCapabilities() {
  return {
    product: 'verifylane',
    version: VERIFYLANE_VERSION,
    endpoints: [
      'GET /v1/verifylane/health',
      'GET /v1/verifylane/pricing',
      'GET /v1/verifylane/capabilities',
      'POST /v1/verifylane/secrets',
      'POST /v1/verifylane/security',
      'POST /v1/verifylane/quality',
      'POST /v1/verifylane/code',
      'POST /v1/verifylane/diff',
      'POST /v1/verifylane/agent-output',
      'POST /v1/verifylane/email',
      'POST /v1/verifylane/phone',
      'POST /v1/verifylane/ip',
      'POST /v1/verifylane/data',
    ],
    outputs: ['findings[]', 'severity summary', 'ok pass/fail', 'normalized value + metadata'],
    limitations: [
      'Heuristic patterns only — not a full SAST suite',
      'No language-server semantic analysis in v0.1',
      'Diff mode only scans added lines',
      'Phone/email/IP checks are deterministic (syntax + heuristics) — no carrier/disposability network lookups',
    ],
  }
}
