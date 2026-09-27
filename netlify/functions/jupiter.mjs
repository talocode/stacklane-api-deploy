/**
 * Solana token lookup by mint address, plus the risk signals worth reporting.
 *
 * This exists because the market-data provider gates its address-level lookup
 * behind a plan we do not have, while this source resolves a mint directly and
 * is already a dependency for pricing. For Solana tokens it is the better
 * source: same chain as the tokens being checked, and it returns audit flags
 * rather than only identity.
 *
 * Cached for the same reason as the other market client: one upstream call has
 * to serve many callers, and concurrent callers for the same mint share one
 * request.
 */

import { riskFindings } from './token-risk.mjs'

const BASE = 'https://api.jup.ag'
const TTL_MS = Number(process.env.JUPITER_TTL_MS || 10 * 60 * 1000)

export const JUPITER_VERSION = '0.1.0'

const cache = new Map()
const inflight = new Map()

export function jupiterConfigured() {
  return Boolean(process.env.JUPITER_API_KEY)
}

export function clearJupiterCache() {
  cache.clear()
  inflight.clear()
}

export function jupiterCacheSize() {
  return cache.size
}

/** Solana mints are base58 and 32 bytes, so 32 to 44 characters. */
export function looksLikeSolanaMint(value) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim())
}

function normalise(row) {
  const audit = row.audit || {}
  return {
    address: row.id || null,
    name: row.name || null,
    symbol: row.symbol || null,
    icon: row.icon || null,
    decimals: row.decimals ?? null,
    channels: {
      twitter: row.twitter || null,
      telegram: row.telegram || null,
      website: row.website || null,
    },
    dev: row.dev || null,
    launchpad: row.launchpad || null,
    holderCount: row.holderCount ?? null,
    supply: row.totalSupply ?? null,
    circulatingSupply: row.circSupply ?? null,
    mcapUsd: row.mcap ?? null,
    fdvUsd: row.fdv ?? null,
    priceUsd: row.usdPrice ?? null,
    liquidityUsd: row.liquidity ?? null,
    organicScore: row.organicScore ?? null,
    organicScoreLabel: row.organicScoreLabel || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: row.createdAt || null,
    audit: {
      mintAuthorityDisabled: audit.mintAuthorityDisabled ?? null,
      freezeAuthorityDisabled: audit.freezeAuthorityDisabled ?? null,
      topHoldersPercentage: audit.topHoldersPercentage ?? null,
    },
  }
}

async function jupiterGet(path, params = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch
  const now = deps.now || (() => Date.now())
  const key = process.env.JUPITER_API_KEY || ''
  if (!key) {
    const err = new Error('Solana token data is not configured on this deployment.')
    err.code = 'not_configured'
    throw err
  }
  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`

  const hit = cache.get(url)
  if (hit && now() - hit.at < TTL_MS) return { ...hit.value, cached: true }
  if (inflight.has(url)) return inflight.get(url)

  const pending = (async () => {
    const res = await fetchImpl(url, { headers: { 'x-api-key': key, accept: 'application/json' } })
    const body = await res.json().catch(() => null)
    if (!res.ok || body == null) {
      const err = new Error(body && body.message ? body.message : `Upstream returned ${res.status}`)
      err.code = res.status === 404 ? 'not_found' : 'upstream_error'
      throw err
    }
    const value = { data: body }
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

/**
 * Look a token up by mint address.
 *
 * The search endpoint matches on text, so the exact mint is confirmed against
 * the returned `id` rather than trusting the first row. A query for a mint also
 * returns partial matches, and returning one of those as if it were the token
 * asked about is precisely the mistake this check exists to prevent.
 */
export async function lookupTokenByMint(address, deps = {}) {
  const mint = String(address || '').trim()
  if (!looksLikeSolanaMint(mint)) {
    const err = new Error('That does not look like a Solana mint address.')
    err.code = 'invalid_mint'
    throw err
  }
  const { data, cached } = await jupiterGet('/tokens/v2/search', { query: mint }, deps)
  const rows = Array.isArray(data) ? data : []
  const exact = rows.find((r) => r && r.id === mint)
  return { mint, found: Boolean(exact), token: exact ? normalise(exact) : null, candidates: rows.length, cached }
}
