import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { CREDITS_PER_USD, getCreditPack, listCreditPacks } from './credit-packs.mjs'

export { CREDITS_PER_USD }

export const TCODE_MINT = '6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory'
export const CHALLENGE_TTL_MS = 5 * 60 * 1000
export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'

export const TCODE_TIERS = [
  { key: 'explorer', minTokens: 1, monthlyCredits: 1000 },
  { key: 'builder', minTokens: 100, monthlyCredits: 10000 },
  { key: 'ecosystem', minTokens: 1000, monthlyCredits: 100000 },
  { key: 'partner', minTokens: 5000, monthlyCredits: 500000 },
]

export const PURCHASE_QUOTE_TTL_MS = 5 * 60 * 1000

// Only these packs are purchasable in $TCODE. Buying a large pack against a
// thin pool would move the price hundreds of percent, so the default is the
// small end. Raise this only when $TCODE depth can absorb the order.
// Pack values themselves come from credit-packs.mjs, shared with the fiat rail.
export const DEFAULT_TCODE_PURCHASE_PACKS = ['starter', 'builder']

export const DEFAULT_PRICE_URL = 'https://api.jup.ag/price/v3'
export const PRICE_CACHE_MS = 60 * 1000
export const PRICE_MAX_AGE_MS = 5 * 60 * 1000

