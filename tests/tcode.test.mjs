import { generateKeyPairSync, sign } from 'node:crypto'
import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import {
  encodeBase58,
  decodeBase58,
  isSolanaAddress,
  verifyEd25519,
  decodeSignature,
  tokensFromRaw,
  formatRaw,
  tierFromTokens,
  periodUtc,
  challengeMessage,
  createTcodeStore,
  readPriceFromPayload,
  fetchTcodeUsdPrice,
  resetPriceCache,
  sumTreasuryTransfers,
  TcodeError,
  TCODE_MINT,
  CREDITS_PER_USD,
} from '../netlify/functions/tcode.mjs'
import {
  getCreditPack,
  listCreditPacks,
  lemonSqueezyVariantFor,
  lemonSqueezyVariantMap,
  fiatCheckoutConfigured,
} from '../netlify/functions/credit-packs.mjs'

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const raw = der.subarray(der.length - 32)
  return { publicKey: raw, privateKey, address: encodeBase58(raw) }
}

function makeFetch({
  decimals = 6,
  amount = '1489000000',
  price = 0.01,
  priceShape = 'v3',
  priceOk = true,
  tx = null,
} = {}) {
  return async (_url, init = {}) => {
    const body = init && init.body ? JSON.parse(init.body) : null
    if (!body) {
      if (!priceOk) return { ok: false, status: 502, json: async () => ({}) }
      const payload =
        priceShape === 'v3'
          ? { [TCODE_MINT]: { usdPrice: price } }
          : { data: { [TCODE_MINT]: { price: String(price) } } }
      return { ok: true, json: async () => payload }
    }
    if (body.method === 'getAccountInfo') {
      return {
        ok: true,
        json: async () => ({ result: { value: { data: { parsed: { info: { decimals } } } } } }),
      }
    }
    if (body.method === 'getTokenAccountsByOwner') {
      return {
        ok: true,
        json: async () => ({
          result: {
            value: [
              { account: { data: { parsed: { info: { tokenAmount: { amount } } } } } },
            ],
          },
        }),
      }
    }
    if (body.method === 'getTransaction') {
      return { ok: true, json: async () => ({ result: tx }) }
    }
    return { ok: false, status: 500, json: async () => ({ error: 'unknown' }) }
  }
}

// A parsed transaction carrying one $TCODE transfer to the treasury.
function paymentTx({
  destination,
  authority,
  amount,
  mint = TCODE_MINT,
  decimals = 6,
  checked = true,
  err = null,
  extra = [],
} = {}) {
  const instruction = checked
    ? {
        program: 'spl-token',
        parsed: {
          type: 'transferChecked',
          info: { destination, authority, mint, tokenAmount: { amount: String(amount), decimals } },
        },
      }
    : {
        program: 'spl-token',
        parsed: { type: 'transfer', info: { destination, authority, amount: String(amount) } },
      }
  return {
    meta: { err, innerInstructions: [] },
    transaction: { message: { instructions: [instruction, ...extra] } },
  }
}

