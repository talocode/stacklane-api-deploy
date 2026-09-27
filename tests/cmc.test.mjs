import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  verifyTokenIdentity,
  lookupTokenIdentity,
  clearCmcCache,
  cmcConfigured,
  cmcCacheSize,
} from '../netlify/functions/cmc.mjs'

// One upstream row, in the abbreviated shape the feed actually returns.
const ROW = {
  pltId: 16,
  plt: 'Solana',
  plti: 5426,
  n: 'Example',
  s: 'EXM',
  addr: 'ExAmPle111111111111111111111111111111111111',
  w: 'https://example.test',
  x: 'https://x.com/example',
  l: 'https://cdn.example.test/logo.png',
  pu: '0.25',
  pc24h: 4.5,
  dec: 6,
}

function fakeFetch(rows, capture) {
  return async (url) => {
    if (capture) capture.push(url)
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: { credit_count: 1 }, data: { total: rows.length, tks: rows } }),
    }
  }
}

function failingFetch(status, message, capture) {
  return async (url) => {
    if (capture) capture.push(url)
    return {
      ok: false,
      status,
      json: async () => ({ status: { error_code: String(status), error_message: message } }),
    }
  }
}

const withKey = (fn) => {
  const prior = process.env.COINMARKET_API_KEY
  process.env.COINMARKET_API_KEY = 'test-key'
  clearCmcCache()
  return Promise.resolve(fn()).finally(() => {
    if (prior === undefined) delete process.env.COINMARKET_API_KEY
    else process.env.COINMARKET_API_KEY = prior
    clearCmcCache()
  })
}

test('a successful response carrying error_code "0" is not treated as a failure', async () => {
  await withKey(async () => {
    // The provider sends error_code as the string "0" on success, which is truthy.
    const res = await verifyTokenIdentity(
      { keyword: 'example' },
      {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            status: { error_code: '0', error_message: '', credit_count: 1 },
            data: { total: 1, tks: [ROW] },
          }),
        }),
      },
    )
    assert.equal(res.upstream.error, null)
    assert.equal(res.tokens.length, 1)
    assert.equal(res.ok, true)
  })
})

test('one upstream call serves repeated identical lookups', async () => {
  await withKey(async () => {
    const seen = []
    const deps = { fetchImpl: fakeFetch([ROW], seen) }
    const first = await lookupTokenIdentity({ keyword: 'example' }, deps)
    const second = await lookupTokenIdentity({ keyword: 'example' }, deps)
    assert.equal(seen.length, 1, 'second lookup should be served from cache')
    assert.equal(first.cached, false)
    assert.equal(second.cached, true)
    assert.equal(second.tokens.length, 1)
  })
})

test('simultaneous callers share a single upstream call', async () => {
  await withKey(async () => {
    const seen = []
    const deps = { fetchImpl: fakeFetch([ROW], seen) }
    const [a, b, c] = await Promise.all([
      lookupTokenIdentity({ keyword: 'same' }, deps),
      lookupTokenIdentity({ keyword: 'same' }, deps),
      lookupTokenIdentity({ keyword: 'same' }, deps),
    ])
    assert.equal(seen.length, 1, 'a burst should not become one request each')
    assert.equal(a.tokens.length, 1)
    assert.equal(b.tokens.length, 1)
    assert.equal(c.tokens.length, 1)
  })
})

test('expired entries are refetched', async () => {
  await withKey(async () => {
    const seen = []
    let clock = 1_000_000
    const deps = { fetchImpl: fakeFetch([ROW], seen), now: () => clock }
    await lookupTokenIdentity({ keyword: 'ttl' }, deps)
    clock += 11 * 60 * 1000 // past the 10 minute window
    await lookupTokenIdentity({ keyword: 'ttl' }, deps)
    assert.equal(seen.length, 2, 'a stale entry should not be served')
  })
})

test('abbreviated upstream fields are normalised, and "NULL" is treated as no symbol', async () => {
  await withKey(async () => {
    const deps = { fetchImpl: fakeFetch([{ ...ROW, s: 'NULL' }]) }
    const { tokens } = await lookupTokenIdentity({ keyword: 'example' }, deps)
    assert.deepEqual(tokens[0], {
      name: 'Example',
      symbol: null,
      platform: 'Solana',
      platformId: 16,
      platformCryptoId: 5426,
      address: ROW.addr,
      website: 'https://example.test',
      x: 'https://x.com/example',
      logo: 'https://cdn.example.test/logo.png',
      priceUsd: 0.25,
      change24h: 4.5,
      decimals: 6,
    })
  })
})

test('network filter narrows matches', async () => {
  await withKey(async () => {
    const other = { ...ROW, plt: 'Base', addr: '0xbase' }
    const deps = { fetchImpl: fakeFetch([ROW, other]) }
    const { tokens } = await lookupTokenIdentity({ keyword: 'example', network: 'solana' }, deps)
    assert.equal(tokens.length, 1)
    assert.equal(tokens[0].platform, 'Solana')
  })
})

test('a plan-gated or failing upstream becomes a finding, not a thrown error', async () => {
  await withKey(async () => {
    const deps = { fetchImpl: failingFetch(500, 'The system is busy, please try again later!') }
    const result = await verifyTokenIdentity({ keyword: 'anything' }, deps)
    assert.equal(result.ok, false)
    assert.equal(result.upstream.error, 'upstream_unavailable')
    assert.ok(
      result.findings.some((f) => f.rule === 'token.upstream_unavailable'),
      'the failure should be reported as a finding',
    )
  })
})

test('an explicit plan message is reported as plan_unsupported', async () => {
  await withKey(async () => {
    const deps = {
      fetchImpl: failingFetch(403, "Your API Key subscription plan doesn't support this endpoint"),
    }
    const result = await verifyTokenIdentity({ keyword: 'anything' }, deps)
    assert.equal(result.upstream.error, 'plan_unsupported')
    assert.match(result.findings[0].message, /plan/i)
  })
})

test('an address-only query says the lookup is unavailable rather than searching for the address text', async () => {
  await withKey(async () => {
    const seen = []
    const result = await verifyTokenIdentity(
      { address: '6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory' },
      { fetchImpl: fakeFetch([ROW], seen) },
    )
    assert.equal(seen.length, 0, 'no upstream call should be made for an address-only query')
    assert.ok(result.findings.some((f) => f.rule === 'token.address_lookup_unavailable'))
    assert.equal(result.ok, false)
  })
})

test('an unconfigured deployment reports it without calling upstream', async () => {
  const prior = process.env.COINMARKET_API_KEY
  delete process.env.COINMARKET_API_KEY
  clearCmcCache()
  try {
    assert.equal(cmcConfigured(), false)
    const seen = []
    const result = await verifyTokenIdentity({ keyword: 'btc' }, { fetchImpl: fakeFetch([ROW], seen) })
    assert.equal(seen.length, 0)
    assert.ok(result.findings.some((f) => f.rule === 'token.not_configured'))
  } finally {
    if (prior !== undefined) process.env.COINMARKET_API_KEY = prior
    clearCmcCache()
  }
})

test('multiple matches are flagged rather than the first being presented as authoritative', async () => {
  await withKey(async () => {
    const second = { ...ROW, addr: 'Other1111111111111111111111111111111111111', n: 'Example Two' }
    const deps = { fetchImpl: fakeFetch([ROW, second]) }
    const result = await verifyTokenIdentity({ keyword: 'example' }, deps)
    assert.equal(result.tokens.length, 2)
    assert.ok(result.findings.some((f) => f.rule === 'token.multiple_matches'))
    assert.equal(cmcCacheSize(), 1)
  })
})
