export const LOOP_VERSION = '0.2.0'
export const LOOP_CREDIT = 1
const MAX_SOURCES = 5
const MAX_BYTES = 200_000
const MAX_REDIRECTS = 3

function privateIPv4(host) {
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

export function assertPublicHttps(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error('url must be https')
  }
  if (url.protocol !== 'https:') throw new Error('url must be https')
  if (url.username || url.password) throw new Error('url must not include credentials')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('url must be a public https address')
  }
  if (host.includes(':') || privateIPv4(host)) throw new Error('url must be a public https address')
  return url
}

async function fetchPublic(urlString, timeoutMs = 8000) {
  const started = Date.now()
  let current = assertPublicHttps(urlString).toString()
  let redirects = 0
  while (redirects <= MAX_REDIRECTS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'talocode-loop/0.2', accept: 'text/plain,text/markdown,text/html,application/json' },
      })
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get('location')
        if (!next) return { url: current, ok: false, status: response.status, bytes: 0, ms: Date.now() - started, error: `HTTP ${response.status}`, text: '' }
        current = assertPublicHttps(new URL(next, current)).toString()
        redirects += 1
        continue
      }
      const raw = await response.text()
      const text = raw.slice(0, MAX_BYTES)
      return {
        url: current,
        ok: response.ok,
        status: response.status,
        bytes: raw.length,
        truncated: raw.length > text.length,
        ms: Date.now() - started,
        error: response.ok ? null : `HTTP ${response.status}`,
        text,
      }
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'timeout' : (error?.message || 'fetch failed')
      return { url: current, ok: false, status: 0, bytes: 0, truncated: false, ms: Date.now() - started, error: message, text: '' }
    } finally {
      clearTimeout(timer)
    }
  }
  return { url: current, ok: false, status: 0, bytes: 0, truncated: false, ms: Date.now() - started, error: 'too many redirects', text: '' }
}

export function creditsForLoaded(loaded) {
  const count = Math.max(0, Math.floor(Number(loaded) || 0))
  return count * LOOP_CREDIT
}

export async function runHostedLoop({ query, url, claim }) {
  if (!query || typeof query !== 'string') throw new Error('query is required')
  if (!claim || typeof claim !== 'string') throw new Error('claim is required')
  assertPublicHttps(url)
  const source = await fetchPublic(url)
  const words = query.split(/\s+/).filter((word) => word.length > 3)
  const matches = source.text.split('\n').filter((line) => words.some((word) => line.toLowerCase().includes(word.toLowerCase()))).slice(0, 8)
  const found = source.ok && source.text.includes(claim)
  const loaded = source.ok ? 1 : 0
  return {
    ok: found,
    product: '@talocode/loop',
    version: LOOP_VERSION,
    query,
    url: source.url,
    loaded,
    credits: creditsForLoaded(loaded),
    steps: [
      { name: 'search', ok: source.ok, status: source.status, ms: source.ms, matches, error: source.error },
      { name: 'verify', ok: found, claim, found, error: found ? null : 'claim not present in searched source' },
      { name: 'trace', ok: source.ok && found },
      { name: 'remember', ok: true, stored: 'receipt' },
    ],
  }
}

export async function runHostedBrief({ question, urls }) {
  const list = [...new Set((Array.isArray(urls) ? urls : []).map((url) => String(url).trim()).filter(Boolean))].slice(0, MAX_SOURCES)
  if (!list.length) throw new Error('at least one url is required')
  for (const url of list) assertPublicHttps(url)
  const sources = []
  for (const url of list) {
    const source = await fetchPublic(url)
    const { text, ...row } = source
    sources.push(row)
  }
  const failed = sources.filter((source) => !source.ok)
  const loaded = sources.length - failed.length
  return {
    ok: failed.length === 0,
    product: '@talocode/loop',
    version: LOOP_VERSION,
    question: typeof question === 'string' ? question : '',
    recommendation: failed.length ? 'do_not_ship' : 'review',
    reason: failed.length
      ? 'At least one named source failed. A missing source is not treated as agreement.'
      : 'Every named source responded. This is a review queue, not a decision to ship.',
    loaded,
    credits: creditsForLoaded(loaded),
    sources,
  }
}

export function getLoopPricing() {
  return {
    service: 'loop',
    version: LOOP_VERSION,
    credits: {
      'loop.run': '1 per source that loads. A failed fetch is free.',
      'loop.brief': '1 per source that loads, up to 5. A failed fetch is free.',
    },
  }
}

export function getLoopCapabilities() {
  return {
    service: 'loop',
    version: LOOP_VERSION,
    summary: 'Search a public page, verify a claim, and keep the receipt. Same call locally and hosted.',
    endpoints: ['/v1/loop/health', '/v1/loop/pricing', '/v1/loop/capabilities', '/v1/loop/run', '/v1/loop/brief'],
  }
}