export const TCODE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stacklane.tcode_challenges (
  nonce TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tcode_challenges_project ON stacklane.tcode_challenges (project_id);
CREATE TABLE IF NOT EXISTS stacklane.tcode_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES stacklane.cloud_projects(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL UNIQUE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stacklane.tcode_receipts (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES stacklane.wallets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  period TEXT NOT NULL,
  credits INTEGER NOT NULL,
  raw_balance NUMERIC NOT NULL,
  decimals INTEGER NOT NULL,
  wallet_address TEXT NOT NULL,
  tier_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, type, period)
);
CREATE INDEX IF NOT EXISTS idx_tcode_receipts_wallet ON stacklane.tcode_receipts (wallet_id, created_at DESC);
CREATE TABLE IF NOT EXISTS stacklane.tcode_purchases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES stacklane.cloud_projects(id) ON DELETE RESTRICT,
  wallet_id TEXT NOT NULL REFERENCES stacklane.wallets(id) ON DELETE RESTRICT,
  pack_id TEXT NOT NULL,
  payer_address TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  tcode_raw NUMERIC(40, 0) NOT NULL CHECK (tcode_raw > 0),
  tcode_price_usd NUMERIC(30, 12) NOT NULL CHECK (tcode_price_usd > 0),
  price_source TEXT NOT NULL,
  discount_bps INTEGER NOT NULL DEFAULT 0 CHECK (discount_bps >= 0),
  treasury_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted', 'credited', 'expired', 'failed')),
  tx_signature TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  credited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tcode_purchases_project ON stacklane.tcode_purchases (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tcode_purchases_quoted ON stacklane.tcode_purchases (status) WHERE status = 'quoted';
CREATE UNIQUE INDEX IF NOT EXISTS idx_tcode_purchases_signature ON stacklane.tcode_purchases (tx_signature) WHERE tx_signature IS NOT NULL;
`

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export class TcodeError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function encodeBase58(input) {
  const bytes = Buffer.from(input)
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1
  const digits = [0]
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58[digits[i]]
  return out
}

export function decodeBase58(str) {
  if (!str || typeof str !== 'string') throw new TcodeError(400, 'invalid_address', 'Invalid Solana address')
  const bytes = [0]
  for (let i = 0; i < str.length; i += 1) {
    const val = BASE58.indexOf(str[i])
    if (val < 0) throw new TcodeError(400, 'invalid_address', 'Invalid Solana address')
    let carry = val
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros += 1
  const out = Buffer.alloc(zeros + bytes.length)
  for (let i = 0; i < bytes.length; i += 1) out[out.length - 1 - i] = bytes[i]
  return out
}

export function isSolanaAddress(value) {
  try {
    return decodeBase58(value).length === 32
  } catch {
    return false
  }
}

export function decodeSignature(value) {
  if (!value || typeof value !== 'string') {
    throw new TcodeError(400, 'invalid_signature', 'signature is required')
  }
  const trimmed = value.trim()
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
  try {
    const from58 = decodeBase58(trimmed)
    if (from58.length === 64) return from58
  } catch {
    /* try base64 next */
  }
  try {
    const from64 = Buffer.from(trimmed, 'base64')
    if (from64.length === 64) return from64
  } catch {
    /* fall through */
  }
  throw new TcodeError(400, 'invalid_signature', 'signature must be 64-byte base58, base64, or hex')
}

export function verifyEd25519(publicKey32, messageBytes, signature64) {
  if (!publicKey32 || publicKey32.length !== 32) return false
  if (!signature64 || signature64.length !== 64) return false
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey32)]),
      format: 'der',
      type: 'spki',
    })
    return verify(null, Buffer.from(messageBytes), key, Buffer.from(signature64))
  } catch {
    return false
  }
}

export function periodUtc(date = new Date()) {
  return date.toISOString().slice(0, 7)
}

export function tokensFromRaw(raw, decimals) {
  const rawStr = String(raw || '0')
  if (!/^\d+$/.test(rawStr)) return 0
  const places = Number(decimals)
  if (!Number.isInteger(places) || places < 0 || places > 18) return 0
  if (places === 0) return Number(rawStr)
  const padded = rawStr.padStart(places + 1, '0')
  const whole = padded.slice(0, padded.length - places)
  return Number(whole)
}

// Exact decimal string for a raw amount. Amounts are never round-tripped
// through a float, so a quoted amount is never understated.
export function formatRaw(raw, decimals) {
  const rawStr = String(raw || '0')
  if (!/^\d+$/.test(rawStr)) return '0'
  const places = Number(decimals)
  if (!Number.isInteger(places) || places < 0 || places > 18) return rawStr
  if (places === 0) return rawStr
  const padded = rawStr.padStart(places + 1, '0')
  const whole = padded.slice(0, padded.length - places)
  const fraction = padded.slice(padded.length - places)
  return `${whole}.${fraction}`
}

export function tierFromTokens(tokens) {
  const whole = Math.floor(Number(tokens) || 0)
  const found = [...TCODE_TIERS].reverse().find((tier) => whole >= tier.minTokens)
  return found || null
}

export function challengeMessage({ projectId, nonce, expiresAt }) {
  return [
    'Talocode Cloud',
    `Link Solana wallet to project ${projectId}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`,
  ].join('\n')
}

export function publicConfig() {
  return {
    token: 'TCODE',
    mint: TCODE_MINT,
    chain: 'solana-mainnet',
    period: 'calendar-month-utc',
    tiers: TCODE_TIERS.map((tier) => ({
      key: tier.key,
      minTCODE: tier.minTokens,
      monthlyCredits: tier.monthlyCredits,
    })),
    link: 'Sign a server challenge to prove wallet ownership. One Solana address maps to one Talocode project. Claim once per UTC month.',
  }
}

async function rpcCall(rpcUrl, method, params, fetchImpl = fetch) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) {
    throw new TcodeError(503, 'rpc_unavailable', 'Could not read $TCODE holdings from chain')
  }
  const payload = await response.json()
  if (payload.error) {
    throw new TcodeError(503, 'rpc_unavailable', 'Could not read $TCODE holdings from chain')
  }
  return payload.result
}

const decimalsCache = { value: null, at: 0 }

export async function fetchMintDecimals(rpcUrl, mint = TCODE_MINT, fetchImpl = fetch) {
  if (decimalsCache.value != null && Date.now() - decimalsCache.at < 60 * 60 * 1000) {
    return decimalsCache.value
  }
  const result = await rpcCall(rpcUrl, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }], fetchImpl)
  const decimals = result?.value?.data?.parsed?.info?.decimals
  if (!Number.isInteger(decimals)) {
    throw new TcodeError(503, 'rpc_unavailable', 'Could not read $TCODE mint decimals')
  }
  decimalsCache.value = decimals
  decimalsCache.at = Date.now()
  return decimals
}

export async function fetchTokenRawBalance(rpcUrl, owner, mint = TCODE_MINT, fetchImpl = fetch) {
  const result = await rpcCall(
    rpcUrl,
    'getTokenAccountsByOwner',
    [owner, { mint }, { encoding: 'jsonParsed' }],
    fetchImpl,
  )
  const accounts = result?.value || []
  let total = 0n
  for (const account of accounts) {
    const amount = account?.account?.data?.parsed?.info?.tokenAmount?.amount
    if (amount && /^\d+$/.test(String(amount))) total += BigInt(amount)
  }
  return total.toString()
}

// ---- $TCODE/USD price, server-side only. A client-supplied price is never used.

const priceCache = { price: null, source: null, at: 0 }

function parsePrice(value) {
  if (value == null) return null
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

// Accepts the shapes the price endpoint has used, so a schema change upstream
// fails closed rather than mispricing.
export function readPriceFromPayload(payload, mint = TCODE_MINT) {
  if (!payload || typeof payload !== 'object') return null
  const entry = payload[mint] || payload?.data?.[mint] || null
  if (!entry || typeof entry !== 'object') return null
  return parsePrice(entry.usdPrice) ?? parsePrice(entry.price) ?? null
}

export async function fetchTcodeUsdPrice({ priceUrl, fetchImpl = fetch, now = () => new Date() } = {}) {
  const override = parsePrice(process.env.TCODE_PRICE_USD_OVERRIDE)
  if (override) return { price: override, source: 'override', at: now().toISOString() }

  if (priceCache.price && Date.now() - priceCache.at < PRICE_CACHE_MS) {
    return {
      price: priceCache.price,
      source: priceCache.source,
      at: new Date(priceCache.at).toISOString(),
      cached: true,
    }
  }

  const base = priceUrl || process.env.TCODE_PRICE_URL || DEFAULT_PRICE_URL
  const headers = { accept: 'application/json' }
  if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY
  let payload
  try {
    const res = await fetchImpl(`${base}?ids=${TCODE_MINT}`, { headers })
    if (!res.ok) throw new Error(`price endpoint returned ${res.status}`)
    payload = await res.json()
  } catch {
    throw new TcodeError(503, 'price_unavailable', 'Could not read the $TCODE price; try again shortly')
  }
  const price = readPriceFromPayload(payload)
  if (!price) {
    throw new TcodeError(503, 'price_unavailable', 'Could not read the $TCODE price; try again shortly')
  }
  priceCache.price = price
  priceCache.source = base
  priceCache.at = Date.now()
  return { price, source: base, at: new Date(priceCache.at).toISOString() }
}

// Test-only: clears the cached price so a suite can exercise the fetch path.
export function resetPriceCache() {
  priceCache.price = null
  priceCache.source = null
  priceCache.at = 0
}

// ---- On-chain payment verification

function collectInstructions(tx) {
  const out = []
  const message = tx?.transaction?.message
  if (Array.isArray(message?.instructions)) out.push(...message.instructions)
  const inner = tx?.meta?.innerInstructions
  if (Array.isArray(inner)) {
    for (const group of inner) {
      if (Array.isArray(group?.instructions)) out.push(...group.instructions)
    }
  }
  return out
}

// Sums every TCODE transfer in a transaction that pays the treasury from the
// linked wallet. The destination is the treasury's TCODE token account, which
// pins the mint, so a plain `transfer` cannot smuggle a different asset in.
export function sumTreasuryTransfers(tx, {
  treasuryAddress,
  payerAddress,
  decimals = 6,
  mint = TCODE_MINT,
} = {}) {
  let raw = 0n
  let matched = 0
  for (const ix of collectInstructions(tx)) {
    if (ix?.program !== 'spl-token') continue
    const parsed = ix.parsed
    if (!parsed || typeof parsed !== 'object') continue
    if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') continue
    const info = parsed.info || {}
    if (info.destination !== treasuryAddress) continue
    if (payerAddress && info.authority !== payerAddress) continue
    let amount
    if (parsed.type === 'transferChecked') {
      if (info.mint !== mint) continue
      const tokenDecimals = info.tokenAmount?.decimals
      if (tokenDecimals != null && Number(tokenDecimals) !== decimals) continue
      amount = info.tokenAmount?.amount
    } else {
      amount = info.amount
    }
    if (!/^\d+$/.test(String(amount ?? ''))) continue
    raw += BigInt(amount)
    matched += 1
  }
  return { raw: raw.toString(), matched }
}

export async function verifyTcodePayment({
  signature,
  treasuryAddress,
  payerAddress,
  minRaw,
  decimals = 6,
  rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL,
  fetchImpl = fetch,
}) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(String(signature || ''))) {
    throw new TcodeError(400, 'invalid_signature', 'A Solana transaction signature is required')
  }
  let tx
  try {
    tx = await rpcCall(
      rpcUrl,
      'getTransaction',
      [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      fetchImpl,
    )
  } catch (error) {
    if (error instanceof TcodeError) {
      throw new TcodeError(503, 'rpc_unavailable', 'Could not read the payment from chain')
    }
    throw error
  }
  if (!tx) throw new TcodeError(404, 'transaction_not_found', 'Transaction not found on chain')
  if (tx.meta?.err) throw new TcodeError(400, 'transaction_failed', 'That transaction failed on chain')

  const { raw, matched } = sumTreasuryTransfers(tx, {
    treasuryAddress,
    payerAddress,
    decimals,
  })
  if (matched === 0) {
    throw new TcodeError(400, 'no_matching_transfer', 'No $TCODE payment to the treasury from your linked wallet')
  }
  if (BigInt(raw) < BigInt(minRaw)) {
    throw new TcodeError(400, 'underpaid', 'The payment was less than the quoted amount')
  }
  return { raw, matched }
}

function mapWallet(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    balance: Number(row.balance_credits) || 0,
    lifetimeCredits: Number(row.lifetime_credits) || 0,
    lifetimeSpend: Number(row.lifetime_spend) || 0,
    freeCreditsGranted: !!row.free_credits_granted,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }
}

export function createTcodeStore({
  pool,
  rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL,
  now = () => new Date(),
  makeId = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`,
  fetchImpl = fetch,
} = {}) {
  if (!pool) throw new Error('pool is required')

  async function ensureSchema() {
    const statements = TCODE_SCHEMA_SQL.split(';').map((part) => part.trim()).filter(Boolean)
    for (const sql of statements) await pool.query(sql)
  }

  async function createChallenge({ userId, projectId }) {
    const nonce = randomBytes(32).toString('hex')
    const created = now()
    const expiresAt = new Date(created.getTime() + CHALLENGE_TTL_MS).toISOString()
    const message = challengeMessage({ projectId, nonce, expiresAt })
    await pool.query(
      `INSERT INTO stacklane.tcode_challenges (nonce, project_id, user_id, message, expires_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)`,
      [nonce, projectId, userId, message, expiresAt],
    )
    return { nonce, expiresAt, message }
  }

  async function linkWallet({ userId, projectId, walletAddress, signature, nonce }) {
    if (!isSolanaAddress(walletAddress)) {
      throw new TcodeError(400, 'invalid_address', 'walletAddress must be a Solana address')
    }
    if (!nonce) throw new TcodeError(400, 'invalid_request', 'nonce is required')
    const challenge = await pool.query(
      `SELECT nonce, project_id, user_id, message, expires_at, used_at
       FROM stacklane.tcode_challenges WHERE nonce = $1`,
      [nonce],
    )
    const row = challenge.rows[0]
    if (!row) throw new TcodeError(400, 'invalid_nonce', 'Challenge not found')
    if (row.used_at) throw new TcodeError(400, 'invalid_nonce', 'Challenge already used')
    if (row.project_id !== projectId || row.user_id !== userId) {
      throw new TcodeError(400, 'invalid_nonce', 'Challenge does not match this project')
    }
    if (new Date(row.expires_at).getTime() <= now().getTime()) {
      throw new TcodeError(400, 'invalid_nonce', 'Challenge expired')
    }
    const pubkey = decodeBase58(walletAddress)
    const sig = decodeSignature(signature)
    const ok = verifyEd25519(pubkey, Buffer.from(row.message, 'utf8'), sig)
    if (!ok) throw new TcodeError(400, 'invalid_signature', 'Wallet signature did not match address')

    const taken = await pool.query(
      `SELECT id, project_id FROM stacklane.tcode_links WHERE wallet_address = $1`,
      [walletAddress],
    )
    if (taken.rows[0] && taken.rows[0].project_id !== projectId) {
      throw new TcodeError(409, 'wallet_in_use', 'This Solana wallet is already linked to another project')
    }

    const existing = await pool.query(
      `SELECT id FROM stacklane.tcode_links WHERE project_id = $1`,
      [projectId],
    )
    const verifiedAt = now().toISOString()
    if (existing.rows[0]) {
      await pool.query(
        `UPDATE stacklane.tcode_links
         SET wallet_address = $1, last_verified_at = $2::timestamptz
         WHERE project_id = $3`,
        [walletAddress, verifiedAt, projectId],
      )
    } else {
      await pool.query(
        `INSERT INTO stacklane.tcode_links (id, project_id, wallet_address, linked_at, last_verified_at)
         VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)`,
        [makeId('tclk'), projectId, walletAddress, verifiedAt],
      )
    }
    await pool.query(
      `UPDATE stacklane.tcode_challenges SET used_at = $1::timestamptz WHERE nonce = $2`,
      [verifiedAt, nonce],
    )
    return { linked: true, projectId, walletAddress, verifiedAt }
  }

  async function getLink(projectId) {
    const result = await pool.query(
      `SELECT id, project_id, wallet_address, linked_at, last_verified_at
       FROM stacklane.tcode_links WHERE project_id = $1`,
      [projectId],
    )
    return result.rows[0] || null
  }

  async function getHoldings(projectId) {
    const link = await getLink(projectId)
    if (!link) throw new TcodeError(404, 'not_found', 'No linked wallet for this project')
    let decimals
    let rawBalance
    try {
      ;[decimals, rawBalance] = await Promise.all([
        fetchMintDecimals(rpcUrl, TCODE_MINT, fetchImpl),
        fetchTokenRawBalance(rpcUrl, link.wallet_address, TCODE_MINT, fetchImpl),
      ])
    } catch (error) {
      if (error instanceof TcodeError) throw error
      throw new TcodeError(503, 'rpc_unavailable', 'Could not read $TCODE holdings from chain')
    }
    const tcodeTokens = tokensFromRaw(rawBalance, decimals)
    const tier = tierFromTokens(tcodeTokens)
    const period = periodUtc(now())
    const wallet = await pool.query(
      `SELECT id FROM stacklane.wallets WHERE project_id = $1`,
      [projectId],
    )
    let claimedThisPeriod = false
    if (wallet.rows[0]) {
      const receipt = await pool.query(
        `SELECT id FROM stacklane.tcode_receipts
         WHERE wallet_id = $1 AND type = 'tier' AND period = $2`,
        [wallet.rows[0].id, period],
      )
      claimedThisPeriod = receipt.rows.length > 0
    }
    return {
      projectId,
      walletAddress: link.wallet_address,
      rawBalance,
      decimals,
      tcodeTokens,
      tier: tier
        ? { key: tier.key, minTCODE: tier.minTokens, monthlyCredits: tier.monthlyCredits }
        : null,
      period,
      claimedThisPeriod,
      linkedAt: link.linked_at instanceof Date ? link.linked_at.toISOString() : link.linked_at,
    }
  }

  async function claim(projectId) {
    const holdings = await getHoldings(projectId)
    if (holdings.claimedThisPeriod) {
      const wallet = await readWallet(projectId)
      return {
        granted: 0,
        alreadyClaimed: true,
        reason: 'already_claimed',
        period: holdings.period,
        tier: holdings.tier,
        tcodeTokens: holdings.tcodeTokens,
        balance: wallet?.balance ?? null,
        wallet,
      }
    }
    if (!holdings.tier) {
      const wallet = await readWallet(projectId)
      return {
        granted: 0,
        alreadyClaimed: false,
        reason: 'below_tier',
        period: holdings.period,
        tier: null,
        tcodeTokens: holdings.tcodeTokens,
        balance: wallet?.balance ?? null,
        wallet,
      }
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const walletRes = await client.query(
        `SELECT id, project_id, balance_credits, lifetime_credits, lifetime_spend, free_credits_granted, created_at, updated_at
         FROM stacklane.wallets WHERE project_id = $1 FOR UPDATE`,
        [projectId],
      )
      const walletRow = walletRes.rows[0]
      if (!walletRow) throw new TcodeError(404, 'not_found', 'Wallet not found')

      const credits = holdings.tier.monthlyCredits
      const receiptId = makeId('tcr')
      const txnId = makeId('ctxn')
      try {
        await client.query(
          `INSERT INTO stacklane.tcode_receipts
            (id, wallet_id, type, period, credits, raw_balance, decimals, wallet_address, tier_key)
           VALUES ($1, $2, 'tier', $3, $4, $5, $6, $7, $8)`,
          [
            receiptId,
            walletRow.id,
            holdings.period,
            credits,
            holdings.rawBalance,
            holdings.decimals,
            holdings.walletAddress,
            holdings.tier.key,
          ],
        )
      } catch (error) {
        if (error && error.code === '23505') {
          await client.query('ROLLBACK')
          const wallet = mapWallet(walletRow)
          return {
            granted: 0,
            alreadyClaimed: true,
            reason: 'already_claimed',
            period: holdings.period,
            tier: holdings.tier,
            tcodeTokens: holdings.tcodeTokens,
            balance: wallet.balance,
            wallet,
          }
        }
        throw error
      }

      const updated = await client.query(
        `UPDATE stacklane.wallets
         SET balance_credits = balance_credits + $1,
             lifetime_credits = lifetime_credits + $1,
             updated_at = now()
         WHERE id = $2
         RETURNING id, project_id, balance_credits, lifetime_credits, lifetime_spend, free_credits_granted, created_at, updated_at`,
        [credits, walletRow.id],
      )
      const next = updated.rows[0]
      await client.query(
        `INSERT INTO stacklane.transactions
          (id, wallet_id, type, credits_delta, balance_after, reference, metadata, created_at)
         VALUES ($1, $2, 'tcode_tier', $3, $4, $5, $6::jsonb, now())`,
        [
          txnId,
          walletRow.id,
          credits,
          next.balance_credits,
          `${holdings.period}:${holdings.tier.key}`,
          JSON.stringify({
            walletAddress: holdings.walletAddress,
            rawBalance: holdings.rawBalance,
            decimals: holdings.decimals,
            tier: holdings.tier.key,
            period: holdings.period,
          }),
        ],
      )
      await client.query('COMMIT')
      const wallet = mapWallet(next)
      return {
        granted: credits,
        alreadyClaimed: false,
        reason: 'granted',
        period: holdings.period,
        tier: holdings.tier,
        tcodeTokens: holdings.tcodeTokens,
        balance: wallet.balance,
        wallet,
      }
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw error
    } finally {
      client.release()
    }
  }

  async function purchaseSettings() {
    const treasuryAddress = String(process.env.TCODE_TREASURY_TOKEN_ACCOUNT || '').trim()
    if (!isSolanaAddress(treasuryAddress)) {
      throw new TcodeError(503, 'treasury_not_configured', '$TCODE purchases are not configured')
    }
    const allowed = String(process.env.TCODE_PURCHASE_PACKS || DEFAULT_TCODE_PURCHASE_PACKS.join(','))
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    const discountBps = Math.max(0, Math.min(5000, Number(process.env.TCODE_PURCHASE_DISCOUNT_BPS || 0) || 0))
    const dailyCreditCap = Math.max(0, Number(process.env.TCODE_PURCHASE_DAILY_CREDIT_CAP || 0) || 0)
    return { treasuryAddress, allowed, discountBps, dailyCreditCap }
  }

  // Prices a purchase in $TCODE. Credits come only from the server-owned pack,
  // never from the caller, and the quote is short-lived so a stale price cannot
  // be filled later.
  async function createPurchaseQuote({ projectId, packId }) {
    const settings = await purchaseSettings()
    const key = String(packId || '')
    const pack = getCreditPack(key)
    if (!pack) throw new TcodeError(400, 'invalid_pack', 'Unknown credit pack')
    if (!settings.allowed.includes(key)) {
      throw new TcodeError(422, 'pack_not_available', 'That pack is not available for $TCODE payment')
    }
    const link = await getLink(projectId)
    if (!link) {
      throw new TcodeError(409, 'wallet_not_linked', 'Link a Solana wallet before paying with $TCODE')
    }
    const walletRes = await pool.query(
      `SELECT id FROM stacklane.wallets WHERE project_id = $1`,
      [projectId],
    )
    const walletRow = walletRes.rows[0]
    if (!walletRow) throw new TcodeError(404, 'not_found', 'Wallet not found')

    if (settings.dailyCreditCap > 0) {
      const dayStart = new Date(now())
      dayStart.setUTCHours(0, 0, 0, 0)
      const spent = await pool.query(
        `SELECT COALESCE(SUM(credits), 0) AS credits FROM stacklane.tcode_purchases
         WHERE project_id = $1 AND status = 'credited' AND credited_at >= $2::timestamptz`,
        [projectId, dayStart.toISOString()],
      )
      const used = Number(spent.rows[0]?.credits || 0)
      if (used + pack.credits > settings.dailyCreditCap) {
        throw new TcodeError(429, 'daily_cap_reached', 'Daily $TCODE purchase limit reached')
      }
    }

    const decimals = await fetchMintDecimals(rpcUrl, TCODE_MINT, fetchImpl)
    const { price, source } = await fetchTcodeUsdPrice({ fetchImpl, now })
    const usdValue = pack.credits / CREDITS_PER_USD
    const effectiveUsd = usdValue * (1 - settings.discountBps / 10000)
    const scale = 10 ** decimals
    // Round up, so we never collect less than the quoted value.
    const raw = BigInt(Math.ceil((effectiveUsd / price) * scale))
    if (raw <= 0n) throw new TcodeError(503, 'price_unavailable', 'Could not price this purchase')

    const createdAt = now()
    const expiresAt = new Date(createdAt.getTime() + PURCHASE_QUOTE_TTL_MS).toISOString()
    const id = makeId('tcq')
    await pool.query(
      `INSERT INTO stacklane.tcode_purchases
        (id, project_id, wallet_id, pack_id, payer_address, credits, tcode_raw, tcode_price_usd,
         price_source, discount_bps, treasury_address, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'quoted', $12::timestamptz)`,
      [
        id,
        projectId,
        walletRow.id,
        key,
        link.wallet_address,
        pack.credits,
        raw.toString(),
        price,
        source,
        settings.discountBps,
        settings.treasuryAddress,
        expiresAt,
      ],
    )
    return {
      quoteId: id,
      packId: key,
      credits: pack.credits,
      amountUsd: Number(effectiveUsd.toFixed(2)),
      discountBps: settings.discountBps,
      tcodeRaw: raw.toString(),
      tcodeTokens: formatRaw(raw, decimals),
      tcodePriceUsd: price,
      priceSource: source,
      mint: TCODE_MINT,
      treasuryAddress: settings.treasuryAddress,
      expiresAt,
    }
  }

  // Verifies the transfer and credits exactly once. The signature is written
  // before the wallet moves, so a replay collides with the unique index and the
  // whole thing rolls back with no credit granted.
  async function creditPurchase({ projectId, quoteId, signature }) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const quoteRes = await client.query(
        `SELECT id, project_id, wallet_id, credits, tcode_raw, payer_address, treasury_address, status, expires_at
         FROM stacklane.tcode_purchases WHERE id = $1 FOR UPDATE`,
        [quoteId],
      )
      const quote = quoteRes.rows[0]
      if (!quote) {
        await client.query('ROLLBACK')
        throw new TcodeError(404, 'not_found', 'Quote not found')
      }
      if (quote.project_id !== projectId) {
        await client.query('ROLLBACK')
        throw new TcodeError(403, 'forbidden', 'Access denied')
      }
      if (quote.status === 'credited') {
        await client.query('ROLLBACK')
        const wallet = await readWallet(projectId)
        return {
          credited: false,
          alreadyCredited: true,
          quoteId,
          credits: 0,
          balance: wallet ? wallet.balance : null,
          wallet,
        }
      }
      if (quote.status !== 'quoted') {
        await client.query('ROLLBACK')
        throw new TcodeError(409, 'quote_not_open', 'That quote can no longer be used')
      }
      if (new Date(quote.expires_at).getTime() <= now().getTime()) {
        await client.query('ROLLBACK')
        throw new TcodeError(410, 'quote_expired', 'That quote expired; request a new one')
      }

      const decimals = await fetchMintDecimals(rpcUrl, TCODE_MINT, fetchImpl)
      await verifyTcodePayment({
        signature,
        treasuryAddress: quote.treasury_address,
        payerAddress: quote.payer_address,
        minRaw: String(quote.tcode_raw),
        decimals,
        rpcUrl,
        fetchImpl,
      })

      try {
        await client.query(
          `UPDATE stacklane.tcode_purchases
           SET status = 'credited', tx_signature = $2, credited_at = now(), updated_at = now()
           WHERE id = $1`,
          [quoteId, signature],
        )
      } catch (error) {
        if (error && error.code === '23505') {
          await client.query('ROLLBACK')
          throw new TcodeError(409, 'signature_already_used', 'That transaction has already been credited')
        }
        throw error
      }

      const updated = await client.query(
        `UPDATE stacklane.wallets
         SET balance_credits = balance_credits + $1,
             lifetime_credits = lifetime_credits + $1,
             updated_at = now()
         WHERE id = $2
         RETURNING id, project_id, balance_credits, lifetime_credits, lifetime_spend, free_credits_granted, created_at, updated_at`,
        [quote.credits, quote.wallet_id],
      )
      const next = updated.rows[0]
      await client.query(
        `INSERT INTO stacklane.transactions
          (id, wallet_id, type, credits_delta, balance_after, reference, metadata, created_at)
         VALUES ($1, $2, 'tcode_purchase', $3, $4, $5, $6::jsonb, now())`,
        [
          makeId('ctxn'),
          quote.wallet_id,
          quote.credits,
          next.balance_credits,
          signature,
          JSON.stringify({
            quoteId,
            payerAddress: quote.payer_address,
            tcodeRaw: String(quote.tcode_raw),
            treasuryAddress: quote.treasury_address,
            packId: quote.pack_id,
          }),
        ],
      )
      await client.query('COMMIT')
      const wallet = mapWallet(next)
      return {
        credited: true,
        alreadyCredited: false,
        quoteId,
        credits: quote.credits,
        balance: wallet.balance,
        wallet,
        signature,
      }
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw error
    } finally {
      client.release()
    }
  }

  async function listPurchases(projectId, limit = 25) {
    const result = await pool.query(
      `SELECT id, pack_id, credits, tcode_raw, tcode_price_usd, status, tx_signature, expires_at, credited_at, created_at
       FROM stacklane.tcode_purchases
       WHERE project_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [projectId, limit],
    )
    return result.rows.map((row) => ({
      quoteId: row.id,
      packId: row.pack_id,
      credits: row.credits,
      tcodeRaw: String(row.tcode_raw),
      tcodePriceUsd: Number(row.tcode_price_usd),
      status: row.status,
      signature: row.tx_signature,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
      creditedAt: row.credited_at instanceof Date ? row.credited_at.toISOString() : row.credited_at,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    }))
  }

  // Everything a client needs to offer both rails for every pack, with the
  // $TCODE amount already priced. Pack values come from the shared catalog, so
  // a pack cannot cost different credits on a different rail.
  async function listPaymentOptions() {
    const packs = listCreditPacks()
    let settings = null
    try {
      settings = await purchaseSettings()
    } catch {
      settings = null
    }
    let priced = null
    let decimals = 6
    if (settings) {
      try {
        priced = await fetchTcodeUsdPrice({ fetchImpl, now })
        decimals = await fetchMintDecimals(rpcUrl, TCODE_MINT, fetchImpl)
      } catch {
        priced = null
      }
    }
    const scale = 10 ** decimals
    return {
      creditsPerUsd: CREDITS_PER_USD,
      treasuryAddress: settings ? settings.treasuryAddress : null,
      tcode: settings
        ? {
            available: true,
            discountBps: settings.discountBps,
            dailyCreditCap: settings.dailyCreditCap,
            enabledPacks: settings.allowed,
            priceUsd: priced ? priced.price : null,
            priceSource: priced ? priced.source : null,
            priceAsOf: priced ? priced.at : null,
            mint: TCODE_MINT,
          }
        : { available: false, reason: 'treasury_not_configured' },
      packs: packs.map((pack) => {
        const enabled = Boolean(settings && settings.allowed.includes(pack.id))
        let tcode = null
        if (enabled && priced) {
          const effectiveUsd = pack.amountUsd * (1 - settings.discountBps / 10000)
          const raw = BigInt(Math.ceil((effectiveUsd / priced.price) * scale))
          tcode = {
            available: true,
            raw: raw.toString(),
            tokens: formatRaw(raw, decimals),
            discountBps: settings.discountBps,
          }
        } else if (!enabled) {
          tcode = { available: false, reason: 'pack_not_enabled' }
        } else {
          tcode = { available: false, reason: 'price_unavailable' }
        }
        return {
          id: pack.id,
          credits: pack.credits,
          amountUsd: pack.amountUsd,
          tcode,
        }
      }),
    }
  }

  async function readWallet(projectId) {
    const result = await pool.query(
      `SELECT id, project_id, balance_credits, lifetime_credits, lifetime_spend, free_credits_granted, created_at, updated_at
       FROM stacklane.wallets WHERE project_id = $1`,
      [projectId],
    )
    return result.rows[0] ? mapWallet(result.rows[0]) : null
  }

  async function listTransactions(projectId, limit = 50) {
    const result = await pool.query(
      `SELECT t.id, t.wallet_id, t.type, t.credits_delta, t.balance_after, t.reference, t.metadata, t.created_at
       FROM stacklane.transactions t
       JOIN stacklane.wallets w ON w.id = t.wallet_id
       WHERE w.project_id = $1
       ORDER BY t.created_at DESC
       LIMIT $2`,
      [projectId, limit],
    )
    return result.rows.map((row) => ({
      id: row.id,
      walletId: row.wallet_id,
      type: row.type,
      creditsDelta: row.credits_delta,
      balanceAfter: row.balance_after,
      product: null,
      action: row.type === 'tcode_tier' ? 'tier' : null,
      reference: row.reference,
      metadata: row.metadata,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    }))
  }

  async function mergeSqlWalletsIntoCache(db) {
    const result = await pool.query(
      `SELECT id, project_id, balance_credits, lifetime_credits, lifetime_spend, free_credits_granted, created_at, updated_at
       FROM stacklane.wallets`,
    )
    if (!db.wallets) db.wallets = {}
    for (const row of result.rows) {
      const mapped = mapWallet(row)
      const existing = db.wallets[row.project_id]
      if (!existing) {
        db.wallets[row.project_id] = mapped
        continue
      }
      const sqlTime = new Date(mapped.updatedAt || 0).getTime()
      const cacheTime = new Date(existing.updatedAt || 0).getTime()
      if (sqlTime >= cacheTime) db.wallets[row.project_id] = { ...existing, ...mapped }
    }
  }

  return {
    ensureSchema,
    createChallenge,
    linkWallet,
    getLink,
    getHoldings,
    claim,
    createPurchaseQuote,
    creditPurchase,
    listPurchases,
    listPaymentOptions,
    readWallet,
    listTransactions,
    mergeSqlWalletsIntoCache,
  }
}