function memoryPool() {
  const challenges = new Map()
  const links = []
  const receipts = []
  const purchases = []
  const wallets = [
    {
      id: 'wal_1',
      project_id: 'proj_1',
      balance_credits: 100,
      lifetime_credits: 100,
      lifetime_spend: 0,
      free_credits_granted: true,
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      updated_at: new Date('2026-08-01T00:00:00.000Z'),
    },
  ]
  const transactions = []

  function result(rows) {
    return { rows, rowCount: rows.length }
  }

  async function query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim()
    if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX')) return result([])
    if (text.startsWith('INSERT INTO stacklane.tcode_challenges')) {
      challenges.set(params[0], {
        nonce: params[0],
        project_id: params[1],
        user_id: params[2],
        message: params[3],
        expires_at: params[4],
        used_at: null,
      })
      return result([])
    }
    if (text.startsWith('SELECT nonce, project_id, user_id, message')) {
      const row = challenges.get(params[0])
      return result(row ? [row] : [])
    }
    if (text.startsWith('UPDATE stacklane.tcode_challenges SET used_at')) {
      const row = challenges.get(params[1])
      if (row) row.used_at = params[0]
      return result([])
    }
    if (text.startsWith('SELECT id, project_id FROM stacklane.tcode_links WHERE wallet_address')) {
      return result(links.filter((row) => row.wallet_address === params[0]).map((row) => ({ id: row.id, project_id: row.project_id })))
    }
    if (text.startsWith('SELECT id FROM stacklane.tcode_links WHERE project_id')) {
      return result(links.filter((row) => row.project_id === params[0]).map((row) => ({ id: row.id })))
    }
    if (text.startsWith('UPDATE stacklane.tcode_links')) {
      const row = links.find((item) => item.project_id === params[2])
      if (row) {
        row.wallet_address = params[0]
        row.last_verified_at = params[1]
      }
      return result([])
    }
    if (text.startsWith('INSERT INTO stacklane.tcode_links')) {
      if (links.some((row) => row.wallet_address === params[2] && row.project_id !== params[1])) {
        const error = new Error('duplicate')
        error.code = '23505'
        throw error
      }
      links.push({
        id: params[0],
        project_id: params[1],
        wallet_address: params[2],
        linked_at: params[3],
        last_verified_at: params[3],
      })
      return result([])
    }
    if (text.startsWith('SELECT id, project_id, wallet_address')) {
      return result(links.filter((row) => row.project_id === params[0]))
    }
    if (text.startsWith('SELECT id FROM stacklane.wallets')) {
      return result(wallets.filter((row) => row.project_id === params[0]).map((row) => ({ id: row.id })))
    }
    if (text.includes('FROM stacklane.wallets WHERE project_id')) {
      return result(wallets.filter((row) => row.project_id === params[0]))
    }
    if (text.startsWith('SELECT id FROM stacklane.tcode_receipts')) {
      return result(
        receipts
          .filter((row) => row.wallet_id === params[0] && row.type === 'tier' && row.period === params[1])
          .map((row) => ({ id: row.id })),
      )
    }
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return result([])
    if (text.startsWith('INSERT INTO stacklane.tcode_receipts')) {
      const dup = receipts.some((row) => row.wallet_id === params[1] && row.type === 'tier' && row.period === params[2])
      if (dup) {
        const error = new Error('duplicate')
        error.code = '23505'
        throw error
      }
      receipts.push({
        id: params[0],
        wallet_id: params[1],
        type: 'tier',
        period: params[2],
        credits: params[3],
        raw_balance: params[4],
        decimals: params[5],
        wallet_address: params[6],
        tier_key: params[7],
      })
      return result([])
    }
    if (text.startsWith('UPDATE stacklane.wallets')) {
      const wallet = wallets.find((row) => row.id === params[1])
      wallet.balance_credits += params[0]
      wallet.lifetime_credits += params[0]
      wallet.updated_at = new Date()
      return result([wallet])
    }
    if (text.startsWith('INSERT INTO stacklane.transactions')) {
      transactions.push({
        id: params[0],
        wallet_id: params[1],
        type: text.includes("'tcode_purchase'") ? 'tcode_purchase' : 'tcode_tier',
        credits_delta: params[2],
        balance_after: params[3],
        reference: params[4],
        metadata: params[5],
      })
      return result([])
    }
    if (text.startsWith('INSERT INTO stacklane.tcode_purchases')) {
      purchases.push({
        id: params[0],
        project_id: params[1],
        wallet_id: params[2],
        pack_id: params[3],
        payer_address: params[4],
        credits: params[5],
        tcode_raw: params[6],
        tcode_price_usd: params[7],
        price_source: params[8],
        discount_bps: params[9],
        treasury_address: params[10],
        status: 'quoted',
        tx_signature: null,
        expires_at: params[11],
        credited_at: null,
        created_at: new Date(),
      })
      return result([])
    }
    if (text.startsWith('SELECT COALESCE(SUM(credits), 0) AS credits FROM stacklane.tcode_purchases')) {
      const total = purchases
        .filter((row) => row.project_id === params[0] && row.status === 'credited')
        .reduce((sum, row) => sum + row.credits, 0)
      return result([{ credits: total }])
    }
    if (text.startsWith('SELECT id, project_id, wallet_id')) {
      return result(purchases.filter((row) => row.id === params[0]))
    }
    if (text.startsWith('UPDATE stacklane.tcode_purchases')) {
      const row = purchases.find((item) => item.id === params[0])
      if (!row) return result([])
      if (purchases.some((item) => item !== row && item.tx_signature === params[1])) {
        const error = new Error('duplicate')
        error.code = '23505'
        throw error
      }
      row.status = 'credited'
      row.tx_signature = params[1]
      row.credited_at = new Date()
      return result([row])
    }
    if (text.startsWith('SELECT id, pack_id, credits')) {
      return result(
        purchases
          .filter((row) => row.project_id === params[0])
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, params[1]),
      )
    }
    throw new Error(`unexpected sql: ${text}`)
  }

  return {
    query,
    connect: async () => ({ query, release() {} }),
    _wallets: wallets,
    _receipts: receipts,
    _purchases: purchases,
    _transactions: transactions,
  }
}

