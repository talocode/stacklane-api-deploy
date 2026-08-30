import { generateKeyPairSync, sign } from 'node:crypto'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  encodeBase58,
  decodeBase58,
  isSolanaAddress,
  verifyEd25519,
  decodeSignature,
  tokensFromRaw,
  tierFromTokens,
  periodUtc,
  challengeMessage,
  createTcodeStore,
  TcodeError,
} from '../netlify/functions/tcode.mjs'

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const raw = der.subarray(der.length - 32)
  return { publicKey: raw, privateKey, address: encodeBase58(raw) }
}

function makeFetch({ decimals = 6, amount = '1489000000' } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
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
    return { ok: false, status: 500, json: async () => ({ error: 'unknown' }) }
  }
}

function memoryPool() {
  const challenges = new Map()
  const links = []
  const receipts = []
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
        type: 'tcode_tier',
        credits_delta: params[2],
        balance_after: params[3],
        reference: params[4],
        metadata: params[5],
      })
      return result([])
    }
    throw new Error(`unexpected sql: ${text}`)
  }

  return {
    query,
    connect: async () => ({ query, release() {} }),
    _wallets: wallets,
    _receipts: receipts,
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
