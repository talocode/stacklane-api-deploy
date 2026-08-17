/**
 * SpendCaps engine — credit/budget gates for agent tool and API usage.
 * Ported from Stacklane monorepo apps/api/src/services/spendcaps.ts.
 */
export const SPENDCAPS_VERSION = '0.1.0'

export function checkSpendCap(input) {
  const started = Date.now()
  const balance = Number(input.balanceCredits)
  const cost = Number(input.costCredits)
  if (!Number.isFinite(balance) || !Number.isFinite(cost) || cost < 0) {
    return {
      product: 'spendcaps',
      version: SPENDCAPS_VERSION,
      allowed: false,
      reason: 'balanceCredits and costCredits must be non-negative numbers',
      balanceCredits: balance,
      costCredits: cost,
      durationMs: Date.now() - started,
    }
  }

  if (balance < cost) {
    return {
      product: 'spendcaps',
      version: SPENDCAPS_VERSION,
      allowed: false,
      reason: `insufficient_balance: need ${cost}, have ${balance}`,
      balanceCredits: balance,
      costCredits: cost,
      remainingAfter: balance,
      durationMs: Date.now() - started,
    }
  }

  let window
  if (input.windowLimit != null) {
    const spent = Number(input.spentInWindow || 0)
    const limit = Number(input.windowLimit)
    if (spent + cost > limit) {
      return {
        product: 'spendcaps',
        version: SPENDCAPS_VERSION,
        allowed: false,
        reason: `window_limit: ${spent}+${cost} > ${limit}`,
        balanceCredits: balance,
        costCredits: cost,
        window: { spent, limit, remaining: Math.max(0, limit - spent) },
        durationMs: Date.now() - started,
      }
    }
    window = { spent, limit, remaining: limit - spent - cost }
  }

  let monthly
  if (input.monthlyLimit != null) {
    const spent = Number(input.monthlySpent || 0)
    const limit = Number(input.monthlyLimit)
    if (spent + cost > limit) {
      return {
        product: 'spendcaps',
        version: SPENDCAPS_VERSION,
        allowed: false,
        reason: `monthly_limit: ${spent}+${cost} > ${limit}`,
        balanceCredits: balance,
        costCredits: cost,
        window,
        monthly: { spent, limit, remaining: Math.max(0, limit - spent) },
        durationMs: Date.now() - started,
      }
    }
    monthly = { spent, limit, remaining: limit - spent - cost }
  }

  const warnRatio = input.warnAtRatio ?? 0.8
  let warn = false
  if (window && input.windowLimit) {
    const used = (input.spentInWindow || 0) + cost
    warn = used / input.windowLimit >= warnRatio
  }

  return {
    product: 'spendcaps',
    version: SPENDCAPS_VERSION,
    allowed: true,
    reason: warn ? 'allowed_with_warning' : 'allowed',
    balanceCredits: balance,
    costCredits: cost,
    remainingAfter: balance - cost,
    warn,
    window,
    monthly,
    durationMs: Date.now() - started,
  }
}

export function getSpendCapsPricing() {
  return {
    product: 'spendcaps',
    version: SPENDCAPS_VERSION,
    credits: {
      'spendcaps.check': 1,
    },
    note: 'Budget gates before agent or API spend. Deterministic.',
  }
}

export function getSpendCapsCapabilities() {
  return {
    product: 'spendcaps',
    version: SPENDCAPS_VERSION,
    endpoints: [
      'GET /v1/spendcaps/health',
      'GET /v1/spendcaps/pricing',
      'GET /v1/spendcaps/capabilities',
      'POST /v1/spendcaps/check',
    ],
    features: [
      'Balance sufficiency check',
      'Window (daily) spend limits',
      'Monthly hard caps',
      'Warn-at-ratio soft threshold',
    ],
    limitations: [
      'Deterministic gate — billing ledger lives in Stacklane Cloud',
    ],
  }
}