describe('tcode math and signatures', () => {
  it('round-trips base58 public keys', () => {
    const { address, publicKey } = keypair()
    assert.equal(encodeBase58(decodeBase58(address)), address)
    assert.equal(decodeBase58(address).equals(publicKey), true)
    assert.equal(isSolanaAddress(address), true)
    assert.equal(isSolanaAddress('nope'), false)
  })

  it('verifies an ed25519 wallet signature and rejects a bad one', () => {
    const keys = keypair()
    const message = Buffer.from(challengeMessage({
      projectId: 'proj_1',
      nonce: 'abc',
      expiresAt: '2026-08-30T00:00:00.000Z',
    }), 'utf8')
    const signature = sign(null, message, keys.privateKey)
    assert.equal(verifyEd25519(keys.publicKey, message, signature), true)
    assert.equal(verifyEd25519(keys.publicKey, Buffer.from('other'), signature), false)
    const encoded = encodeBase58(signature)
    assert.equal(decodeSignature(encoded).equals(signature), true)
  })

  it('floors whole tokens from raw amounts using mint decimals', () => {
    assert.equal(tokensFromRaw('1489000000', 6), 1489)
    assert.equal(tokensFromRaw('999999', 6), 0)
    assert.equal(tokensFromRaw('1000000', 6), 1)
    assert.equal(tokensFromRaw('99', 0), 99)
  })

  it('maps whole-token holdings to the posted tiers', () => {
    assert.equal(tierFromTokens(0), null)
    assert.equal(tierFromTokens(0.9), null)
    assert.equal(tierFromTokens(1).key, 'explorer')
    assert.equal(tierFromTokens(99).monthlyCredits, 1000)
    assert.equal(tierFromTokens(100).key, 'builder')
    assert.equal(tierFromTokens(1489).monthlyCredits, 100000)
    assert.equal(tierFromTokens(1000).key, 'ecosystem')
    assert.equal(tierFromTokens(5000).key, 'partner')
  })

  it('uses UTC calendar months', () => {
    assert.equal(periodUtc(new Date('2026-08-31T23:59:59.000Z')), '2026-08')
    assert.equal(periodUtc(new Date('2026-09-01T00:00:00.000Z')), '2026-09')
  })
})

