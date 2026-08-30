import { createPublicKey, randomBytes, verify } from 'node:crypto'

export const TCODE_MINT = '6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory'
export const CHALLENGE_TTL_MS = 5 * 60 * 1000
export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'

export const TCODE_TIERS = [
  { key: 'explorer', minTokens: 1, monthlyCredits: 1000 },
  { key: 'builder', minTokens: 100, monthlyCredits: 10000 },
  { key: 'ecosystem', minTokens: 1000, monthlyCredits: 100000 },
  { key: 'partner', minTokens: 5000, monthlyCredits: 500000 },
]

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
    readWallet,
    listTransactions,
    mergeSqlWalletsIntoCache,
  }
}
