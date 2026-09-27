/**
 * Market-data client for the token identity check, with a cache in front of it.
 *
 * The cache is not an optimisation here, it is a requirement. The account has
 * 15,000 upstream credits a month and one user request can need two upstream
 * calls, so without a cache a modest amount of traffic exhausts the month. Every
 * response is cached for CMC_TTL_MS and concurrent callers for the same URL share
 * a single request, so a burst costs one upstream credit rather than one each.
 *
 * The key lives in the environment and never leaves the server. Nothing in a
 * request or response from a caller can change which upstream URL is called
 * beyond the validated keyword and network below.
 *
 * Field names are abbreviated upstream (n, s, addr, plt, w, x, l, pu), so every
 * response is normalised here. Callers never see the upstream shape.
 */

const BASE = 'https://pro-api.coinmarketcap.com'
const TTL_MS = Number(process.env.CMC_TTL_MS || 10 * 60 * 1000)

export const CMC_VERSION = '0.1.0'

/** Upstream credits the identity check spends: one search call. */
export const TOKEN_IDENTITY_UPSTREAM_CREDITS = 1

// url -> { at, value }
const cache = new Map()
// url -> promise, so simultaneous callers make one upstream call
const inflight = new Map()

export function cmcConfigured() {
  return Boolean(process.env.COINMARKET_API_KEY)
}

/** Test seam. Also used by the health route to prove a cold cache. */
export function clearCmcCache() {
  cache.clear()
  inflight.clear()
}

export function cmcCacheSize() {
  return cache.size
}