describe('tcode store', () => {
  it('rejects a pasted address without a valid signature', async () => {
    const keys = keypair()
    const pool = memoryPool()
    const store = createTcodeStore({
      pool,
      now: () => new Date('2026-08-30T12:00:00.000Z'),
      fetchImpl: makeFetch(),
    })
    const challenge = await store.createChallenge({ userId: 'usr_1', projectId: 'proj_1' })
    await assert.rejects(
      () => store.linkWallet({
        userId: 'usr_1',
        projectId: 'proj_1',
        walletAddress: keys.address,
        signature: encodeBase58(Buffer.alloc(64)),
        nonce: challenge.nonce,
      }),
      (error) => error instanceof TcodeError && error.code === 'invalid_signature',
    )
  })

  it('links a signed wallet, reads chain holdings, and grants once per month', async () => {
    const keys = keypair()
    const pool = memoryPool()
    const store = createTcodeStore({
      pool,
      now: () => new Date('2026-08-30T12:00:00.000Z'),
      fetchImpl: makeFetch({ amount: '1489000000', decimals: 6 }),
      makeId: (prefix) => `${prefix}_test`,
    })
    const challenge = await store.createChallenge({ userId: 'usr_1', projectId: 'proj_1' })
    const signature = sign(null, Buffer.from(challenge.message, 'utf8'), keys.privateKey)
    const linked = await store.linkWallet({
      userId: 'usr_1',
      projectId: 'proj_1',
      walletAddress: keys.address,
      signature: encodeBase58(signature),
      nonce: challenge.nonce,
    })
    assert.equal(linked.linked, true)

    const holdings = await store.getHoldings('proj_1')
    assert.equal(holdings.tcodeTokens, 1489)
    assert.equal(holdings.tier.key, 'ecosystem')
    assert.equal(holdings.claimedThisPeriod, false)

    const first = await store.claim('proj_1')
    assert.equal(first.granted, 100000)
    assert.equal(first.balance, 100100)
    assert.equal(pool._wallets[0].balance_credits, 100100)

    const second = await store.claim('proj_1')
    assert.equal(second.granted, 0)
    assert.equal(second.alreadyClaimed, true)
    assert.equal(pool._wallets[0].balance_credits, 100100)
  })

  it('does not grant below 1 whole token', async () => {
    const keys = keypair()
    const pool = memoryPool()
    const store = createTcodeStore({
      pool,
      now: () => new Date('2026-08-30T12:00:00.000Z'),
      fetchImpl: makeFetch({ amount: '900000', decimals: 6 }),
    })
    const challenge = await store.createChallenge({ userId: 'usr_1', projectId: 'proj_1' })
    const signature = sign(null, Buffer.from(challenge.message, 'utf8'), keys.privateKey)
    await store.linkWallet({
      userId: 'usr_1',
      projectId: 'proj_1',
      walletAddress: keys.address,
      signature: encodeBase58(signature),
      nonce: challenge.nonce,
    })
    const result = await store.claim('proj_1')
    assert.equal(result.granted, 0)
    assert.equal(result.reason, 'below_tier')
    assert.equal(pool._wallets[0].balance_credits, 100)
    assert.equal(pool._receipts.length, 0)
  })

  it('refuses the same Solana address on a second project', async () => {
    const keys = keypair()
    const pool = memoryPool()
    const store = createTcodeStore({
      pool,
      now: () => new Date('2026-08-30T12:00:00.000Z'),
      fetchImpl: makeFetch(),
    })
    const first = await store.createChallenge({ userId: 'usr_1', projectId: 'proj_1' })
    const signature = sign(null, Buffer.from(first.message, 'utf8'), keys.privateKey)
    await store.linkWallet({
      userId: 'usr_1',
      projectId: 'proj_1',
      walletAddress: keys.address,
      signature: encodeBase58(signature),
      nonce: first.nonce,
    })
    const second = await store.createChallenge({ userId: 'usr_1', projectId: 'proj_2' })
    const signature2 = sign(null, Buffer.from(second.message, 'utf8'), keys.privateKey)
    await assert.rejects(
      () => store.linkWallet({
        userId: 'usr_1',
        projectId: 'proj_2',
        walletAddress: keys.address,
        signature: encodeBase58(signature2),
        nonce: second.nonce,
      }),
      (error) => error instanceof TcodeError && error.code === 'wallet_in_use',
    )
  })
})

function clockAt(iso) {
  let current = new Date(iso)
  return {
    now: () => current,
    advance(ms) { current = new Date(current.getTime() + ms) },
  }
}

function counterIds() {
  const seen = new Map()
  return (prefix) => {
    const n = (seen.get(prefix) || 0) + 1
    seen.set(prefix, n)
    return `${prefix}_${n}`
  }
}

async function linkedStore({ clock, fetchImpl, tx, price = 0.01, priceOk = true, makeId } = {}) {
  const keys = keypair()
  const pool = memoryPool()
  const c = clock || clockAt('2026-08-30T12:00:00.000Z')
  const store = createTcodeStore({
    pool,
    now: c.now,
    fetchImpl: fetchImpl || makeFetch({ tx: tx ? tx(keys) : null, price, priceOk }),
    makeId: makeId || counterIds(),
  })
  const challenge = await store.createChallenge({ userId: 'usr_1', projectId: 'proj_1' })
  const sig = sign(null, Buffer.from(challenge.message, 'utf8'), keys.privateKey)
  await store.linkWallet({
    userId: 'usr_1',
    projectId: 'proj_1',
    walletAddress: keys.address,
    signature: encodeBase58(sig),
    nonce: challenge.nonce,
  })
  return { store, pool, keys, clock: c }
}

const rejectsWith = (code) => (error) => error instanceof TcodeError && error.code === code

