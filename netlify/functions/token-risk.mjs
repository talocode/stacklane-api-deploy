/**
 * Risk rules over a normalised Solana token record.
 *
 * Pure and offline on purpose: no network, no clock beyond what is passed in, so
 * every threshold below is testable directly. The thresholds are judgement calls
 * and are stated here rather than buried in the client, because they are the part
 * a reviewer should argue with.
 *
 * Two things these rules must never do:
 *
 *  - Treat missing data as a pass. A record that omits an authority flag cannot
 *    be read as "authority revoked", so an absent flag is reported as unknown.
 *  - Report a severity of info for anything that can take money from a holder.
 */

function finding(rule, severity, message, detail) {
  return { id: `${rule}:${detail ?? ''}`, rule, severity, message, ...(detail ? { detail } : {}) }
}

/**
 * Compare a token against what the caller believed it was. This is the part that
 * makes the check worth paying for: identity is only useful if it can disagree
 * with the claim.
 */
export function claimFindings(token, claim = {}) {
  const out = []
  if (!token) return out
  const wantSymbol = claim.expectedSymbol ? String(claim.expectedSymbol).trim().toUpperCase() : null
  const wantName = claim.expectedName ? String(claim.expectedName).trim().toLowerCase() : null
  if (wantSymbol && token.symbol && token.symbol.toUpperCase() !== wantSymbol) {
    out.push(
      finding(
        'token.symbol_mismatch',
        'high',
        `This contract reports the symbol ${token.symbol}, not ${wantSymbol}. It is not the token that was claimed.`,
        `${token.symbol} != ${wantSymbol}`,
      ),
    )
  }
  if (wantName && token.name && token.name.toLowerCase() !== wantName) {
    out.push(
      finding(
        'token.name_mismatch',
        'medium',
        `This contract reports the name "${token.name}", not "${claim.expectedName}".`,
        `${token.name} != ${claim.expectedName}`,
      ),
    )
  }
  return out
}

/** Risk signals from the token's own audit fields and market state. */
export function riskFindings(token) {
  const out = []
  if (!token) return out
  const a = token.audit || {}

  if (a.mintAuthorityDisabled === false) {
    out.push(finding('token.mint_authority_live', 'critical',
      'Mint authority is still active, so the supply can be increased at any time.'))
  } else if (a.mintAuthorityDisabled == null) {
    out.push(finding('token.mint_authority_unknown', 'medium',
      'Mint authority could not be determined from the record. Absence of the flag is not evidence the supply is fixed.'))
  }

  if (a.freezeAuthorityDisabled === false) {
    out.push(finding('token.freeze_authority_live', 'high',
      'Freeze authority is still active, so holder accounts can be frozen.'))
  } else if (a.freezeAuthorityDisabled == null) {
    out.push(finding('token.freeze_authority_unknown', 'medium',
      'Freeze authority could not be determined from the record.'))
  }

  const top = a.topHoldersPercentage
  if (typeof top === 'number') {
    if (top >= 50) {
      out.push(finding('token.holder_concentration', 'high',
        `The largest holders control about ${top}% of supply.`, String(top)))
    } else if (top >= 20) {
      out.push(finding('token.holder_concentration', 'medium',
        `The largest holders control about ${top}% of supply.`, String(top)))
    }
  }

  if (typeof token.holderCount === 'number') {
    if (token.holderCount < 25) {
      out.push(finding('token.few_holders', 'high',
        `Only ${token.holderCount} holders. With this few, a single wallet can move the price.`, String(token.holderCount)))
    } else if (token.holderCount < 150) {
      out.push(finding('token.few_holders', 'medium',
        `${token.holderCount} holders is still a narrow base.`, String(token.holderCount)))
    }
  }

  if (typeof token.liquidityUsd === 'number') {
    if (token.liquidityUsd < 1000) {
      out.push(finding('token.thin_liquidity', 'high',
        `Pool liquidity is about $${Math.round(token.liquidityUsd)}. A trade of a few hundred dollars moves the price, and exiting may not be possible at the quoted price.`,
        String(Math.round(token.liquidityUsd))))
    } else if (token.liquidityUsd < 25000) {
      out.push(finding('token.thin_liquidity', 'medium',
        `Pool liquidity is about $${Math.round(token.liquidityUsd)}.`, String(Math.round(token.liquidityUsd))))
    }
  }

  if (token.organicScoreLabel === 'low' || (typeof token.organicScore === 'number' && token.organicScore <= 20)) {
    out.push(finding('token.low_organic_activity', 'medium',
      'Activity looks largely inorganic, which usually means volume driven by a small set of wallets rather than demand.'))
  }

  if (Array.isArray(token.tags) && token.tags.includes('unknown')) {
    out.push(finding('token.unclassified', 'info',
      'The token is not classified by the source, which normally means it is new or thinly traded.'))
  }

  if (token.createdAt) {
    const ageDays = (Date.now() - new Date(token.createdAt).getTime()) / 86400000
    if (Number.isFinite(ageDays)) {
      if (ageDays < 1) out.push(finding('token.very_new', 'medium', 'The token was created within the last day.'))
      else if (ageDays < 7) out.push(finding('token.new', 'low', `The token is about ${Math.floor(ageDays)} days old.`))
    }
  }

  return out
}

/** Everything above, in one call. */
export function tokenFindings(token, claim) {
  return [...claimFindings(token, claim), ...riskFindings(token)]
}
