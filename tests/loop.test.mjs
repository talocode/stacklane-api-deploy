import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPublicHttps, creditsForLoaded, excerptFor, judgeClaims, summarizeAudit, normalizeClaims } from '../netlify/functions/loop-engine.mjs'

test('loop only accepts a public https url', () => {
  assert.equal(assertPublicHttps('https://talocode.site/llms.txt').hostname, 'talocode.site')
  for (const url of [
    'http://talocode.site',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest',
    'https://10.0.0.1/x',
    'https://user:pass@talocode.site/',
  ]) {
    assert.throws(() => assertPublicHttps(url), url)
  }
})

test('a failed source does not spend a credit', () => {
  assert.equal(creditsForLoaded(0), 0)
  assert.equal(creditsForLoaded(1), 1)
  assert.equal(creditsForLoaded(3), 3)
})

test('one page load checks several claims for one credit', () => {
  const page = [
    'Official Solana mint: 6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory',
    'Supply: 500,000 TCODE fixed. Mint and freeze revoked.',
  ].join('\n')
  const claims = normalizeClaims([
    '6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory',
    '500,000 TCODE fixed',
    '500,000 TCODE fixed',
    'unlimited supply',
  ])
  assert.equal(claims.length, 3)
  const results = judgeClaims(page, claims)
  assert.equal(results[0].found, true)
  assert.match(results[0].excerpt, /6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory/)
  assert.equal(results[1].found, true)
  assert.equal(results[2].found, false)
  assert.equal(results[2].excerpt, null)
  assert.equal(summarizeAudit({ loaded: 1, results }), 'The page loaded. 2 of 3 claims were in it. One credit.')
  assert.equal(creditsForLoaded(1), 1)
  const long = 'word '.repeat(80) + 'NEEDLE ' + 'tail '.repeat(80)
  assert.ok(excerptFor(long, 'NEEDLE').length <= 182)
  assert.match(excerptFor(long, 'NEEDLE'), /NEEDLE/)
})