describe('tcode price reader', () => {
  it('reads both payload shapes and refuses anything else', () => {
    assert.equal(readPriceFromPayload({ [TCODE_MINT]: { usdPrice: 0.02 } }), 0.02)
    assert.equal(readPriceFromPayload({ data: { [TCODE_MINT]: { price: '0.03' } } }), 0.03)
    assert.equal(readPriceFromPayload({ data: { [TCODE_MINT]: { usdPrice: 0.04 } } }), 0.04)
    assert.equal(readPriceFromPayload({}), null)
    assert.equal(readPriceFromPayload(null), null)
    assert.equal(readPriceFromPayload({ [TCODE_MINT]: { usdPrice: -1 } }), null)
    assert.equal(readPriceFromPayload({ [TCODE_MINT]: { usdPrice: 'nope' } }), null)
  })

  it('fails closed when the price endpoint breaks', async () => {
    resetPriceCache()
    delete process.env.TCODE_PRICE_USD_OVERRIDE
    await assert.rejects(
      () => fetchTcodeUsdPrice({ fetchImpl: makeFetch({ priceOk: false }) }),
      rejectsWith('price_unavailable'),
    )
  })

  it('formats raw amounts exactly, never through a float', () => {
    assert.equal(formatRaw(500000000n, 6), '500.000000')
    assert.equal(formatRaw('1', 6), '0.000001')
    assert.equal(formatRaw('0', 6), '0.000000')
    assert.equal(formatRaw('12345', 0), '12345')
    assert.equal(formatRaw('bad', 6), '0')
  })

  it('sums only transfers that pay the treasury from the payer', () => {
    const treasury = keypair().address
    const payer = keypair().address
    const other = keypair().address
    const tx = {
      meta: { err: null },
      transaction: {
        message: {
          instructions: [
            { program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: treasury, authority: payer, mint: TCODE_MINT, tokenAmount: { amount: '300', decimals: 6 } } } },
            { program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: treasury, authority: payer, mint: TCODE_MINT, tokenAmount: { amount: '200', decimals: 6 } } } },
            { program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: treasury, authority: other, mint: TCODE_MINT, tokenAmount: { amount: '999', decimals: 6 } } } },
            { program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: other, authority: payer, mint: TCODE_MINT, tokenAmount: { amount: '999', decimals: 6 } } } },
          ],
        },
      },
    }
    const summed = sumTreasuryTransfers(tx, { treasuryAddress: treasury, payerAddress: payer })
    assert.equal(summed.raw, '500')
    assert.equal(summed.matched, 2)
  })
})

