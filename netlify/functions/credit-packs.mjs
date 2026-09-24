// The single source of truth for credit packs, shared by both payment rails:
// fiat checkout and $TCODE.
//
// Pack values are fixed in code. Deployment configuration supplies only the
// matching provider variant ids. Mirrors the catalog in
// Stacklane/apps/api/src/services/payments/credit-packs.ts, so a pack cannot
// cost different credits depending on which rail the customer picks.

export const CREDITS_PER_USD = 100 // 1 credit = $0.01 list

const PACKS = [
  ['starter', 500],
  ['builder', 1000],
  ['growth', 2500],
  ['scale', 5000],
  ['pro', 10000],
  ['studio', 25000],
]

export function listCreditPacks() {
  return PACKS.map(([id, credits]) => ({
    id,
    credits,
    amountCents: credits,
    amountUsd: credits / CREDITS_PER_USD,
  }))
}

// Returns null for an unknown pack. Callers raise their own error type.
export function getCreditPack(packId) {
  const match = PACKS.find(([id]) => id === String(packId || ''))
  if (!match) return null
  const [id, credits] = match
  return { id, credits, amountCents: credits, amountUsd: credits / CREDITS_PER_USD }
}

export function isCreditPack(packId) {
  return getCreditPack(packId) !== null
}

// Provider variant ids are keyed by credit count, matching the configuration
// contract used elsewhere.
export function lemonSqueezyVariantMap() {
  try {
    const parsed = JSON.parse(process.env.LEMONSQUEEZY_VARIANT_MAP || '{}')
    const variants = {}
    for (const [credits, value] of Object.entries(parsed || {})) {
      if (typeof value === 'string' && value.length > 0) variants[String(credits)] = value
    }
    return variants
  } catch {
    return null
  }
}

export function lemonSqueezyVariantFor(packId) {
  const pack = getCreditPack(packId)
  if (!pack) return null
  const map = lemonSqueezyVariantMap()
  if (!map) return null
  return map[String(pack.credits)] || process.env.LEMONSQUEEZY_VARIANT_ID || null
}

// True when fiat checkout is usable at all, so a client can be told the truth
// instead of being shown an option that cannot complete.
export function fiatCheckoutConfigured() {
  return Boolean(
    process.env.LEMONSQUEEZY_API_KEY &&
      process.env.LEMONSQUEEZY_STORE_ID &&
      (process.env.LEMONSQUEEZY_VARIANT_ID || Object.keys(lemonSqueezyVariantMap() || {}).length > 0),
  )
}