async function cmcGet(path, params = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch
  const now = deps.now || (() => Date.now())
  const key = process.env.COINMARKET_API_KEY || ''
  if (!key) {
    const err = new Error('Market data is not configured on this deployment.')
    err.code = 'not_configured'
    throw err
  }

  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`

  const hit = cache.get(url)
  if (hit && now() - hit.at < TTL_MS) return { ...hit.value, cached: true }
  if (inflight.has(url)) return inflight.get(url)

  const pending = (async () => {
    const res = await fetchImpl(url, {
      headers: { 'X-CMC_PRO_API_KEY': key, accept: 'application/json' },
    })
    const body = await res.json().catch(() => null)
    const status = (body && body.status) || {}
    // error_code is the string "0" on success, and "0" is truthy in JavaScript, so
    // a bare truthiness check rejects every successful response. Compare the value
    // rather than its truthiness.
    const errorCode = status.error_code
    const failed =
      !res.ok ||
      !body ||
      (errorCode !== undefined &&
        errorCode !== null &&
        String(errorCode) !== '' &&
        String(errorCode) !== '0')
    if (failed) {
      const message = status.error_message || `Upstream returned ${res.status}`
      const err = new Error(message)
      err.upstreamStatus = res.status
      // Some endpoints are plan-gated but report it as a generic upstream
      // failure. Treat the explicit message as the authority, and anything that
      // looks like a server error as a gate too, so callers get a straight
      // answer about the plan rather than a retry loop.
      err.code = /plan|subscri/i.test(message)
        ? 'plan_unsupported'
        : res.status >= 500
          ? 'upstream_unavailable'
          : 'upstream_error'
      throw err
    }
    const value = { data: body.data, upstreamCredits: status.credit_count ?? null }
    cache.set(url, { at: now(), value })
    return { ...value, cached: false }
  })()

  inflight.set(url, pending)
  try {
    return await pending
  } finally {
    inflight.delete(url)
  }
}

/** Upstream abbreviates every field. Normalise once, here. */
function normaliseToken(row) {
  return {
    name: row.n || null,
    // The feed uses the literal string "NULL" when a token has no symbol.
    symbol: row.s && row.s !== 'NULL' ? row.s : null,
    platform: row.plt || null,
    platformId: row.pltId ?? null,
    platformCryptoId: row.plti ?? null,
    address: row.addr || null,
    website: row.w || null,
    x: row.x || null,
    logo: row.l || null,
    priceUsd: row.pu != null && row.pu !== '' ? Number(row.pu) : null,
    change24h: row.pc24h != null ? Number(row.pc24h) : null,
    decimals: row.dec ?? null,
  }
}

/**
 * Resolve a keyword (name or symbol) to candidate tokens with their contract
 * address and official channels.
 *
 * Note the limit, and do not paper over it: this endpoint matches on a keyword,
 * not on a contract address. Address-level verification needs the DEX token
 * endpoint, which this plan does not include.
 */
export async function lookupTokenIdentity({ keyword, network } = {}, deps = {}) {
  const q = String(keyword || '').trim()
  if (!q) {
    const err = new Error('keyword is required')
    err.code = 'invalid_request'
    throw err
  }
  const { data, cached, upstreamCredits } = await cmcGet('/v1/dex/search', { keyword: q }, deps)
  const rows = (data && data.tks) || []
  const wanted = network ? String(network).trim().toLowerCase() : null
  const tokens = rows
    .map(normaliseToken)
    .filter((t) => t.address || t.name)
    .filter((t) => (wanted ? String(t.platform || '').toLowerCase() === wanted : true))
    .slice(0, 10)
  return { keyword: q, network: wanted, tokens, matched: rows.length, cached, upstreamCredits }
}

/** Official channels worth telling a caller about, when present. */
function channelFindings(token) {
  const out = []
  if (token.website) out.push({ kind: 'website', value: token.website })
  if (token.x) out.push({ kind: 'x', value: token.x })
  return out
}

function summarize(findings) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: findings.length }
  for (const f of findings) summary[f.severity] = (summary[f.severity] || 0) + 1
  return summary
}

/**
 * Token identity check, in the verifylane findings shape.
 *
 * Deliberately honest about what it can and cannot establish. It can say which
 * token a name or symbol resolves to, on which chain, and where its official
 * channels point. It cannot confirm that a given contract address is genuine,
 * because that lookup is plan-gated, and it says so rather than implying a
 * verification it did not perform.
 */
export async function verifyTokenIdentity(input = {}, deps = {}) {
  const started = Date.now()
  const findings = []
  const keyword = String(input.keyword || input.symbol || input.name || '').trim()
  const address = input.address ? String(input.address).trim() : null
  const network = input.network ? String(input.network).trim().toLowerCase() : null

  let tokens = []
  let cached = false
  let upstreamCredits = null
  let upstreamError = null

  if (!cmcConfigured()) {
    findings.push({
      id: 'token.not_configured',
      rule: 'token.not_configured',
      severity: 'high',
      message: 'Market data is not configured on this deployment, so identity cannot be resolved.',
    })
  } else {
    // A bare address is the question we cannot answer on this plan. Say that
    // plainly instead of searching for the address text and returning noise.
    if (address && !keyword) {
      findings.push({
        id: 'token.address_lookup_unavailable',
        rule: 'token.address_lookup_unavailable',
        severity: 'high',
        message:
          'Looking a token up by contract address needs a market-data plan that includes the DEX token endpoint. Supply a name or symbol instead, or upgrade the plan to verify an address directly.',
      })
    } else if (keyword) {
      try {
        const res = await lookupTokenIdentity({ keyword, network }, deps)
        tokens = res.tokens
        cached = res.cached
        upstreamCredits = res.upstreamCredits
      } catch (err) {
        upstreamError = err.code || 'upstream_error'
        findings.push({
          id: `token.${upstreamError}`,
          rule: `token.${upstreamError}`,
          // Always high: a lookup that could not be completed must never read as
          // a pass, so ok stays false and nothing downstream treats it as cleared.
          severity: 'high',
          message:
            upstreamError === 'plan_unsupported'
              ? 'This market-data plan does not include the endpoint needed for that lookup.'
              : `The market-data provider could not answer right now: ${err.message}`,
        })
      }
    } else {
      findings.push({
        id: 'token.no_query',
        rule: 'token.no_query',
        severity: 'medium',
        message: 'Provide a name or symbol, or a contract address.',
      })
    }
  }

  for (const t of tokens) {
    findings.push({
      id: `token.match:${t.address || t.name}`,
      rule: 'token.match',
      severity: 'info',
      message: `${t.name || 'Unnamed token'}${t.symbol ? ` (${t.symbol})` : ''} on ${t.platform || 'unknown chain'}`,
      token: {
        name: t.name,
        symbol: t.symbol,
        platform: t.platform,
        address: t.address,
        priceUsd: t.priceUsd,
        change24h: t.change24h,
        decimals: t.decimals,
      },
      channels: channelFindings(t),
    })
  }

  if (tokens.length > 1) {
    findings.push({
      id: 'token.multiple_matches',
      rule: 'token.multiple_matches',
      severity: 'medium',
      message: `${tokens.length} tokens match that keyword. Do not treat the first as authoritative; match the contract and platform before trusting a channel.`,
    })
  }

  return {
    ok: findings.every((f) => f.severity !== 'critical' && f.severity !== 'high'),
    product: 'verifylane',
    version: CMC_VERSION,
    mode: 'token',
    query: { keyword: keyword || null, address, network },
    tokens,
    findings,
    summary: summarize(findings),
    upstream: { cached, credits: upstreamCredits, error: upstreamError },
    limitations: [
      'Keyword matching, not contract-address verification: that endpoint is not on this plan.',
      'Presence in the feed is not a safety assertion about the token.',
      'A matching name does not mean a matching contract. Compare the address before trusting it.',
    ],
    durationMs: Date.now() - started,
  }
}