describe('tcode credit purchases', () => {
  let treasury
  before(() => {
    treasury = keypair().address
    process.env.TCODE_TREASURY_TOKEN_ACCOUNT = treasury
    delete process.env.TCODE_PRICE_USD_OVERRIDE
    delete process.env.TCODE_PURCHASE_PACKS
    delete process.env.TCODE_PURCHASE_DISCOUNT_BPS
    delete process.env.TCODE_PURCHASE_DAILY_CREDIT_CAP
  })
  after(() => {
    delete process.env.TCODE_TREASURY_TOKEN_ACCOUNT
    delete process.env.TCODE_PURCHASE_PACKS
    delete process.env.TCODE_PURCHASE_DISCOUNT_BPS
    delete process.env.TCODE_PURCHASE_DAILY_CREDIT_CAP
  })

  it('prices a server-owned pack in $TCODE', async () => {
    const { store } = await linkedStore()
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    assert.equal(quote.credits, getCreditPack('starter').credits)
    // $5.00 at $0.01 per token = 500 TCODE = 500000000 raw at 6 decimals
    assert.equal(quote.tcodeRaw, '500000000')
    assert.equal(quote.tcodeTokens, '500.000000')
    assert.equal(quote.tcodePriceUsd, 0.01)
    assert.equal(quote.treasuryAddress, treasury)
    assert.equal(quote.mint, TCODE_MINT)
    assert.equal(quote.amountUsd, getCreditPack('starter').credits / CREDITS_PER_USD)
  })

  it('rejects unknown packs and packs not enabled for $TCODE', async () => {
    const { store } = await linkedStore()
    await assert.rejects(
      () => store.createPurchaseQuote({ projectId: 'proj_1', packId: 'nope' }),
      rejectsWith('invalid_pack'),
    )
    await assert.rejects(
      () => store.createPurchaseQuote({ projectId: 'proj_1', packId: 'studio' }),
      rejectsWith('pack_not_available'),
    )
  })

  it('requires a linked wallet before quoting', async () => {
    const pool = memoryPool()
    const store = createTcodeStore({ pool, fetchImpl: makeFetch() })
    await assert.rejects(
      () => store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' }),
      rejectsWith('wallet_not_linked'),
    )
  })

  it('refuses to quote when no treasury is configured', async () => {
    const saved = process.env.TCODE_TREASURY_TOKEN_ACCOUNT
    delete process.env.TCODE_TREASURY_TOKEN_ACCOUNT
    try {
      const { store } = await linkedStore()
      await assert.rejects(
        () => store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' }),
        rejectsWith('treasury_not_configured'),
      )
    } finally {
      process.env.TCODE_TREASURY_TOKEN_ACCOUNT = saved
    }
  })

  it('credits once for a verified payment', async () => {
    const { store, pool } = await linkedStore({
      tx: (keys) => paymentTx({ destination: treasury, authority: keys.address, amount: '500000000' }),
    })
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    const result = await store.creditPurchase({
      projectId: 'proj_1',
      quoteId: quote.quoteId,
      signature: '5'.repeat(88),
    })
    assert.equal(result.credited, true)
    assert.equal(result.credits, 500)
    assert.equal(result.balance, 600)
    assert.equal(pool._wallets[0].balance_credits, 600)
    assert.equal(pool._transactions.filter((t) => t.type === 'tcode_purchase').length, 1)
    assert.equal(pool._purchases[0].status, 'credited')
    assert.equal(pool._purchases[0].tx_signature, '5'.repeat(88))
  })

  it('credits nothing on a second submit of the same quote', async () => {
    const { store, pool } = await linkedStore({
      tx: (keys) => paymentTx({ destination: treasury, authority: keys.address, amount: '500000000' }),
    })
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    await store.creditPurchase({ projectId: 'proj_1', quoteId: quote.quoteId, signature: '6'.repeat(88) })
    const again = await store.creditPurchase({
      projectId: 'proj_1',
      quoteId: quote.quoteId,
      signature: '6'.repeat(88),
    })
    assert.equal(again.alreadyCredited, true)
    assert.equal(again.credits, 0)
    assert.equal(pool._wallets[0].balance_credits, 600)
  })

  it('refuses to reuse one transaction signature on a second quote', async () => {
    // The payment is large enough for both quotes, so verification passes and
    // the replay guard is what stops the second credit.
    const { store, pool } = await linkedStore({
      tx: (keys) => paymentTx({ destination: treasury, authority: keys.address, amount: '1000000000' }),
    })
    const first = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    const signature = '7'.repeat(88)
    await store.creditPurchase({ projectId: 'proj_1', quoteId: first.quoteId, signature })
    const second = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'builder' })
    await assert.rejects(
      () => store.creditPurchase({ projectId: 'proj_1', quoteId: second.quoteId, signature }),
      rejectsWith('signature_already_used'),
    )
    assert.equal(pool._wallets[0].balance_credits, 600)
  })

  it('rejects an underpayment', async () => {
    const { store } = await linkedStore({
      tx: (keys) => paymentTx({ destination: treasury, authority: keys.address, amount: '499999999' }),
    })
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    await assert.rejects(
      () => store.creditPurchase({ projectId: 'proj_1', quoteId: quote.quoteId, signature: '8'.repeat(88) }),
      rejectsWith('underpaid'),
    )
  })

  it('rejects a payment sent somewhere other than the treasury', async () => {
    const elsewhere = keypair().address
    const { store } = await linkedStore({
      tx: (keys) => paymentTx({ destination: elsewhere, authority: keys.address, amount: '500000000' }),
    })
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    await assert.rejects(
      () => store.creditPurchase({ projectId: 'proj_1', quoteId: quote.quoteId, signature: '9'.repeat(88) }),
      rejectsWith('no_matching_transfer'),
    )
  })

  it('rejects a payment from a wallet that is not the linked one', async () => {
    const stranger = keypair().address
    const { store } = await linkedStore({
      tx: () => paymentTx({ destination: treasury, authority: stranger, amount: '500000000' }),
    })
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    await assert.rejects(
      () => store.creditPurchase({ projectId: 'proj_1', quoteId: quote.quoteId, signature: 'A'.repeat(88) }),
      rejectsWith('no_matching_transfer'),
    )
  })

  it('rejects a quote that has expired', async () => {
    const clock = clockAt('2026-08-30T12:00:00.000Z')
    const { store } = await linkedStore({ clock })
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    clock.advance(6 * 60 * 1000)
    await assert.rejects(
      () => store.creditPurchase({ projectId: 'proj_1', quoteId: quote.quoteId, signature: 'B'.repeat(88) }),
      rejectsWith('quote_expired'),
    )
  })

  it('rejects a transaction that failed on chain', async () => {
    const { store } = await linkedStore({
      tx: (keys) => paymentTx({ destination: treasury, authority: keys.address, amount: '500000000', err: { InstructionError: [0, 'Custom'] } }),
    })
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    await assert.rejects(
      () => store.creditPurchase({ projectId: 'proj_1', quoteId: quote.quoteId, signature: 'C'.repeat(88) }),
      rejectsWith('transaction_failed'),
    )
  })

  it('rejects a transaction that cannot be found', async () => {
    const { store } = await linkedStore({ tx: () => null })
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    await assert.rejects(
      () => store.creditPurchase({ projectId: 'proj_1', quoteId: quote.quoteId, signature: 'D'.repeat(88) }),
      rejectsWith('transaction_not_found'),
    )
  })

  it('accepts a payment split across two transfers', async () => {
    const { store, pool } = await linkedStore({
      tx: (keys) => {
        const half = { program: 'spl-token', parsed: { type: 'transferChecked', info: { destination: treasury, authority: keys.address, mint: TCODE_MINT, tokenAmount: { amount: '250000000', decimals: 6 } } } }
        return paymentTx({ destination: treasury, authority: keys.address, amount: '250000000', extra: [half] })
      },
    })
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    await store.creditPurchase({ projectId: 'proj_1', quoteId: quote.quoteId, signature: 'E'.repeat(88) })
    assert.equal(pool._wallets[0].balance_credits, 600)
  })

  it('accepts a plain transfer to the treasury token account', async () => {
    const { store, pool } = await linkedStore({
      tx: (keys) => paymentTx({ destination: treasury, authority: keys.address, amount: '500000000', checked: false }),
    })
    const quote = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    await store.creditPurchase({ projectId: 'proj_1', quoteId: quote.quoteId, signature: 'F'.repeat(88) })
    assert.equal(pool._wallets[0].balance_credits, 600)
  })

  it('enforces the daily credit cap', async () => {
    const { store } = await linkedStore({
      tx: (keys) => paymentTx({ destination: treasury, authority: keys.address, amount: '500000000' }),
    })
    const first = await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    await store.creditPurchase({ projectId: 'proj_1', quoteId: first.quoteId, signature: 'G'.repeat(88) })
    process.env.TCODE_PURCHASE_DAILY_CREDIT_CAP = '500'
    try {
      await assert.rejects(
        () => store.createPurchaseQuote({ projectId: 'proj_1', packId: 'builder' }),
        rejectsWith('daily_cap_reached'),
      )
    } finally {
      delete process.env.TCODE_PURCHASE_DAILY_CREDIT_CAP
    }
  })

  it('lists purchases for a project', async () => {
    const { store } = await linkedStore()
    await store.createPurchaseQuote({ projectId: 'proj_1', packId: 'starter' })
    const list = await store.listPurchases('proj_1')
    assert.equal(list.length, 1)
    assert.equal(list[0].packId, 'starter')
    assert.equal(list[0].status, 'quoted')
  })

  it('reports both rails for every pack with the $TCODE amount priced', async () => {
    const store = createTcodeStore({ pool: memoryPool(), fetchImpl: makeFetch() })
    const options = await store.listPaymentOptions()
    assert.equal(options.creditsPerUsd, CREDITS_PER_USD)
    assert.equal(options.treasuryAddress, treasury)
    assert.equal(options.tcode.available, true)
    assert.equal(options.packs.length, listCreditPacks().length)

    const starter = options.packs.find((p) => p.id === 'starter')
    assert.equal(starter.credits, 500)
    assert.equal(starter.amountUsd, 5)
    assert.equal(starter.tcode.available, true)
    assert.equal(starter.tcode.tokens, '500.000000')

    // Larger packs are deliberately not purchasable in $TCODE yet.
    const studio = options.packs.find((p) => p.id === 'studio')
    assert.equal(studio.tcode.available, false)
    assert.equal(studio.tcode.reason, 'pack_not_enabled')
  })

  it('reports $TCODE as unavailable without a treasury', async () => {
    const saved = process.env.TCODE_TREASURY_TOKEN_ACCOUNT
    delete process.env.TCODE_TREASURY_TOKEN_ACCOUNT
    try {
      const store = createTcodeStore({ pool: memoryPool(), fetchImpl: makeFetch() })
      const options = await store.listPaymentOptions()
      assert.equal(options.tcode.available, false)
      assert.equal(options.tcode.reason, 'treasury_not_configured')
      assert.equal(options.packs.every((p) => p.tcode.available === false), true)
    } finally {
      process.env.TCODE_TREASURY_TOKEN_ACCOUNT = saved
    }
  })
})

