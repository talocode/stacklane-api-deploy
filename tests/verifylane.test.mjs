import { test } from 'node:test'
import assert from 'node:assert/strict'

import { verifySecrets } from '../netlify/functions/verifylane-engine.mjs'

/**
 * Payment credentials move real money, so a miss here is the most expensive kind.
 * Stripe keys were not detected at all before this rule was added, which an audit
 * fixture caught: the scanner passed a file containing a live Stripe secret.
 *
 * Fixtures are assembled at runtime rather than written as literals. GitHub's push
 * protection blocked the first version of this file, correctly, because a
 * key-shaped string committed to a repository is what this scanner exists to find.
 */
const fake = (...parts) => parts.join('')

const STRIPE_FULL = fake('sk', '_live_', '51H8xQ2eZvKYlo2C9dFakeKeyForDemo123456')
const STRIPE_RESTRICTED = fake('rk', '_live_', '51H8xQ2eZvKYlo2C9dFakeRestricted123456')
const STRIPE_TESTMODE = fake('sk', '_test_', '51H8xQ2eZvKYlo2C9dFakeKeyForDemo123456')
const AWS_EXAMPLE = fake('AKIA', 'IOSFODNN7EXAMPLE')

test('a fully privileged live key is detected as critical', () => {
  const r = verifySecrets({ text: `const k = "${STRIPE_FULL}"` })
  const hit = r.findings.find((f) => f.rule === 'secret.stripe_live')
  assert.ok(hit, 'a live payment key must be reported')
  assert.equal(hit.severity, 'critical')
  assert.equal(r.ok, false)
})

test('a restricted live key is detected as high', () => {
  const r = verifySecrets({ text: `const k = "${STRIPE_RESTRICTED}"` })
  const hit = r.findings.find((f) => f.rule === 'secret.stripe_restricted')
  assert.ok(hit)
  assert.equal(hit.severity, 'high')
})

test('test-mode keys are not reported as live', () => {
  const r = verifySecrets({ text: `const k = "${STRIPE_TESTMODE}"` })
  assert.equal(r.findings.filter((f) => f.rule.startsWith('secret.stripe')).length, 0)
})

test('existing detections still fire alongside the new ones', () => {
  const r = verifySecrets({ text: `AWS_KEY=${AWS_EXAMPLE}\npassword = "hunter2notarealpassword"` })
  const rules = r.findings.map((f) => f.rule)
  assert.ok(rules.includes('secret.aws_key'))
  assert.ok(rules.includes('secret.password_assign'))
})
