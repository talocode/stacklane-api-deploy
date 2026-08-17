/**
 * PolicyLane engine — deterministic action policy checks + secret redaction.
 * Ported from Stacklane monorepo apps/api/src/services/policylane.ts.
 */
export const POLICYLANE_VERSION = '0.1.0'

const DEFAULT_REDACT = [
  String.raw`sk-[A-Za-z0-9]{20,}`,
  String.raw`Bearer\s+[A-Za-z0-9\-._~+/]+=*`,
  String.raw`ghp_[A-Za-z0-9]{36}`,
  String.raw`AKIA[0-9A-Z]{16}`,
]

export function redact(value, patterns) {
  const redactions = []
  const regs = (patterns && patterns.length ? patterns : DEFAULT_REDACT)
    .map((p) => {
      try {
        return new RegExp(p, 'g')
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const walk = (v) => {
    if (typeof v === 'string') {
      let s = v
      for (const re of regs) {
        re.lastIndex = 0
        if (re.test(s)) {
          redactions.push(re.source)
          s = s.replace(re, '[REDACTED]')
        }
      }
      return s
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, val] of Object.entries(v)) out[k] = walk(val)
      return out
    }
    return v
  }
  return { value: walk(value), redactions: [...new Set(redactions)] }
}

function matchAction(ruleAction, action) {
  if (!ruleAction || !action) return false
  if (ruleAction === action) return true
  if (typeof ruleAction === 'string' && ruleAction.endsWith('*')) {
    return action.startsWith(ruleAction.slice(0, -1))
  }
  return false
}

export function checkPolicy(input) {
  const started = Date.now()
  const policy = input.policy || { defaultEffect: 'deny', rules: [] }
  const rules = policy.rules || []
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!matchAction(rule.action, input.action)) continue
    if (rule.when?.roles?.length && input.role && !rule.when.roles.includes(input.role)) continue
    if (rule.when?.tags?.length) {
      const tags = input.tags || []
      if (!rule.when.tags.some((t) => tags.includes(t))) continue
    }
    const { value, redactions } = redact(input.payload, policy.redactPatterns)
    const allowed = rule.effect === 'allow'
    return {
      product: 'policylane',
      version: POLICYLANE_VERSION,
      allowed,
      effect: rule.effect,
      matchedRuleId: rule.id || `rule_${i}`,
      reason: rule.reason || `${rule.effect} matched action ${input.action}`,
      redactedPayload: value,
      redactions,
      durationMs: Date.now() - started,
    }
  }
  const { value, redactions } = redact(input.payload, policy.redactPatterns)
  const allowed = policy.defaultEffect === 'allow'
  return {
    product: 'policylane',
    version: POLICYLANE_VERSION,
    allowed,
    effect: policy.defaultEffect,
    reason: `default_${policy.defaultEffect}`,
    redactedPayload: value,
    redactions,
    durationMs: Date.now() - started,
  }
}

export function getPolicyLanePricing() {
  return {
    product: 'policylane',
    version: POLICYLANE_VERSION,
    credits: {
      'policylane.check': 2,
      'policylane.redact': 1,
    },
    note: 'Agent permission gates and secret redaction. Deterministic policy engine.',
  }
}

export function getPolicyLaneCapabilities() {
  return {
    product: 'policylane',
    version: POLICYLANE_VERSION,
    endpoints: [
      'GET /v1/policylane/health',
      'GET /v1/policylane/pricing',
      'GET /v1/policylane/capabilities',
      'POST /v1/policylane/check',
      'POST /v1/policylane/redact',
    ],
    features: [
      'Rule-based allow/deny policy evaluation',
      'Action wildcard matching (prefix *)',
      'Role and tag conditions',
      'Secret redaction from payloads',
    ],
    limitations: [
      'Deterministic engine — no LLM interpretation of free-form policies',
    ],
  }
}