describe('credit pack catalog', () => {
  it('is one source of truth for both rails', () => {
    const packs = listCreditPacks()
    assert.deepEqual(
      packs.map((p) => p.id),
      ['starter', 'builder', 'growth', 'scale', 'pro', 'studio'],
    )
    assert.equal(packs[0].credits, 500)
    assert.equal(packs[0].amountCents, 500)
    assert.equal(packs[0].amountUsd, 5)
    assert.equal(getCreditPack('studio').credits, 25000)
    assert.equal(getCreditPack('nope'), null)
    assert.equal(getCreditPack(''), null)
    assert.equal(getCreditPack(undefined), null)
    assert.equal(getCreditPack(null), null)
  })

  it('prices both rails from the same credit count', () => {
    for (const pack of listCreditPacks()) {
      assert.equal(pack.amountCents, pack.credits)
      assert.equal(pack.amountUsd, pack.credits / CREDITS_PER_USD)
    }
  })

  it('maps provider variants by credit count', () => {
    const saved = process.env.LEMONSQUEEZY_VARIANT_MAP
    process.env.LEMONSQUEEZY_VARIANT_MAP = JSON.stringify({ 500: 'variant-500', 1000: 'variant-1000' })
    try {
      assert.equal(lemonSqueezyVariantFor('starter'), 'variant-500')
      assert.equal(lemonSqueezyVariantFor('builder'), 'variant-1000')
      assert.equal(lemonSqueezyVariantFor('growth'), null)
      assert.equal(lemonSqueezyVariantFor('nope'), null)
      assert.equal(lemonSqueezyVariantMap()['500'], 'variant-500')
    } finally {
      if (saved === undefined) delete process.env.LEMONSQUEEZY_VARIANT_MAP
      else process.env.LEMONSQUEEZY_VARIANT_MAP = saved
    }
  })

  it('treats an unparseable variant map as unconfigured rather than crashing', () => {
    const saved = process.env.LEMONSQUEEZY_VARIANT_MAP
    process.env.LEMONSQUEEZY_VARIANT_MAP = '{not json'
    try {
      assert.equal(lemonSqueezyVariantMap(), null)
      assert.equal(lemonSqueezyVariantFor('starter'), process.env.LEMONSQUEEZY_VARIANT_ID || null)
    } finally {
      if (saved === undefined) delete process.env.LEMONSQUEEZY_VARIANT_MAP
      else process.env.LEMONSQUEEZY_VARIANT_MAP = saved
    }
  })

  it('reports fiat checkout as unavailable when the provider is not configured', () => {
    const saved = {
      key: process.env.LEMONSQUEEZY_API_KEY,
      store: process.env.LEMONSQUEEZY_STORE_ID,
      variant: process.env.LEMONSQUEEZY_VARIANT_ID,
      map: process.env.LEMONSQUEEZY_VARIANT_MAP,
    }
    delete process.env.LEMONSQUEEZY_API_KEY
    delete process.env.LEMONSQUEEZY_STORE_ID
    delete process.env.LEMONSQUEEZY_VARIANT_ID
    delete process.env.LEMONSQUEEZY_VARIANT_MAP
    try {
      assert.equal(fiatCheckoutConfigured(), false)
      assert.equal(lemonSqueezyVariantFor('starter'), null)
    } finally {
      for (const [name, value] of [
        ['LEMONSQUEEZY_API_KEY', saved.key],
        ['LEMONSQUEEZY_STORE_ID', saved.store],
        ['LEMONSQUEEZY_VARIANT_ID', saved.variant],
        ['LEMONSQUEEZY_VARIANT_MAP', saved.map],
      ]) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
