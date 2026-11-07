import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPublicHttps, creditsForLoaded } from '../netlify/functions/loop-engine.mjs'

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
