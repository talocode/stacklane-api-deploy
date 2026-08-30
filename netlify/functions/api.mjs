import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import pg from 'pg'
import { createTcodeStore, publicConfig as tcodePublicConfig, TcodeError, TCODE_SCHEMA_SQL } from './tcode.mjs'

const DB_PATH = '/tmp/stacklane-db.json'
const BLOB_STORE = 'stacklane-cloud'
const BLOB_KEY = 'main-db'
const { Pool } = pg

/** @type {any} */
let dbCache = null
let pool = null
let postgresReady = null
let tcodeStore = null

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be configured for persistent API storage.')
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 10_000,
    })
  }
  return pool
}

function getTcodeStore() {
  if (!tcodeStore) {
    tcodeStore = createTcodeStore({ pool: getPool(), makeId })
  }
  return tcodeStore
}

function syncCacheWallet(db, wallet) {
  if (!db || !wallet?.projectId) return
  if (!db.wallets) db.wallets = {}
  db.wallets[wallet.projectId] = {
    ...(db.wallets[wallet.projectId] || {}),
    ...wallet,
  }
}

function tcodeFail(error, e, requestId) {
  if (error instanceof TcodeError) return e(error.status, error.code, error.message)
  console.error('[tcode]', error instanceof Error ? error.message : error)
  return e(503, 'tcode_unavailable', 'Could not complete $TCODE request')
}

async function ensurePostgres() {
  if (!postgresReady) {
    postgresReady = (async () => {
      const client = await getPool().connect()
      try {
        await client.query('SELECT 1 FROM stacklane.users LIMIT 1')
        const statements = TCODE_SCHEMA_SQL.split(';').map((part) => part.trim()).filter(Boolean)
        for (const sql of statements) await client.query(sql)
      } finally {
        client.release()
      }
    })()
  }
  return postgresReady
}

function seedDb() {
  const now = new Date().toISOString()
  return {
    users: [],
    sessions: {},
    api_keys: {},
    project_api_keys: [],
    cloud_projects: [],
    cloud_api_keys: [],
    topups: [],
    profiles: {},
    usage_events: [],
    regions: [
      { id: 'reg-ng-lagos', code: 'ng-lagos', name: 'Lagos, Nigeria', marketScope: 'africa-west', deploymentTarget: 'africa-west1', isActive: true, createdAt: now, updatedAt: now },
      { id: 'reg-us-east', code: 'us-east', name: 'US East (N. Virginia)', marketScope: 'global', deploymentTarget: 'us-east-1', isActive: true, createdAt: now, updatedAt: now },
    ],
    organizations: [
      { id: 'org-talocode', name: 'Talocode', slug: 'talocode', status: 'active', createdAt: now, updatedAt: now },
    ],
    projects: [
      { id: 'proj-tera-api', name: 'Tera API', slug: 'tera-api', status: 'ready', region: 'us-east', description: 'Talocode Tera API', organizationId: 'org-talocode', createdAt: now, updatedAt: now },
    ],
    environments: [],
    provisioning_tasks: [],
    provisioning_attempts: [],
    audit_events: [],
    wallets: {},
    transactions: [],
  }
}

function getBlobStore() {
  try {
    const mod = globalThis.__netlify_blobs
    if (!mod?.getStore) return null
    const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || process.env.BLOBS_SITE_ID
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN
    // On Netlify runtime, getStore works without siteID/token (context injected).
    // Outside, pass credentials when present.
    if (siteID && token) {
      return mod.getStore({ name: BLOB_STORE, consistency: 'strong', siteID, token })
    }
    return mod.getStore({ name: BLOB_STORE, consistency: 'strong' })
  } catch (err) {
    console.error('[db] getStore failed', err?.message || err)
    return null
  }
}

async function initBlobs() {
  if (globalThis.__netlify_blobs) return
  try {
    globalThis.__netlify_blobs = await import('@netlify/blobs')
  } catch {
    globalThis.__netlify_blobs = null
  }
}

async function loadDb() {
  if (dbCache) return dbCache
  await ensurePostgres()
  const database = getPool()
  const existing = await database.query('SELECT COUNT(*)::int AS count FROM stacklane.users')
  if (existing.rows[0].count > 0) {
    const [users, sessions, projects, keys, wallets, transactions, usageEvents, topups] = await Promise.all([
      database.query('SELECT id, email, name, password_hash, status, last_login_at, created_at, updated_at FROM stacklane.users'),
      database.query('SELECT token_hash, user_id, created_at FROM stacklane.sessions WHERE expires_at > now()'),
      database.query('SELECT id, owner_id, name, slug, created_at, updated_at FROM stacklane.cloud_projects'),
      database.query('SELECT id, project_id, user_id, name, prefix, key_hash, mode, status, last_used_at, created_at, updated_at FROM stacklane.api_keys'),
      database.query('SELECT id, project_id, balance_credits, lifetime_credits, lifetime_spend, free_credits_granted, created_at, updated_at FROM stacklane.wallets'),
      database.query('SELECT id, wallet_id, type, credits_delta, balance_after, reference, metadata, created_at FROM stacklane.transactions'),
      database.query('SELECT id, project_id, user_id, api_key_id, product, action, credits, status, metadata, created_at FROM stacklane.usage_events'),
      database.query('SELECT id, project_id, credits, amount_usd, status, provider, created_at, updated_at FROM stacklane.topups'),
    ])
    dbCache = {
      users: users.rows.map((row) => ({ id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash, status: row.status, lastLoginAt: iso(row.last_login_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
      sessions: Object.fromEntries(sessions.rows.map((row) => [row.token_hash, { userId: row.user_id, createdAt: iso(row.created_at) }])),
      cloud_projects: projects.rows.map((row) => ({ id: row.id, ownerId: row.owner_id, name: row.name, slug: row.slug, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
      cloud_api_keys: keys.rows.map((row) => ({ id: row.id, projectId: row.project_id, userId: row.user_id, name: row.name, prefix: row.prefix, keyHash: row.key_hash, mode: row.mode, status: row.status, lastUsedAt: iso(row.last_used_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
      api_keys: Object.fromEntries(keys.rows.filter((row) => row.status === 'active').map((row) => [`sha256:${row.key_hash}`, row.user_id])),
      wallets: Object.fromEntries(wallets.rows.map((row) => [row.project_id, { id: row.id, projectId: row.project_id, balance: row.balance_credits, lifetimeCredits: row.lifetime_credits, lifetimeSpend: row.lifetime_spend, freeCreditsGranted: row.free_credits_granted, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }])),
      transactions: transactions.rows.map((row) => ({ id: row.id, walletId: row.wallet_id, type: row.type, creditsDelta: row.credits_delta, balanceAfter: row.balance_after, reference: row.reference, metadata: row.metadata, createdAt: iso(row.created_at) })),
      usage_events: usageEvents.rows.map((row) => ({ id: row.id, project_id: row.project_id, user_id: row.user_id, api_key_id: row.api_key_id, product: row.product, action: row.action, credits: row.credits, status: row.status, metadata: row.metadata, created_at: iso(row.created_at) })),
      topups: topups.rows.map((row) => ({ id: row.id, projectId: row.project_id, credits: row.credits, amountUsd: Number(row.amount_usd), status: row.status, provider: row.provider, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
      profiles: Object.fromEntries(wallets.rows.map((row) => [row.project_id, { purchased_credits_balance: row.balance_credits, free_plan_credits_used: 0 }])),
      project_api_keys: [], regions: [], organizations: [], projects: [], environments: [], provisioning_tasks: [], provisioning_attempts: [], audit_events: [],
    }
    return dbCache
  }

  // One-time migration path for the prototype Blob store. Postgres is authoritative after this write.
  await initBlobs()
  const store = getBlobStore()
  if (store) {
    try {
      const data = await store.get(BLOB_KEY, { type: 'json' })
      if (data && Array.isArray(data.users)) {
        dbCache = data
        normalizeStoredSecrets(dbCache)
        await saveDb(dbCache)
        return dbCache
      }
    } catch (err) {
      console.error('[db] blob load failed', err?.message || err)
    }
  }
  try {
    dbCache = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))
    normalizeStoredSecrets(dbCache)
    await saveDb(dbCache)
    return dbCache
  } catch {
    dbCache = seedDb()
    await saveDb(dbCache)
    return dbCache
  }
}

async function saveDb(db) {
  dbCache = db
  await ensurePostgres()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    try {
      await getTcodeStore().mergeSqlWalletsIntoCache(db)
    } catch (error) {
      console.error('[tcode] merge wallets failed', error instanceof Error ? error.message : error)
    }
    await client.query('DELETE FROM stacklane.sessions')
    await client.query('DELETE FROM stacklane.usage_events')
    await client.query('DELETE FROM stacklane.transactions')
    await client.query('DELETE FROM stacklane.topups')
    await client.query('DELETE FROM stacklane.api_keys')
    await client.query('DELETE FROM stacklane.wallets')
    await client.query('DELETE FROM stacklane.cloud_projects')
    for (const user of db.users || []) {
      await client.query('INSERT INTO stacklane.users (id, email, name, password_hash, status, last_login_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,status=EXCLUDED.status,last_login_at=EXCLUDED.last_login_at,updated_at=EXCLUDED.updated_at', [user.id, user.email, user.name, user.passwordHash, user.status || 'active', user.lastLoginAt, user.createdAt, user.updatedAt])
    }
    for (const project of db.cloud_projects || []) await client.query('INSERT INTO stacklane.cloud_projects (id, owner_id, name, slug, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)', [project.id, project.ownerId, project.name, project.slug, project.createdAt, project.updatedAt])
    for (const wallet of Object.values(db.wallets || {})) await client.query('INSERT INTO stacklane.wallets (id, project_id, balance_credits, lifetime_credits, lifetime_spend, free_credits_granted, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [wallet.id, wallet.projectId, wallet.balance || wallet.balanceCredits || 0, wallet.lifetimeCredits || 0, wallet.lifetimeSpend || 0, !!wallet.freeCreditsGranted, wallet.createdAt, wallet.updatedAt])
    for (const key of db.cloud_api_keys || []) await client.query('INSERT INTO stacklane.api_keys (id, project_id, user_id, name, prefix, key_hash, mode, status, last_used_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [key.id, key.projectId, key.userId || db.api_keys[`sha256:${key.keyHash}`], key.name, key.prefix, key.keyHash, key.mode, key.status, key.lastUsedAt, key.createdAt, key.updatedAt])
    for (const [tokenHash, session] of Object.entries(db.sessions || {})) await client.query('INSERT INTO stacklane.sessions (token_hash, user_id, expires_at, created_at) VALUES ($1,$2,now() + interval \'7 days\',$3)', [tokenHash, session.userId, session.createdAt])
    for (const tx of db.transactions || []) await client.query('INSERT INTO stacklane.transactions (id, wallet_id, type, credits_delta, balance_after, reference, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [tx.id, tx.walletId, tx.type, tx.creditsDelta, tx.balanceAfter, tx.reference, tx.metadata || {}, tx.createdAt])
    for (const event of db.usage_events || []) await client.query('INSERT INTO stacklane.usage_events (id, project_id, user_id, api_key_id, product, action, credits, status, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [event.id || makeId('ue'), event.project_id, event.user_id, event.api_key_id, event.product, event.action, event.credits, event.status || 'charged', event.metadata || {}, event.created_at])
    for (const topup of db.topups || []) await client.query('INSERT INTO stacklane.topups (id, project_id, credits, amount_usd, status, provider, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [topup.id, topup.projectId, topup.credits, topup.amountUsd, topup.status, topup.provider, topup.createdAt, topup.updatedAt || topup.createdAt])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

function makeToken() {
  return randomBytes(32).toString('hex')
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}

function verifyPassword(password, encoded) {
  if (!encoded || !encoded.includes(':')) return false
  const [salt, digest] = encoded.split(':')
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(digest, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

function hashApiKey(key) {
  return createHash('sha256').update(key).digest('hex')
}

function iso(value) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.toISOString === 'function') return value.toISOString()
  return value
}

function normalizeStoredSecrets(db) {
  let changed = false
  for (const user of db.users || []) {
    if (user.password) {
      user.passwordHash = hashPassword(user.password)
      delete user.password
      changed = true
    }
  }
  for (const key of db.cloud_api_keys || []) {
    if (key.rawKey) {
      key.keyHash = hashApiKey(key.rawKey)
      delete key.rawKey
      changed = true
    }
  }
  if (db.api_keys && Object.keys(db.api_keys).some((key) => !key.startsWith('sha256:'))) {
    db.api_keys = Object.fromEntries(
      Object.entries(db.api_keys).map(([key, userId]) => [`sha256:${hashApiKey(key)}`, userId]),
    )
    changed = true
  }
  if (Object.keys(db.sessions || {}).length) {
    db.sessions = {}
    changed = true
  }
  const validUserIds = new Set((db.users || []).filter((user) => user.passwordHash).map((user) => user.id))
  if ((db.users || []).length !== validUserIds.size) {
    db.users = db.users.filter((user) => validUserIds.has(user.id))
    const projectIds = new Set((db.cloud_projects || []).filter((project) => validUserIds.has(project.ownerId)).map((project) => project.id))
    db.cloud_projects = (db.cloud_projects || []).filter((project) => projectIds.has(project.id))
    db.cloud_api_keys = (db.cloud_api_keys || []).filter((key) => projectIds.has(key.projectId))
    db.api_keys = Object.fromEntries(Object.entries(db.api_keys || {}).filter(([, userId]) => validUserIds.has(userId)))
    db.wallets = Object.fromEntries(Object.entries(db.wallets || {}).filter(([projectId]) => projectIds.has(projectId)))
    db.topups = (db.topups || []).filter((topup) => projectIds.has(topup.projectId))
    changed = true
  }
  return changed
}

function makeId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function makeRequestId() {
  return `sl_req_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ── Unified balance helpers ──────────────────────────────────────────
// Wallet is the single source of truth for credits.  Deposits (topup,
// TCODE, free grant) write wallet.balance.  Consumption MUST also
// deduct from wallet.balance so the two never diverge.  Profiles are
// derived from wallets at load time and kept in sync after each debit.

function resolveWallet(db, userId) {
  const project = (db.cloud_projects || []).find((p) => p.ownerId === userId)
  if (!project) return null
  return db.wallets[project.id] || null
}

function debitCredits(db, userId, credits, product, action, requestId) {
  const wallet = resolveWallet(db, userId)
  const now = new Date().toISOString()
  if (wallet) {
    const balance = wallet.balance || 0
    if (balance < credits) return { ok: false, balance, required: credits }
    wallet.balance = balance - credits
    wallet.updatedAt = now
    db.transactions.push({
      id: makeId('ctxn'),
      walletId: wallet.id,
      type: 'usage',
      creditsDelta: -credits,
      balanceAfter: wallet.balance,
      product, action,
      reference: requestId,
      metadata: {},
      createdAt: now,
    })
    const profile = db.profiles?.[userId]
    if (profile) profile.purchased_credits_balance = wallet.balance
    return { ok: true, balance: wallet.balance }
  }
  const profile = db.profiles?.[userId]
  if (!profile) return { ok: false, balance: 0, required: credits }
  const bal = profile.purchased_credits_balance || 0
  if (bal < credits) return { ok: false, balance: bal, required: credits }
  profile.purchased_credits_balance = bal - credits
  return { ok: true, balance: profile.purchased_credits_balance }
}

function extractApiKey(headers) {
  const a = headers['authorization'] || headers['Authorization'] || ''
  if (typeof a === 'string' && a.toLowerCase().startsWith('bearer ')) return a.slice(7).trim()
  return (
    headers['x-talocode-api-key'] || headers['X-Talocode-Api-Key'] ||
    headers['x-api-key'] || headers['X-Api-Key'] || null
  )
}

async function requireApiKey(headers) {
  const key = extractApiKey(headers)
  if (!key) return { ok: false, status: 401, code: 'missing_api_key', message: 'API key required. Use Authorization: Bearer <TALOCODE_API_KEY>' }
  const db = await loadDb()
  // Accept database-backed keys or the explicitly configured emergency key.
  const envKey = process.env.TALOCODE_API_KEY
  const keyOwner = db.api_keys[`sha256:${hashApiKey(key)}`]
  if (keyOwner || (envKey && key === envKey)) {
    return { ok: true, key, userId: keyOwner || 'user-admin-001' }
  }
  return { ok: false, status: 401, code: 'invalid_api_key', message: 'Invalid API key' }
}

async function findKeyEntry(db, key) {
  const userId = db.api_keys[`sha256:${hashApiKey(key)}`]
  const entry = (db.cloud_api_keys || []).find((k) => k.keyHash === hashApiKey(key)) ||
    (db.cloud_api_keys || []).find((k) => `sha256:${k.keyHash}` === `sha256:${hashApiKey(key)}`)
  const project = entry && (db.cloud_projects || []).find((p) => p.id === entry.projectId)
  return { userId, keyId: entry?.id || null, projectId: project?.id || null }
}

// Shared credit-charging + usage-metering primitive. Authenticates, debits the
// user's wallet, records a usage_event (with project_id + api_key_id), and
// persists. Every metered product endpoint should call this so all usage shows
// up on dashboard.talocode.site/usage. Returns raw result; the caller builds the
// HTTP response (use chargeResponse to map errors).
async function chargeCredits(headers, product, action, credits, requestId, metadata) {
  const auth = await requireApiKey(headers)
  if (!auth.ok) return { ok: false, status: auth.status, code: auth.code, message: auth.message }
  const db = await loadDb()
  const keyInfo = await findKeyEntry(db, auth.key)
  const userId = keyInfo.userId || auth.userId || 'user-admin-001'
  const dc = debitCredits(db, userId, credits, product, action, requestId)
  if (!dc.ok) {
    return { ok: false, status: 402, code: 'insufficient_credits', message: `Insufficient credits. Required: ${dc.required}, Balance: ${dc.balance}`, required: dc.required, balance: dc.balance }
  }
  const wallet = resolveWallet(db, userId)
  if (wallet) {
    wallet.lifetimeSpend = (wallet.lifetimeSpend || 0) + credits
  }
  db.usage_events.push({
    user_id: userId,
    project_id: keyInfo.projectId || wallet?.projectId || null,
    api_key_id: keyInfo.keyId || null,
    product,
    action,
    credits,
    status: 'charged',
    metadata: metadata || {},
    created_at: new Date().toISOString(),
    request_id: requestId,
  })
  await saveDb(db)
  return { ok: true, userId, remaining: dc.balance, projectId: keyInfo.projectId, apiKeyId: keyInfo.keyId }
}

async function providerChat(messages, model, opts = {}) {
  // All Tera traffic routes through Talocode's own API. The model call is made
  // by the Tera service (api.teraai.chat); this gateway authenticates, meters,
  // and forwards so no external provider key ever touches this function.
  const upstream = process.env.TERA_BASE_URL || 'https://api.teraai.chat'
  const token = process.env.TALOCODE_API_KEY || process.env.TERA_UPSTREAM_KEY || ''
  const forwarded = { model: model || 'default', messages }
  const passthroughKeys = ['temperature', 'max_tokens', 'top_p', 'top_k', 'response_format', 'tool_choice', 'stream']
  for (const key of passthroughKeys) {
    if (opts[key] !== undefined && opts[key] !== null) {
      forwarded[key] = opts[key]
    }
  }
  const r = await fetch(`${upstream}/v1/tera/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(forwarded),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`Tera upstream ${r.status} ${text.slice(0, 200)}`)
  }
  const json = await r.json().catch(() => null)
  if (!json) throw new Error('Tera upstream returned non-JSON')
  // Normalize to one shape: { result: { choices, usage } } or { choices, usage }
  if (json.choices && !json.result) return json
  return json
}

function extractSession(headers) {
  const cookie = headers['cookie'] || headers['Cookie'] || ''
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === 'sl_session') return rest.join('=')
  }
  return null
}

async function authenticate(headers) {
  const token = extractSession(headers)
  if (!token) return null
  const db = await loadDb()
  const session = db.sessions[hashApiKey(token)]
  if (!session) return null
  const user = db.users.find(u => u.id === session.userId)
  return user || null
}

function jsonBody(body) {
  try { return typeof body === 'string' ? JSON.parse(body) : body } catch { return null }
}

function toSafeUser(user) {
  const { password, passwordHash, ...safe } = user
  return safe
}

function corsHeaders(origin) {
  const allowed = [
    'https://dashboard.talocode.site',
    'https://stacklane.talocode.site',
    'https://stacklane-web.netlify.app',
    'https://talocode.site',
    'https://cloud.talocode.site',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
  ]
  const match = origin && allowed.includes(origin) ? origin : (allowed.includes(origin) ? origin : null)
  return {
    'Access-Control-Allow-Origin': match || 'https://dashboard.talocode.site',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Talocode-Api-Key, Cookie',
    'Vary': 'Origin',
  }
}

function respond(status, data, extra) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', ...(extra || {}) }, body: JSON.stringify(data) }
}

function withCors(result, origin) {
  if (result && result.headers) Object.assign(result.headers, corsHeaders(origin))
  return result
}

function ok(body, requestId) {
  return { data: body, meta: { requestId } }
}

function fail(code, message, requestId) {
  return { error: { code, message, requestId } }
}

function normalizePath(p) {
  if (!p) return '/'
  // Netlify may pass raw or function-prefixed paths
  const prefixes = [
    '/.netlify/functions/api',
    '/.netlify/functions/api/',
  ]
  for (const prefix of prefixes) {
    if (p === prefix || p === prefix.slice(0, -1)) return '/'
    if (p.startsWith(prefix)) {
      p = p.slice(prefix.length)
      break
    }
  }
  if (!p.startsWith('/')) p = '/' + p
  // strip trailing slash except root
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

function handleError(err, requestId, origin) {
  return withCors(respond(503, fail('internal_error', err.message, requestId)), origin)
}

const MCP_TOOLS = [
  { name: "tera_writing_rewrite", description: "Rewrite text with a specific style and tone using Tera. Provide text to rewrite and optional style/tone/maxLength parameters." },
  { name: "tera_writing_draft", description: "Draft content (email, social post, announcement, article, doc) using Tera. Provide type and brief describing what to write." },
  { name: "tera_coding_explain", description: "Explain code at beginner, intermediate, or advanced level using Tera. Provide language and code snippet." },
  { name: "tera_coding_review", description: "Review code for issues, bugs, security, and performance using Tera. Provide language and code to review." },
  { name: "agent_browser_check", description: "Check a website URL for status, content, and optionally capture a screenshot or run vision analysis. Provide URL to check." },
  { name: "agent_browser_screenshot", description: "Capture a screenshot of a website URL. Optionally set fullPage, viewport width/height. Provide URL to screenshot." },
  { name: "agent_browser_trace_report", description: "Execute browser trace steps on a URL and report results. Provide URL and array of steps (click, type, navigate)." },
  { name: "agent_browser_extract", description: "Extract structured content from a URL including title, description, headings, text, links, images, and metadata. Returns clean readable content without browser rendering." },
  { name: "agent_browser_analyze", description: "Analyze page content from a URL using AI. Returns summary, sentiment, entities, topics, and keywords extracted from the page text." },
  { name: "cliploop_brief_generate", description: "Generate a video brief for short-form content. Provide a prompt describing the video concept and optional channel/tone/duration." },
  { name: "cliploop_script_generate", description: "Generate a video script from a brief. Provide the briefId from brief generation." },
  { name: "cliploop_video_render", description: "Render a video from a script. Provide the scriptId from script generation and optional format/quality." },
  { name: "cliploop_campaign_create", description: "Create a ClipLoop campaign. Provide name and platform." },
  { name: "cliploop_campaign_package", description: "Package a ClipLoop campaign for delivery. Provide campaignId." },
  { name: "cloud_pricing", description: "Get the full Talocode Cloud pricing catalog with all products, actions, and credit costs." },
  { name: "invoicelane_health", description: "Check InvoiceLane Document API health, version (v0.2), and available endpoints. Free (no credits)." },
  { name: "invoicelane_pricing", description: "Get InvoiceLane credit pricing: extract 20, receipt.extract 20, invoice.extract 30, validate 10, export.csv 5. Free (no credits)." },
  { name: "invoicelane_capabilities", description: "List InvoiceLane capabilities, schema contract (invoice requires invoiceNumber/total/currency/date; receipt requires total/currency/date), endpoints, and limitations (text-only, no OCR/PDF in v0.2). Free (no credits)." },
  { name: "invoicelane_extract", description: "Schema-first extract from invoice/receipt text. Returns merchant/vendor, totals, line items, confidence, missingFields, totalsConsistent, warnings. Provide text (OCR/PDF not supported). 20 credits." },
  { name: "invoicelane_extract_receipt", description: "Extract a receipt as structured JSON (receiptNumber, vendor, total, date, missingFields, totalsConsistent). Provide raw receipt text. 20 credits." },
  { name: "invoicelane_extract_invoice", description: "Extract an invoice as structured JSON (invoiceNumber, vendor, subtotal, tax, total, line items, missingFields, totalsConsistent). Schema requires invoiceNumber, total, currency, date. Provide raw invoice text. 30 credits." },
  { name: "invoicelane_validate", description: "Validate extracted fields against the InvoiceLane schema contract. Checks required fields, numeric totals, and totals consistency (subtotal + tax - discount ≈ total). Returns valid, missingFields, warnings, normalized. 10 credits." },
  { name: "invoicelane_export_csv", description: "Export an array of extracted invoice/receipt row objects to CSV (escaped headers and values). 5 credits." },
  { name: "geolane_health", description: "Check GeoLane AI Visibility API health and endpoints. Free (no credits)." },
  { name: "geolane_pricing", description: "Get GeoLane credit pricing: audit 40, crawlers 15, llms_txt 20, citation_readiness 25, compare 50. Free." },
  { name: "geolane_capabilities", description: "List GeoLane capabilities: GEO score, AI crawler matrix, citation readiness, llms.txt draft, domain compare. Free." },
  { name: "geolane_audit", description: "Full AI search visibility (GEO) audit for a URL: composite score/grade, AI crawler access, citation readiness, llms.txt, prioritized action plan. Pay-per-domain intelligence agents use before SEO/content work. 40 credits." },
  { name: "geolane_crawlers", description: "Check whether major AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, etc.) are allowed in robots.txt. 15 credits." },
  { name: "geolane_llms_txt", description: "Detect /llms.txt, score quality, and generate a ready-to-publish llms.txt draft for AI agents. 20 credits." },
  { name: "geolane_citation_readiness", description: "Score a page for AI citation readiness: title, meta, H1, JSON-LD, author/date, FAQ, passage length (~134–167 words), headings. Returns gaps and recommendations. 25 credits." },
  { name: "geolane_compare", description: "Compare two domains/pages on GEO score, crawler access, citation readiness, and llms.txt. Provide urlA and urlB. 50 credits." },
  { name: "searchlane_health", description: "Check SearchLane agent search API health and endpoints. Free." },
  { name: "searchlane_pricing", description: "Get SearchLane credit pricing: query 5, news 8, research 30. Free." },
  { name: "searchlane_capabilities", description: "List SearchLane capabilities: web query, news search, multi-source research with citations. Free." },
  { name: "searchlane_query", description: "Agent web search. Returns ranked structured hits (title, url, snippet, score). Uses Brave/Serper if keys set, else DuckDuckGo. 5 credits." },
  { name: "searchlane_news", description: "News/freshness-biased search for agents. Returns structured news-oriented hits. 8 credits." },
  { name: "searchlane_research", description: "Deep research: multi-source search + extractive brief with citations. Best for agent research steps. 30 credits." },
  { name: "calclane_health", description: "Check CalcLane calculator API health and endpoints. Free." },
  { name: "calclane_pricing", description: "Get CalcLane credit pricing: evaluate 1, dispatch 1. Free." },
  { name: "calclane_capabilities", description: "List CalcLane modes, features, and HTTP endpoints. Free." },
  { name: "calclane_evaluate", description: "Evaluate a math expression (standard or scientific). Supports + - * / ^, parentheses, sin/cos/tan, log/ln, sqrt, fact, pi, e. 1 credit." },
  { name: "calclane_dispatch", description: "Run calculator engine commands (digit, binary, unary, equals, memory-style flows). 1 credit." },
  { name: "reliabilitylane_health", description: "Check ReliabilityLane reliability API health and endpoints. Free." },
  { name: "reliabilitylane_pricing", description: "Get ReliabilityLane credit pricing: patterns/retry/verify 1, incident 2. Free." },
  { name: "reliabilitylane_capabilities", description: "List ReliabilityLane datasets and HTTP endpoints. Free." },
  { name: "reliabilitylane_patterns", description: "List all curated ReliabilityLane failure patterns (retry hammering, unverified completion, ...). Free." },
  { name: "reliabilitylane_retries", description: "List all ReliabilityLane retry strategies with backoff plans. Free." },
  { name: "reliabilitylane_checklists", description: "List all ReliabilityLane verification checklists (deployment, code, security, content, data). Free." },
  { name: "reliabilitylane_playbooks", description: "List all ReliabilityLane incident playbooks (deploy failed, outage, dangerous tool call). Free." },
  { name: "reliabilitylane_antipatterns", description: "List ReliabilityLane anti-patterns to avoid (trusting the green check, retrying everything, ...). Free." },
  { name: "reliabilitylane_match", description: "Match a failure symptom to a curated ReliabilityLane pattern (retry hammering, unverified completion, lost context, wrong math, ...). 1 credit." },
  { name: "reliabilitylane_retry_plan", description: "Plan a retry for an error: classification + backoff strategy (transient, rate limit, timeout). 1 credit." },
  { name: "reliabilitylane_verify", description: "Verify work against a curated checklist (deployment, code, security, content, data) and return a pass/incomplete/fail verdict. 1 credit." },
  { name: "reliabilitylane_incident", description: "Find the incident playbook for a failure (deploy failed, outage detected, dangerous tool call caught). 2 credits." },
  { name: "skills_generate_github_profile", description: "Generate an installable AI skill from a public GitHub profile. Provide a GitHub username." },
  { name: "skills_generate_github_repo", description: "Generate an installable AI skill from a public GitHub repository. Provide the full repo URL." },
  { name: "skills_generate_docs", description: "Generate an installable AI skill from a documentation URL. Provide the full docs URL." },
  { name: "skills_generate_text", description: "Generate an installable AI skill from raw text content. Provide a name and the text content." },
  { name: "skills_generate_recording", description: "Generate an installable AI skill from a screen recording. Provide a video URL and optional frame descriptions." },
  { name: "skills_export_cursor", description: "Export a generated skill as Cursor-compatible files (SKILL.md, .cursorrules). Provide the skill object with name and skillMd." },
  { name: "skills_export_claude", description: "Export a generated skill as Claude Code-compatible files (SKILL.md, CLAUDE.md). Provide the skill object with name and skillMd." },
  { name: "ugclane_strategy_generate", description: "Generate a content strategy based on goals, niche, and platform." },
  { name: "ugclane_competitor_analyze", description: "Analyze competitor content strategies and patterns." },
  { name: "ugclane_hooks_generate", description: "Generate attention-grabbing hooks for content." },
  { name: "ugclane_scripts_generate", description: "Generate video or post scripts for content." },
  { name: "ugclane_accounts_plan", description: "Plan account growth strategy for a social platform." },
  { name: "ugclane_calendar_generate", description: "Generate a content calendar for a month." },
  { name: "ugclane_experiments_generate", description: "Design content experiments to optimize performance." },
  { name: "ugclane_report_generate", description: "Generate a performance report for content." },
  { name: "ugclane_export_markdown", description: "Export UGCLane output as markdown." },
  { name: "ugclane_export_json", description: "Export UGCLane output as JSON." },
  { name: "signallane_x_analyze", description: "Analyze X (Twitter) account metrics for growth signals" },
  { name: "signallane_x_content_plan", description: "Generate a weekly content strategy for X" },
  { name: "signallane_x_post_drafts", description: "Generate post drafts for X" },
  { name: "signallane_x_experiments", description: "Design content experiments for X" },
  { name: "webdatalane_fetch", description: "Fetch a webpage by URL and return its HTML and text content." },
  { name: "webdatalane_extract", description: "Extract all content from a webpage: markdown, metadata, links, headings, images, JSON-LD, and tables." },
  { name: "webdatalane_markdown", description: "Convert a webpage or HTML to clean markdown. Optionally strip navigation elements." },
  { name: "webdatalane_metadata", description: "Extract metadata from a webpage: title, description, canonical, OpenGraph, Twitter card, and JSON-LD count." },
  { name: "webdatalane_links", description: "Extract all links from a webpage, classified as internal or external." },
  { name: "webdatalane_structured", description: "Extract structured data fields from a webpage using a schema and hints." },
  { name: "webdatalane_crawl_plan", description: "Generate a crawl plan from a seed URL, discovering internal and external links for multi-page extraction." },
  { name: "webdatalane_screenshot", description: "Capture a screenshot of a webpage. Note: not available in v0.1, returns BROWSER_RENDERING_NOT_AVAILABLE." },
  { name: "signallane_x_report", description: "Generate a full X growth intelligence report" },
  { name: "crawlerlane_logs_ingest", description: "Ingest access logs from a website you own. Logs may contain sensitive data — redact IPs before sending. Bot classification is heuristic." },
  { name: "crawlerlane_bots_classify", description: "Classify a user-agent as bot or human. Heuristic only — not guaranteed identity." },
  { name: "crawlerlane_pages_analyze", description: "Analyze crawl coverage and bot traffic by page for a domain you own." },
  { name: "crawlerlane_404_analyze", description: "Find missing pages requested by bots and crawlers on a domain you own." },
  { name: "crawlerlane_ai_visibility_score", description: "Score AI visibility for a domain you own based on bot crawl signals." },
  { name: "crawlerlane_report_generate", description: "Generate a weekly crawler intelligence report for a domain you own." },
  { name: "crawlerlane_sitemap_suggest", description: "Suggest sitemap entries and redirects based on crawl and 404 signals." },
  { name: "crawlerlane_robots_audit", description: "Audit robots.txt for AI crawler and search engine visibility." },
  { name: "crawlerlane_export_markdown", description: "Export a CrawlerLane report as markdown." },
  { name: "crawlerlane_export_json", description: "Export a CrawlerLane report as JSON." },
  { name: "opensourcelane_repo_analyze", description: "Analyze an open-source repo for adoption fit. Risk scores are heuristic — not security audits." },
  { name: "opensourcelane_alternatives_find", description: "Find open-source alternatives to expensive SaaS tools." },
  { name: "opensourcelane_migration_plan", description: "Generate a migration plan from SaaS to open-source. Not legal or financial advice." },
  { name: "opensourcelane_cost_estimate", description: "Estimate cost savings from switching to open-source. Estimates only — not financial advice." },
  { name: "opensourcelane_risk_score", description: "Score adoption risk heuristically. Not a security audit." },
  { name: "opensourcelane_brief_generate", description: "Generate an adoption brief for an open-source tool." },
  { name: "opensourcelane_tools_compare", description: "Compare multiple open-source tools side by side." },
  { name: "opensourcelane_deployment_plan", description: "Generate a self-hosting deployment plan." },
  { name: "opensourcelane_license_audit", description: "Audit license obligations. Not legal advice." },
  { name: "opensourcelane_export_markdown", description: "Export OpenSourceLane analysis as markdown." },
  { name: "opensourcelane_export_json", description: "Export OpenSourceLane analysis as JSON." },
  { name: "forgecad_design_generate", description: "Generate parametric CAD design with OpenSCAD, BOM, and manufacturing notes. Human engineering review required. Not certified engineering software." },
  { name: "forgecad_openscad_generate", description: "Generate parametric OpenSCAD script. Draft only — human review required." },
  { name: "forgecad_bom_generate", description: "Generate bill of materials for a CAD project." },
  { name: "forgecad_cutlist_generate", description: "Generate cut list for frames and panels." },
  { name: "forgecad_assembly_plan", description: "Generate assembly plan steps. Human review required." },
  { name: "forgecad_printability_check", description: "Check FDM 3D printability heuristically. Not a certified DFM analysis." },
  { name: "forgecad_manufacturability_check", description: "Check manufacturability for laser cutting, sheet metal, etc. Informational only." },
  { name: "forgecad_design_review", description: "Generate design review report. Not a certified engineering review." },
  { name: "forgecad_material_estimate", description: "Estimate material usage for a design." },
  { name: "forgecad_tools_detect", description: "Detect OpenSCAD and FreeCAD installation." },
  { name: "forgecad_render_openscad", description: "Render OpenSCAD to STL/PNG if OpenSCAD is installed. Returns TOOL_NOT_AVAILABLE otherwise." },
  { name: "forgecad_export_markdown", description: "Export ForgeCAD design report as markdown." },
  { name: "forgecad_export_json", description: "Export ForgeCAD design as JSON." },
  { name: "replylane_opportunity_score", description: "Score an X tweet for strategic reply opportunity (timing, author size, competition)." },
  { name: "replylane_targets_rank", description: "Rank X accounts for reply targeting in the 5-20x follower sweet spot." },
  { name: "replylane_replies_draft", description: "Draft strategic X replies (data, experience, insight, question, etc.). Human review required." },
  { name: "replylane_replies_risk", description: "Score X reply deboost/spam risk before posting." },
  { name: "replylane_posts_grok_check", description: "Check Grok/constructive tone compatibility for an X post or reply draft." },
  { name: "replylane_activity_audit", description: "Audit 70/30 reply vs post activity balance." },
  { name: "replylane_feeds_migrate", description: "Plan migration from X Communities to XChat groups and Custom Timelines." },
  { name: "replylane_export_markdown", description: "Export ReplyLane report as markdown." },
  { name: "replylane_export_json", description: "Export ReplyLane report as JSON." },
  { name: "tradia_health", description: "Check Tradia API health and available endpoints." },
  { name: "tradia_agent_plan", description: "Generate a personalized trading plan based on goals, risk tolerance, and market preferences. Not financial advice." },
  { name: "tradia_market_analyze", description: "Analyze a market or asset for trading opportunities using technical indicators. Not financial advice." },
  { name: "tradia_signal_evaluate", description: "Evaluate a trading signal or setup for quality and risk. Not financial advice." },
  { name: "tradia_risk_check", description: "Check trade risk parameters including R-multiple, risk percentage, and position sizing. Not financial advice." },
  { name: "tradia_trade_propose", description: "Propose a trade setup with entry, stop loss, take profit, and rationale. Not financial advice." },
  { name: "tradia_trade_journal", description: "Journal a trade with entry/exit details, P&L, and reflections. Not financial advice." },
  { name: "tradia_portfolio_report", description: "Generate a portfolio health report with allocation analysis and diversification scoring. Not financial advice." },
  { name: "tradia_performance_analyze", description: "Analyze trading performance including win rate, profit factor, drawdown, and Sharpe-like scoring. Not financial advice." },
  { name: "tradia_public_update_generate", description: "Generate a public trading update/loss-porn post for social platforms based on recent trades. Not financial advice." },
  { name: "tradia_backtest_simulate", description: "Simulate a trading strategy backtest over historical data. Not financial advice." },
  { name: "tradia_accountability_card", description: "Generate an accountability card reviewing trade discipline, mistakes, and lessons. Not financial advice." },
  { name: "tradia_export_markdown", description: "Export Tradia trade data as a formatted markdown report." },
  { name: "tradia_export_json", description: "Export Tradia trade data as JSON." },
  { name: "codra_review", description: "Review code for anti-patterns, raw loops, off-by-one errors, and suggest modern alternatives." },
  { name: "doculane_extract", description: "Extract structured data from documents (PDF, images, scans) using natural language prompts." }
]

async function routeHandler(method, rawPath, headers, body, queryParams) {
  const path = normalizePath(rawPath)
  const requestId = makeRequestId()
  const origin = headers['origin'] || headers['Origin'] || ''
  const query = queryParams || {}

  function r(status, data, extra) { return withCors(respond(status, data, extra), origin) }
  function e(status, code, msg) { return r(status, fail(code, msg, requestId)) }
  async function requireAuth() {
    const user = await authenticate(headers)
    if (!user) return null
    return user
  }

  if (method === 'OPTIONS') {
    if (path === '/mcp') {
      return respond(204, '', { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, X-Api-Key, X-Talocode-Api-Key, Content-Type' })
    }
    return withCors(respond(204, '', {}), origin)
  }

  // Health
  if ((method === 'GET' || method === 'HEAD') && /^\/(health|\/api\/v1\/health)?$/.test(path)) {
    return r(200, ok({ status: 'ok', service: 'stacklane-api', version: '0.6.0', timestamp: new Date().toISOString() }, requestId))
  }

  if (method === 'GET' && path === '/health/storage') {
    try {
      await ensurePostgres()
      const result = await getPool().query('SELECT COUNT(*)::int AS users FROM stacklane.users')
      return r(200, ok({ status: 'ok', storage: 'postgres', ready: true, userCount: result.rows[0]?.users || 0 }, requestId))
    } catch (err) {
      return e(503, 'storage_unavailable', 'Postgres storage is not available.')
    }
  }

  // Telemetry ping (no auth)
  if (method === 'POST' && path === '/v1/telemetry/ping') {
    return r(200, ok({ status: 'ok', ts: new Date().toISOString() }, requestId))
  }

  // Pricing
  if (method === 'GET' && path === '/api/v1/cloud/pricing') {
    return r(200, ok({
      pricing: {
        tera_api: {
          'chat.completions': 3, 'writing.rewrite': 5, 'writing.draft': 10,
          'coding.explain': 10, 'coding.review': 20, 'coding.write': 20,
        },
        searchlane: {
          'searchlane.query': 5, 'searchlane.news': 8, 'searchlane.research': 30,
        },
        calclane: {
          'calclane.evaluate': 1, 'calclane.dispatch': 1,
        },
      },
    }, requestId))
  }

  // ─── Auth ────────────────────────────────────────────────────────

  if (method === 'POST' && path === '/auth/register') {
    const payload = jsonBody(body)
    if (!payload || !payload.email || !payload.password) {
      return e(400, 'invalid_request', 'email and password are required')
    }
    if (String(payload.password).length < 8) {
      return e(422, 'validation_error', 'Password must be at least 8 characters')
    }
    const email = String(payload.email).toLowerCase().trim()
    const db = await loadDb()
    if (db.users.find((u) => u.email === email)) {
      return e(409, 'email_taken', 'An account with this email already exists')
    }
    const now = new Date().toISOString()
    const user = {
      id: makeId('usr'),
      email,
      name: (payload.name && String(payload.name).trim()) || email.split('@')[0] || 'Talocode User',
      passwordHash: hashPassword(String(payload.password)),
      status: 'active',
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    }
    db.users.push(user)
    db.profiles[user.id] = { purchased_credits_balance: 0, free_plan_credits_used: 0 }
    const token = makeToken()
    db.sessions[hashApiKey(token)] = { userId: user.id, createdAt: now }
    await saveDb(db)
    return withCors({
      statusCode: 201,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `sl_session=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=604800`,
        ...corsHeaders(origin),
      },
      body: JSON.stringify(ok(toSafeUser(user), requestId)),
    }, origin)
  }

  if (method === 'POST' && path === '/auth/login') {
    const payload = jsonBody(body)
    if (!payload || !payload.email || !payload.password) return e(400, 'invalid_request', 'email and password are required')
    const db = await loadDb()
    const email = String(payload.email).toLowerCase().trim()
    const user = db.users.find(u => u.email === email || u.email === payload.email)
    if (!user || !verifyPassword(String(payload.password), user.passwordHash)) return e(401, 'invalid_credentials', 'Invalid email or password')
    const token = makeToken()
    db.sessions[hashApiKey(token)] = { userId: user.id, createdAt: new Date().toISOString() }
    user.lastLoginAt = new Date().toISOString()
    await saveDb(db)
    return withCors({
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `sl_session=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=604800`,
        ...corsHeaders(origin),
      },
      body: JSON.stringify(ok(toSafeUser(user), requestId)),
    }, origin)
  }

  if (method === 'POST' && path === '/auth/logout') {
    const token = extractSession(headers)
    if (token) { const db = await loadDb(); delete db.sessions[hashApiKey(token)]; await saveDb(db) }
    return withCors({
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'sl_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0',
        ...corsHeaders(origin),
      },
      body: JSON.stringify(ok({ ok: true }, requestId)),
    }, origin)
  }

  if (method === 'GET' && path === '/auth/me') {
    const user = await requireAuth()
    if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    return r(200, ok(toSafeUser(user), requestId))
  }

  // Admin: permanently delete a user + owned cloud data (for support / re-signup)
  // Header: X-Admin-Secret: $STACKLANE_ADMIN_SECRET (or body.secret)
  if (method === 'POST' && path === '/auth/admin/delete-user') {
    const payload = jsonBody(body) || {}
    const secret = headers['x-admin-secret'] || headers['X-Admin-Secret'] || payload.secret
    const expected = process.env.STACKLANE_ADMIN_SECRET || process.env.ADMIN_SECRET
    if (!secret || secret !== expected) return e(403, 'forbidden', 'Invalid admin secret')
    const email = String(payload.email || '').toLowerCase().trim()
    if (!email) return e(400, 'invalid_request', 'email is required')
    const db = await loadDb()
    const matched = (db.users || []).filter((u) => (u.email || '').toLowerCase() === email)
    if (!matched.length) {
      return r(200, ok({ deleted: false, reason: 'not_found', email }, requestId))
    }
    const userIds = new Set(matched.map((u) => u.id))
    db.users = (db.users || []).filter((u) => !userIds.has(u.id))
    if (db.sessions) {
      for (const [tok, sess] of Object.entries(db.sessions)) {
        if (userIds.has(sess.userId)) delete db.sessions[tok]
      }
    }
    if (db.profiles) {
      for (const id of userIds) delete db.profiles[id]
    }
    const projectIds = new Set(
      (db.cloud_projects || []).filter((p) => userIds.has(p.ownerId)).map((p) => p.id),
    )
    db.cloud_projects = (db.cloud_projects || []).filter((p) => !projectIds.has(p.id))
    if (db.cloud_api_keys) {
      for (const k of db.cloud_api_keys) {
        if (projectIds.has(k.projectId) && k.keyHash && db.api_keys) delete db.api_keys[`sha256:${k.keyHash}`]
      }
      db.cloud_api_keys = db.cloud_api_keys.filter((k) => !projectIds.has(k.projectId))
    }
    if (db.wallets) {
      for (const pid of projectIds) {
        const w = db.wallets[pid]
        if (w && db.transactions) {
          db.transactions = db.transactions.filter((t) => t.walletId !== w.id)
        }
        delete db.wallets[pid]
      }
    }
    if (db.topups) db.topups = db.topups.filter((t) => !projectIds.has(t.projectId))
    if (db.usage_events) db.usage_events = db.usage_events.filter((ev) => !userIds.has(ev.user_id))
    // clear module cache so subsequent requests reload
    dbCache = db
    await saveDb(db)
    return r(200, ok({
      deleted: true,
      email,
      userIds: [...userIds],
      projectsRemoved: [...projectIds],
    }, requestId))
  }

  // ─── Regions ─────────────────────────────────────────────────────

  if (method === 'GET' && path === '/regions') {
    const db = await loadDb()
    return r(200, ok(db.regions, requestId))
  }

  // ─── Organizations ───────────────────────────────────────────────

  const orgMatch = path.match(/^\/organizations(?:\/([^/]+))?(?:\/([^/]+))?$/)
  const orgSlug = orgMatch ? orgMatch[1] : null
  const orgSub = orgMatch ? orgMatch[2] : null

  if (path === '/organizations' && method === 'GET') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    return r(200, ok(db.organizations, requestId))
  }

  if (path === '/organizations' && method === 'POST') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.name) return e(400, 'invalid_request', 'name is required')
    const db = await loadDb()
    const org = { id: makeId('org'), name: payload.name, slug: payload.slug || slugify(payload.name), status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    db.organizations.push(org)
    await saveDb(db)
    return r(200, ok(org, requestId))
  }

  // ─── Projects ────────────────────────────────────────────────────

  const projMatch = path.match(/^\/projects(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/)
  const projSlug = projMatch ? projMatch[1] : null
  const projRes = projMatch ? projMatch[2] : null
  const projId3 = projMatch ? projMatch[3] : null
  const projId4 = projMatch ? projMatch[4] : null

  if (path === '/projects' && method === 'GET') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const owned = (db.cloud_projects || []).filter((p) => p.ownerId === user.id)
    const projects = owned.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      ownerId: p.ownerId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      status: 'active',
      description: '',
      organizationId: 'org-talocode',
    }))
    return r(200, ok(projects.length ? projects : db.projects, requestId))
  }

  if (path === '/projects' && method === 'POST') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.name) return e(400, 'invalid_request', 'name is required')
    const db = await loadDb()
    const now = new Date().toISOString()
    const proj = {
      id: makeId('proj'), name: payload.name, slug: payload.slug || slugify(payload.name),
      status: payload.status || 'provisioning', region: payload.region || 'us-east',
      description: payload.description || '', organizationId: payload.organizationId || 'org-talocode',
      createdAt: now, updatedAt: now,
    }
    db.projects.push(proj)
    db.wallets[proj.id] = { id: makeId('wallet'), projectId: proj.id, balance: 0, lifetimeCredits: 0, lifetimeSpend: 0, freeCreditsGranted: false, createdAt: now, updatedAt: now }
    await saveDb(db)
    return r(200, ok(proj, requestId))
  }

  // GET /projects/:slug
  if (projSlug && !projRes && method === 'GET' && path === `/projects/${projSlug}`) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const cloud = (db.cloud_projects || []).find(p => p.id === projSlug || p.slug === projSlug)
    const proj = cloud ? { id: cloud.id, name: cloud.name, slug: cloud.slug, createdAt: cloud.createdAt, updatedAt: cloud.updatedAt, status: 'active', description: '', organizationId: 'org-talocode', ownerId: cloud.ownerId } : db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const org = db.organizations.find(o => o.id === proj.organizationId)
    const envs = db.environments.filter(e => e.projectId === proj.id)
    return r(200, ok({ ...proj, organization: org || null, environments: envs, capabilities: { canManageProvisioning: true, canManageApiKeys: true, canManageEnvironments: true, canUpdateProject: true } }, requestId))
  }

  // PATCH /projects/:slug
  if (projSlug && !projRes && method === 'PATCH' && path === `/projects/${projSlug}`) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    if (payload.name) proj.name = payload.name
    if (payload.status) proj.status = payload.status
    if (payload.description !== undefined) proj.description = payload.description
    proj.updatedAt = new Date().toISOString()
    await saveDb(db)
    return r(200, ok(proj, requestId))
  }

  // POST /projects/:slug/provision
  if (projRes === 'provision' && method === 'POST' && path === `/projects/${projSlug}/provision`) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const now = new Date().toISOString()
    const task = {
      id: makeId('task'), projectId: proj.id, environmentId: null, region: db.regions.find(r => r.code === proj.region) || null,
      status: 'running', source: 'manual', requestedByUserId: user.id, currentAttempt: 1, maxAttempts: 3,
      lastError: null, diagnostics: {}, createdAt: now, updatedAt: now, startedAt: now, completedAt: null,
      nextRunAt: now, claimedBy: null, claimedAt: null, claimExpiresAt: null, lastHeartbeatAt: null, lastTransitionAt: now,
    }
    db.provisioning_tasks.push(task)
    proj.status = 'provisioning'
    await saveDb(db)
    return r(200, ok(task, requestId))
  }

  // GET /projects/:slug/provisioning
  if (projRes === 'provisioning' && !projId3 && method === 'GET' && path === `/projects/${projSlug}/provisioning`) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const task = db.provisioning_tasks.filter(t => t.projectId === proj.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null
    const attempts = db.provisioning_attempts.filter(a => a.taskId === task?.id)
    const runtimeBinding = task?.status === 'ready' ? { id: makeId('bind'), projectId: proj.id, regionId: proj.region, databaseRef: null, storageRef: null, authNamespaceRef: null, functionsNamespaceRef: null, status: 'ready', diagnostics: {}, createdAt: proj.createdAt, updatedAt: proj.updatedAt } : null
    return r(200, ok({ task, attempts: attempts || [], runtimeBinding, capabilities: { canManageProvisioning: true, canManageApiKeys: true, canManageEnvironments: true, canUpdateProject: true } }, requestId))
  }

  // GET /projects/:slug/provisioning/tasks
  if (projRes === 'provisioning' && projId3 === 'tasks' && !projId4 && method === 'GET') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    return r(200, ok(db.provisioning_tasks.filter(t => t.projectId === proj.id), requestId))
  }

  // POST /projects/:slug/provisioning/retry
  if (projRes === 'provisioning' && projId3 === 'retry' && !projId4 && method === 'POST') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const now = new Date().toISOString()
    const task = {
      id: makeId('task'), projectId: proj.id, environmentId: null, region: db.regions.find(r => r.code === proj.region),
      status: 'running', source: 'retry', requestedByUserId: user.id, currentAttempt: 1, maxAttempts: 3,
      lastError: null, diagnostics: {}, createdAt: now, updatedAt: now, startedAt: now, completedAt: null,
      nextRunAt: now, claimedBy: null, claimedAt: null, claimExpiresAt: null, lastHeartbeatAt: null, lastTransitionAt: now,
    }
    db.provisioning_tasks.push(task)
    proj.status = 'provisioning'
    await saveDb(db)
    return r(200, ok(task, requestId))
  }

  // GET /projects/:slug/events
  if (projRes === 'events' && !projId3 && method === 'GET' && path === `/projects/${projSlug}/events`) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    return r(200, ok(db.audit_events.filter(e => e.projectId === proj.id), requestId))
  }

  // GET /projects/:slug/api-keys
  if (projRes === 'api-keys' && !projId3 && method === 'GET' && path === `/projects/${projSlug}/api-keys`) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    return r(200, ok(db.project_api_keys.filter(k => k.projectId === proj.id), requestId))
  }

  // POST /projects/:slug/api-keys
  if (projRes === 'api-keys' && !projId3 && method === 'POST' && path === `/projects/${projSlug}/api-keys`) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.name) return e(400, 'invalid_request', 'name is required')
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const now = new Date().toISOString()
    const keyObj = {
      id: makeId('key'), projectId: proj.id, organizationId: proj.organizationId,
      name: payload.name, prefix: 'sk_lane_dev_', status: 'active',
      revokedAt: null, lastUsedAt: null, createdAt: now, updatedAt: now,
    }
    const secret = `sk_lane_dev_${makeToken()}`
    db.project_api_keys.push(keyObj)
    await saveDb(db)
    return r(200, ok({ key: keyObj, secret }, requestId))
  }

  // POST /projects/:slug/api-keys/:keyId/revoke
  if (projRes === 'api-keys' && projId3 && projId4 === 'revoke' && method === 'POST') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const key = db.project_api_keys.find(k => k.id === projId3 && k.projectId === proj.id)
    if (!key) return e(404, 'not_found', 'API key not found')
    key.status = 'revoked'
    key.revokedAt = new Date().toISOString()
    await saveDb(db)
    return r(200, ok(key, requestId))
  }

  // GET /projects/:slug/environments
  if (projRes === 'environments' && !projId3 && method === 'GET' && path === `/projects/${projSlug}/environments`) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    return r(200, ok(db.environments.filter(e => e.projectId === proj.id), requestId))
  }

  // POST /projects/:slug/environments
  if (projRes === 'environments' && !projId3 && method === 'POST' && path === `/projects/${projSlug}/environments`) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.name) return e(400, 'invalid_request', 'name is required')
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const now = new Date().toISOString()
    const env = {
      id: makeId('env'), projectId: proj.id, name: payload.name, slug: payload.slug || slugify(payload.name),
      status: payload.status || 'ready', region: payload.region || proj.region,
      deploymentTarget: payload.deploymentTarget || 'africa-west1', createdAt: now, updatedAt: now,
    }
    db.environments.push(env)
    await saveDb(db)
    return r(200, ok(env, requestId))
  }

  // PATCH /projects/:slug/environments/:envId
  if (projRes === 'environments' && projId3 && !projId4 && method === 'PATCH') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    const db = await loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const env = db.environments.find(e => e.id === projId3 && e.projectId === proj.id)
    if (!env) return e(404, 'not_found', 'Environment not found')
    if (payload.status) env.status = payload.status
    if (payload.region) env.region = payload.region
    if (payload.deploymentTarget) env.deploymentTarget = payload.deploymentTarget
    env.updatedAt = new Date().toISOString()
    await saveDb(db)
    return r(200, ok(env, requestId))
  }

  // ─── Organization sub-resources ──────────────────────────────────

  // GET /organizations/:slug/projects
  if (orgSlug && orgSub === 'projects' && method === 'GET') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const org = db.organizations.find(o => o.id === orgSlug || o.slug === orgSlug)
    if (!org) return e(404, 'not_found', 'Organization not found')
    return r(200, ok(db.projects.filter(p => p.organizationId === org.id), requestId))
  }

  // GET /organizations/:slug/operations
  if (orgSlug && orgSub === 'operations' && method === 'GET') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = await loadDb()
    const org = db.organizations.find(o => o.id === orgSlug || o.slug === orgSlug)
    if (!org) return e(404, 'not_found', 'Organization not found')
    const projects = db.projects.filter(p => p.organizationId === org.id)
    const rows = projects.map(p => {
      const task = db.provisioning_tasks.filter(t => t.projectId === p.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null
      return { project: { ...p, organization: org, environments: db.environments.filter(e => e.projectId === p.id), capabilities: { canManageProvisioning: true, canManageApiKeys: true, canManageEnvironments: true, canUpdateProject: true } }, provisioning: task, capabilities: { canManageProvisioning: true, canManageApiKeys: true, canManageEnvironments: true, canUpdateProject: true } }
    })
    return r(200, ok(rows, requestId))
  }

  // ─── Talocode Cloud projects (dashboard) ─────────────────────────

  function ensureCloudShape(db) {
    if (!db.cloud_projects) db.cloud_projects = []
    if (!db.cloud_api_keys) db.cloud_api_keys = []
    if (!db.topups) db.topups = []
    return db
  }

  // GET /api/v1/cloud/projects
  if (method === 'GET' && path === '/api/v1/cloud/projects') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = ensureCloudShape(await loadDb())
    const list = db.cloud_projects
      .filter((p) => p.ownerId === user.id)
      .map((p) => {
        const w = db.wallets[p.id]
        return {
          id: p.id,
          ownerId: p.ownerId,
          name: p.name,
          slug: p.slug,
          balanceCredits: w?.balance ?? 0,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }
      })
    return r(200, ok(list, requestId))
  }

  // POST /api/v1/cloud/projects
  if (method === 'POST' && path === '/api/v1/cloud/projects') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.name) return e(400, 'invalid_request', 'name is required')
    const db = ensureCloudShape(await loadDb())
    const now = new Date().toISOString()
    const slug = payload.slug || slugify(payload.name)
    if (db.cloud_projects.some((p) => p.slug === slug)) {
      return e(409, 'duplicate_slug', 'A project with this slug already exists')
    }
    const project = {
      id: makeId('cprj'),
      ownerId: user.id,
      name: String(payload.name).trim(),
      slug,
      createdAt: now,
      updatedAt: now,
    }
    db.cloud_projects.push(project)
    // Free starting credits (100)
    const freeCredits = 100
    db.wallets[project.id] = {
      id: makeId('cwal'),
      projectId: project.id,
      balance: freeCredits,
      balanceCredits: freeCredits,
      lifetimeCredits: freeCredits,
      lifetimeSpend: 0,
      freeCreditsGranted: true,
      createdAt: now,
      updatedAt: now,
    }
    db.transactions.push({
      id: makeId('ctxn'),
      walletId: db.wallets[project.id].id,
      type: 'grant',
      creditsDelta: freeCredits,
      balanceAfter: freeCredits,
      product: null,
      action: null,
      reference: 'free_credits_grant',
      metadata: { reason: 'new_project_free_credits' },
      createdAt: now,
    })
    await saveDb(db)
    return r(201, ok({
      id: project.id,
      ownerId: project.ownerId,
      name: project.name,
      slug: project.slug,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    }, requestId))
  }

  // Cloud project nested routes: /api/v1/cloud/projects/:id/...
  const cloudProjMatch = path.match(/^\/api\/v1\/cloud\/projects\/([^/]+)(?:\/(.+))?$/)
  if (cloudProjMatch) {
    const projectRef = decodeURIComponent(cloudProjMatch[1])
    const rest = cloudProjMatch[2] || ''
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = ensureCloudShape(await loadDb())
    const project = db.cloud_projects.find((p) => p.id === projectRef || p.slug === projectRef)
    if (!project) return e(404, 'not_found', 'Cloud project not found')
    if (project.ownerId !== user.id) return e(403, 'forbidden', 'Access denied')

    // GET /wallet
    if (rest === 'wallet' && method === 'GET') {
      let wallet = db.wallets[project.id]
      if (!wallet) {
        const now = new Date().toISOString()
        wallet = {
          id: makeId('cwal'), projectId: project.id, balance: 0, balanceCredits: 0,
          lifetimeCredits: 0, lifetimeSpend: 0, freeCreditsGranted: false, createdAt: now, updatedAt: now,
        }
        db.wallets[project.id] = wallet
        await saveDb(db)
      }
      const txs = db.transactions
        .filter((t) => t.walletId === wallet.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50)
        .map((t) => ({
          id: t.id,
          walletId: t.walletId,
          type: t.type,
          creditsDelta: t.creditsDelta,
          balanceAfter: t.balanceAfter,
          reference: t.reference,
          metadata: t.metadata,
          createdAt: t.createdAt,
        }))
      return r(200, ok({
        wallet: {
          id: wallet.id,
          projectId: project.id,
          balanceCredits: wallet.balance ?? wallet.balanceCredits ?? 0,
          freeCreditsGranted: !!wallet.freeCreditsGranted,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        },
        transactions: txs,
      }, requestId))
    }

    // GET|POST /api-keys
    if (rest === 'api-keys' && method === 'GET') {
      const keys = db.cloud_api_keys.filter((k) => k.projectId === project.id)
      return r(200, ok(keys.map((k) => ({
        id: k.id,
        projectId: k.projectId,
        name: k.name,
        prefix: k.prefix,
        mode: k.mode,
        status: k.status,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
        updatedAt: k.updatedAt,
      })), requestId))
    }

    if (rest === 'api-keys' && method === 'POST') {
      const payload = jsonBody(body) || {}
      const name = (payload.name && String(payload.name).trim()) || 'API Key'
      const mode = payload.mode === 'dev' ? 'dev' : 'live'
      const now = new Date().toISOString()
      const prefix = `tk_${mode}_${randomBytes(3).toString('hex')}`
      const secret = randomBytes(24).toString('hex')
      const rawKey = `${prefix}.${secret}`
      const key = {
        id: makeId('ckey'),
        projectId: project.id,
        name,
        prefix,
        mode,
        status: 'active',
        keyHash: hashApiKey(rawKey),
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      db.cloud_api_keys.push(key)
      db.api_keys[`sha256:${key.keyHash}`] = user.id
      await saveDb(db)
      return r(201, ok({
        key: {
          id: key.id,
          projectId: key.projectId,
          name: key.name,
          prefix: key.prefix,
          mode: key.mode,
          status: key.status,
          lastUsedAt: null,
          createdAt: key.createdAt,
          updatedAt: key.updatedAt,
        },
        rawKey,
      }, requestId))
    }

    // GET usage
    if (rest === 'usage' && method === 'GET') {
      const events = db.usage_events
        .filter((ev) => ev.project_id === project.id || ev.user_id === user.id)
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .slice(0, 100)
        .map((ev) => ({
          id: ev.id || makeId('ue'),
          projectId: project.id,
          apiKeyId: ev.api_key_id || null,
          product: ev.product,
          action: ev.action,
          credits: ev.credits,
          status: ev.status || 'charged',
          createdAt: ev.created_at,
        }))
      return r(200, ok(events, requestId))
    }

    if (rest === 'usage/summary' && method === 'GET') {
      const events = db.usage_events.filter((ev) => ev.project_id === project.id || ev.user_id === user.id)
      const map = {}
      for (const ev of events) {
        const k = `${ev.product}|${ev.action}`
        if (!map[k]) map[k] = { product: ev.product, action: ev.action, total_credits: 0, event_count: 0 }
        map[k].total_credits += ev.credits || 0
        map[k].event_count += 1
      }
      return r(200, ok(Object.values(map), requestId))
    }

    // GET project
    if (!rest && method === 'GET') {
      const w = db.wallets[project.id]
      return r(200, ok({
        id: project.id,
        ownerId: project.ownerId,
        name: project.name,
        slug: project.slug,
        balanceCredits: w?.balance ?? 0,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      }, requestId))
    }
  }

  // POST /api/v1/cloud/api-keys/:id/revoke
  if (method === 'POST' && path.startsWith('/api/v1/cloud/api-keys/') && path.endsWith('/revoke')) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const keyId = decodeURIComponent(path.replace('/api/v1/cloud/api-keys/', '').replace('/revoke', ''))
    const db = ensureCloudShape(await loadDb())
    const key = db.cloud_api_keys.find((k) => k.id === keyId)
    if (!key) return e(404, 'not_found', 'API key not found')
    const project = db.cloud_projects.find((p) => p.id === key.projectId)
    if (!project || project.ownerId !== user.id) return e(403, 'forbidden', 'Access denied')
    key.status = 'revoked'
    key.updatedAt = new Date().toISOString()
    if (key.keyHash) delete db.api_keys[`sha256:${key.keyHash}`]
    await saveDb(db)
    return r(200, ok({
      key: {
        id: key.id, projectId: key.projectId, name: key.name, prefix: key.prefix,
        mode: key.mode, status: key.status, lastUsedAt: key.lastUsedAt,
        createdAt: key.createdAt, updatedAt: key.updatedAt,
      },
    }, requestId))
  }

  // ─── Cloud Billing ───────────────────────────────────────────────

  // GET /api/v1/cloud/billing/wallet
  if (method === 'GET' && path.startsWith('/api/v1/cloud/billing/wallet')) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const projectId = query.projectId
    if (!projectId) return e(400, 'invalid_request', 'projectId is required')
    const db = ensureCloudShape(await loadDb())
    const project = db.cloud_projects?.find((p) => p.id === projectId)
    if (project && project.ownerId !== user.id) return e(403, 'forbidden', 'Access denied')
    let wallet = null
    try {
      wallet = await getTcodeStore().readWallet(projectId)
    } catch {
      wallet = null
    }
    if (!wallet) wallet = db.wallets[projectId]
    if (!wallet) return e(404, 'not_found', 'Wallet not found')
    return r(200, ok({
      id: wallet.id,
      projectId,
      balance: wallet.balance ?? 0,
      balanceCredits: wallet.balance ?? 0,
      lifetimeCredits: wallet.lifetimeCredits ?? 0,
      lifetimeSpend: wallet.lifetimeSpend ?? 0,
      freeCreditsGranted: !!wallet.freeCreditsGranted,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    }, requestId))
  }

  // GET /api/v1/cloud/billing/transactions
  if (method === 'GET' && path.startsWith('/api/v1/cloud/billing/transactions')) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const projectId = query.projectId; const limit = Number(query.limit) || 50
    if (!projectId) return e(400, 'invalid_request', 'projectId is required')
    const db = await loadDb()
    const project = db.cloud_projects?.find((p) => p.id === projectId)
    if (project && project.ownerId !== user.id) return e(403, 'forbidden', 'Access denied')
    try {
      const rows = await getTcodeStore().listTransactions(projectId, limit)
      return r(200, ok(rows, requestId))
    } catch {
      return r(200, ok(db.transactions.filter(t => t.walletId === db.wallets[projectId]?.id).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, limit), requestId))
    }
  }

  // GET /api/v1/cloud/usage/events
  if (method === 'GET' && path.startsWith('/api/v1/cloud/usage/events')) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const projectId = query.projectId; const limit = Number(query.limit) || 50
    if (!projectId) return e(400, 'invalid_request', 'projectId is required')
    const db = await loadDb()
    return r(200, ok(db.usage_events.filter(e => e.user_id === user.id).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, limit), requestId))
  }

  // POST /api/v1/cloud/billing/topup — Lemon Squeezy when configured
  if (method === 'POST' && path === '/api/v1/cloud/billing/topup') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.projectId) return e(400, 'invalid_request', 'projectId is required')
    const rawAmount = Number(payload.amount ?? payload.amountUsd ?? 0)
    // amount >= 100 treated as credits
    const credits = rawAmount >= 100 ? Math.floor(rawAmount) : Math.floor(rawAmount * 100)
    const amountUsd = credits / 100
    if (!Number.isFinite(credits) || credits < 500) {
      return e(422, 'minimum_topup', 'Minimum top-up is 500 credits ($5.00)')
    }
    const db = ensureCloudShape(await loadDb())
    const project = db.cloud_projects.find((p) => p.id === payload.projectId)
    if (project && project.ownerId !== user.id) return e(403, 'forbidden', 'Access denied')
    let wallet = db.wallets[payload.projectId]
    if (!wallet) return e(404, 'not_found', 'Wallet not found')
    const topupId = makeId('ctup')
    const now = new Date().toISOString()
    db.topups.push({
      id: topupId, projectId: payload.projectId, credits, amountUsd,
      status: 'pending', provider: 'lemonsqueezy', createdAt: now,
    })
    await saveDb(db)

    let checkoutUrl = null
    const lsKey = process.env.LEMONSQUEEZY_API_KEY
    const lsStore = process.env.LEMONSQUEEZY_STORE_ID
    const lsVariant = process.env.LEMONSQUEEZY_VARIANT_ID
    let variantMap = {}
    try {
      if (process.env.LEMONSQUEEZY_VARIANT_MAP) variantMap = JSON.parse(process.env.LEMONSQUEEZY_VARIANT_MAP)
    } catch { /* ignore */ }
    const variantId = variantMap[String(credits)] || lsVariant

    if (lsKey && lsStore && variantId) {
      try {
        const successUrl = 'https://dashboard.talocode.site/billing?topup=success'
        const attributes = {
          checkout_options: { embed: false, media: false, logo: true },
          checkout_data: {
            email: user.email,
            custom: {
              topup_id: topupId,
              project_id: payload.projectId,
              credits: String(credits),
              amount_usd: String(amountUsd),
              provider: 'lemonsqueezy',
            },
          },
          product_options: {
            name: `Talocode Cloud — ${credits.toLocaleString()} credits`,
            description: `${credits.toLocaleString()} prepaid credits (1 credit = $0.01).`,
            redirect_url: successUrl,
            receipt_button_text: 'Return to dashboard',
            receipt_link_url: successUrl,
          },
          test_mode: process.env.LEMONSQUEEZY_TEST_MODE === 'true',
        }
        if (!variantMap[String(credits)]) {
          attributes.custom_price = Math.round(amountUsd * 100)
        }
        const lsRes = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.api+json',
            'Content-Type': 'application/vnd.api+json',
            Authorization: `Bearer ${lsKey}`,
          },
          body: JSON.stringify({
            data: {
              type: 'checkouts',
              attributes,
              relationships: {
                store: { data: { type: 'stores', id: String(lsStore) } },
                variant: { data: { type: 'variants', id: String(variantId) } },
              },
            },
          }),
        })
        const lsJson = await lsRes.json().catch(() => ({}))
        checkoutUrl = lsJson?.data?.attributes?.url || null
        if (!lsRes.ok) {
          const detail = lsJson?.errors?.map((x) => x.detail || x.title).filter(Boolean).join('; ')
          return e(502, 'lemonsqueezy_checkout_failed', detail || 'Lemon Squeezy checkout failed')
        }
      } catch (err) {
        return e(502, 'lemonsqueezy_checkout_failed', err.message)
      }
    }

    return r(201, ok({
      topup: { id: topupId, walletId: wallet.id, amount: credits, status: 'pending' },
      checkoutUrl,
      lemonsqueezy: checkoutUrl ? { checkoutUrl } : null,
      stripePublishableKey: null,
      clientSecret: null,
      creditsPerDollar: 100,
    }, requestId))
  }

  // Lemon Squeezy webhook
  if (method === 'POST' && path === '/api/v1/cloud/billing/lemonsqueezy/webhook') {
    const raw = typeof body === 'string' ? body : JSON.stringify(body || {})
    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET
    const sig = headers['x-signature'] || headers['X-Signature']
    if (!secret) {
      return e(503, 'webhook_not_configured', 'Lemon Squeezy webhook secret is not configured.')
    }
    if (!sig) return e(400, 'missing_signature', 'X-Signature header is required.')
    const digest = createHmac('sha256', secret).update(raw).digest('hex')
    try {
      const a = Buffer.from(digest)
      const b = Buffer.from(String(sig))
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return e(400, 'invalid_signature', 'Invalid Lemon Squeezy webhook signature')
      }
    } catch {
      return e(400, 'invalid_signature', 'Invalid Lemon Squeezy webhook signature')
    }
    let event
    try { event = typeof body === 'string' ? JSON.parse(body) : body } catch {
      return e(400, 'invalid_payload', 'Invalid JSON')
    }
    const name = event?.meta?.event_name || ''
    if (!['order_created', 'order_paid', 'subscription_payment_success'].includes(name)) {
      return r(200, ok({ ignored: true }, requestId))
    }
    const custom = event?.meta?.custom_data || {}
    const topupId = custom.topup_id || custom.topupId
    if (!topupId) return r(200, ok({ ignored: true, reason: 'no_topup_id' }, requestId))
    const db = ensureCloudShape(await loadDb())
    const topup = db.topups.find((t) => t.id === topupId)
    const alreadyCredited = db.transactions.some((tx) => tx.type === 'topup' && tx.reference === topupId)
    if (!topup || topup.status === 'succeeded' || alreadyCredited) {
      return r(200, ok({ already: true }, requestId))
    }
    const wallet = db.wallets[topup.projectId]
    if (!wallet) return e(404, 'not_found', 'Wallet not found')
    const now = new Date().toISOString()
    wallet.balance = (wallet.balance || 0) + topup.credits
    wallet.lifetimeCredits = (wallet.lifetimeCredits || 0) + topup.credits
    wallet.updatedAt = now
    topup.status = 'succeeded'
    db.transactions.push({
      id: makeId('ctxn'),
      walletId: wallet.id,
      type: 'topup',
      creditsDelta: topup.credits,
      balanceAfter: wallet.balance,
      product: null,
      action: 'topup',
      reference: topupId,
      metadata: { provider: 'lemonsqueezy' },
      createdAt: now,
    })
    await saveDb(db)
    return r(200, ok({ credited: true, topupId, credits: topup.credits }, requestId))
  }

  // POST /api/v1/cloud/billing/topup/confirm
  if (method === 'POST' && path === '/api/v1/cloud/billing/topup/confirm') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    if (process.env.NODE_ENV === 'production' && process.env.TALOCODE_ALLOW_MANUAL_TOPUPS !== 'true') {
      return e(403, 'manual_disabled', 'Use Lemon Squeezy checkout; wallet is credited via webhook.')
    }
    const payload = jsonBody(body)
    if (!payload || !payload.projectId) return e(400, 'invalid_request', 'projectId is required')
    const db = await loadDb()
    const wallet = db.wallets[payload.projectId]
    if (!wallet) return e(404, 'not_found', 'Wallet not found')
    const now = new Date().toISOString()
    wallet.balance += payload.amount || 100
    wallet.lifetimeCredits += payload.amount || 100
    wallet.updatedAt = now
    db.transactions.push({
      id: makeId('txn'), walletId: wallet.id, type: 'topup', creditsDelta: payload.amount || 100,
      balanceAfter: wallet.balance, product: null, action: 'topup', reference: payload.topupId || null,
      metadata: null, createdAt: now,
    })
    await saveDb(db)
    return r(200, ok({
      topup: { id: payload.topupId || makeId('topup'), walletId: wallet.id, amount: payload.amount || 100, status: 'completed' },
      wallet,
    }, requestId))
  }

  // ─── $TCODE hold-to-earn (signed link + on-chain holdings + monthly claim)
  async function requireOwnedCloudProject(projectId) {
    if (!projectId) return { error: e(400, 'invalid_request', 'projectId is required') }
    const db = ensureCloudShape(await loadDb())
    const project = db.cloud_projects.find((p) => p.id === projectId)
    if (!project) return { error: e(404, 'not_found', 'Project not found') }
    return { db, project }
  }

  if (method === 'GET' && path === '/api/v1/cloud/tcode') {
    return r(200, { ok: true, request_id: requestId, data: tcodePublicConfig() }, requestId)
  }

  if (method === 'POST' && path === '/api/v1/cloud/tcode/challenge') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body) || {}
    const owned = await requireOwnedCloudProject(payload.projectId)
    if (owned.error) return owned.error
    if (owned.project.ownerId !== user.id) return e(403, 'forbidden', 'Access denied')
    try {
      const challenge = await getTcodeStore().createChallenge({ userId: user.id, projectId: payload.projectId })
      return r(200, ok(challenge, requestId))
    } catch (error) {
      return tcodeFail(error, e, requestId)
    }
  }

  if (method === 'POST' && path === '/api/v1/cloud/tcode/link') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.projectId || !payload.walletAddress || !payload.signature || !payload.nonce) {
      return e(400, 'invalid_request', 'projectId, walletAddress, signature, and nonce are required')
    }
    const owned = await requireOwnedCloudProject(payload.projectId)
    if (owned.error) return owned.error
    if (owned.project.ownerId !== user.id) return e(403, 'forbidden', 'Access denied')
    try {
      const linked = await getTcodeStore().linkWallet({
        userId: user.id,
        projectId: payload.projectId,
        walletAddress: String(payload.walletAddress).trim(),
        signature: String(payload.signature),
        nonce: String(payload.nonce),
      })
      return r(200, ok(linked, requestId))
    } catch (error) {
      return tcodeFail(error, e, requestId)
    }
  }

  if (method === 'GET' && path === '/api/v1/cloud/tcode/holdings') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const projectId = query.projectId
    const owned = await requireOwnedCloudProject(projectId)
    if (owned.error) return owned.error
    if (owned.project.ownerId !== user.id) return e(403, 'forbidden', 'Access denied')
    if (query.rawBalance != null) {
      return e(400, 'invalid_request', 'rawBalance is not accepted; holdings are read on-chain')
    }
    try {
      const holdings = await getTcodeStore().getHoldings(projectId)
      return r(200, ok(holdings, requestId))
    } catch (error) {
      return tcodeFail(error, e, requestId)
    }
  }

  if (method === 'POST' && path === '/api/v1/cloud/tcode/claim') {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.projectId) return e(400, 'invalid_request', 'projectId is required')
    if (payload.rawBalance != null || payload.redeemRaw != null || payload.airdrop != null) {
      return e(400, 'invalid_request', 'Client-supplied balances and airdrops are not accepted')
    }
    const owned = await requireOwnedCloudProject(payload.projectId)
    if (owned.error) return owned.error
    if (owned.project.ownerId !== user.id) return e(403, 'forbidden', 'Access denied')
    try {
      const result = await getTcodeStore().claim(payload.projectId)
      if (result.wallet) {
        syncCacheWallet(owned.db, result.wallet)
        if (Array.isArray(owned.db.transactions) && result.granted > 0) {
          owned.db.transactions.push({
            id: makeId('ctxn'),
            walletId: result.wallet.id,
            type: 'tcode_tier',
            creditsDelta: result.granted,
            balanceAfter: result.balance,
            product: null,
            action: 'tier',
            reference: `${result.period}:${result.tier?.key || 'tier'}`,
            metadata: { period: result.period, tier: result.tier?.key || null },
            createdAt: new Date().toISOString(),
          })
        }
      }
      return r(200, ok({
        granted: result.granted,
        alreadyClaimed: result.alreadyClaimed,
        reason: result.reason,
        period: result.period,
        tier: result.tier,
        tcodeTokens: result.tcodeTokens,
        balance: result.balance,
        wallet: result.wallet,
      }, requestId))
    } catch (error) {
      return tcodeFail(error, e, requestId)
    }
  }

  // ─── Usage charge (existing) ─────────────────────────────────────

  if (method === 'POST' && path === '/api/v1/cloud/usage/charge') {
    const apiKey = extractApiKey(headers)
    if (!apiKey) return e(401, 'missing_api_key', 'API key required')
    const payload = jsonBody(body)
    if (!payload || !payload.action || !payload.credits) return e(400, 'invalid_request', 'action and credits are required')
    try {
      const db = await loadDb()
      const userId = db.api_keys[`sha256:${hashApiKey(apiKey)}`]
      if (!userId) return e(401, 'invalid_api_key', 'Invalid or expired API key')
      const result = debitCredits(db, userId, payload.credits, payload.product || 'tera_api', payload.action, requestId)
      if (!result.ok) return e(402, 'insufficient_credits', `Insufficient credits. Required: ${result.required}, Balance: ${result.balance}`)
      db.usage_events.push({ user_id: userId, product: payload.product || 'tera_api', action: payload.action, credits: payload.credits, metadata: payload.metadata || {}, created_at: new Date().toISOString() })
      await saveDb(db)
      return r(200, ok({ ok: true, event: { credits: payload.credits, status: 'charged', product: payload.product, action: payload.action, balance: result.balance, requestId } }, requestId))
    } catch (err) {
      return e(503, 'billing_unavailable', err.message)
    }
  }

  // ─── Product API Routes ───────────────────────────────────────────

  // Helper: proxy POST to tera-api-v01
  async function teraProxy(subPath, body) {
    const url = `https://api.teraai.chat/v1/tera${subPath}`
    const apiKey = extractApiKey(headers)
    const hdrs = { 'Content-Type': 'application/json' }
    if (apiKey) hdrs['Authorization'] = `Bearer ${apiKey}`
    try {
      const resp = await fetch(url, { method: 'POST', headers: hdrs, body: body ? JSON.stringify(body) : null })
      const text = await resp.text()
      let data
      try { data = JSON.parse(text) } catch { data = text }
      return r(resp.status, data)
    } catch (err) {
      return e(503, 'upstream_unavailable', `Tera API upstream error: ${err.message}`)
    }
  }

  // ── Tera ──────────────────────────────────────────────────────────
  if (path.startsWith('/v1/tera/')) {
    const sub = path.replace('/v1/tera', '')
    const teraHealth = (method === 'GET' && (sub === '/health' || sub === '' || sub === '/'))
    if (teraHealth) {
      return r(200, ok({ status: 'ok', service: 'tera-api', version: '0.1.0', proxied: true, timestamp: new Date().toISOString() }, requestId))
    }
    const teraPricing = (method === 'GET' && sub === '/pricing')
    if (teraPricing) {
      return r(200, ok({ 'chat.completions': 3, 'writing.rewrite': 5, 'writing.draft': 10, 'coding.explain': 10, 'coding.review': 20, 'coding.write': 20 }, requestId))
    }
    const teraCaps = (method === 'GET' && sub === '/capabilities')
    if (teraCaps) {
      return r(200, ok({ capabilities: [{ id: 'chat.completions', name: 'Chat Completions', credits: 3 }, { id: 'writing.rewrite', name: 'Rewrite Text', credits: 5 }, { id: 'writing.draft', name: 'Draft Content', credits: 10 }, { id: 'coding.explain', name: 'Explain Code', credits: 10 }, { id: 'coding.review', name: 'Review Code', credits: 20 }, { id: 'coding.write', name: 'Write Code', credits: 20 }] }, requestId))
    }
    // POST endpoints → require TALOCODE_API_KEY + charge credits, then provider/proxy
    if (method === 'POST' && (sub === '/chat/completions' || sub === '/writing/rewrite' || sub === '/writing/draft' || sub === '/coding/explain' || sub === '/coding/review' || sub === '/coding/write')) {
      const teraCredits = sub === '/writing/draft' || sub === '/coding/explain' ? 10 : sub === '/coding/review' || sub === '/coding/write' ? 20 : sub === '/writing/rewrite' ? 5 : 3
      const action = sub.replace(/^\//, '')
      const charged = await chargeCredits(headers, 'tera_api', `tera.${action}`, teraCredits, requestId)
      if (!charged.ok) return e(charged.status, charged.code, charged.message)
      const payload = jsonBody(body)
      if (!payload) return e(400, 'invalid_request', 'Request body is required')
      if (sub === '/chat/completions') {
        if (!Array.isArray(payload.messages) || !payload.messages.length) {
          return e(400, 'invalid_request', 'messages array required')
        }
        try {
          const result = await providerChat(payload.messages, payload.model, payload)
          if (result?.result?.choices) {
            return r(200, {
              id: result.id || requestId,
              object: 'chat.completion',
              choices: result.result.choices,
              usage: result.result.usage,
              meta: { requestId, product: 'tera' },
            })
          }
          if (result?.choices) return r(200, { ...result, meta: { requestId, product: 'tera' } })
          return r(200, ok(result, requestId))
        } catch (err) {
          return e(502, 'provider_error', err.message)
        }
      }
      // Other tera actions: proxy upstream
      return await teraProxy(sub, payload)
    }
  }

  // ── WorkLane Socials ──────────────────────────────────────────────
  if (path.startsWith('/v1/worklane/')) {
    const sub = path.replace('/v1/worklane', '')
    const { SOCIALS_VERSION, pricing: socialsPricing, capabilities: socialsCaps, platformStatus, validateInput: validateSocials, publish: publishSocials } = await import('./worklane-socials-engine.mjs')
    if (method === 'GET' && (sub === '/socials/health' || sub === '/socials')) {
      return r(200, ok({ status: 'ok', service: 'worklane-socials', version: SOCIALS_VERSION, platforms: platformStatus(), pricing: socialsPricing, capabilities: socialsCaps, timestamp: new Date().toISOString() }, requestId))
    }
    if (method === 'GET' && sub === '/socials/pricing') {
      return r(200, ok(socialsPricing, requestId))
    }
    if (method === 'POST' && sub === '/socials/publish') {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      const payload = jsonBody(body)
      if (!payload) return e(400, 'invalid_request', 'Request body is required')
      const invalid = validateSocials(payload)
      if (invalid) return e(400, 'invalid_request', invalid)
      const results = await publishSocials(payload)
      const allFailed = results.length > 0 && results.every((x) => !x.ok)
      return r(allFailed ? 502 : 200, ok({ text: payload.text, mode: 'hosted', results }, requestId))
    }
  }

  // ── Skills ────────────────────────────────────────────────────────
  if (path.startsWith('/v1/skills/')) {
    const sub = path.replace('/v1/skills', '')
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ status: 'ok', service: 'skills-api', version: '0.1.0', timestamp: new Date().toISOString() }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') {
      return r(200, ok({ 'generate.github-profile': 80, 'generate.github-repo': 100, 'generate.docs': 100, 'generate.text': 40, 'export.cursor': 10, 'export.claude': 10 }, requestId))
    }
    if (method === 'POST' && (sub.startsWith('/generate/') || sub.startsWith('/export/'))) {
      const skillCredits = sub.includes('github-profile') ? 80 : sub.includes('github-repo') ? 100 : sub.includes('docs') ? 100 : sub.includes('text') ? 40 : sub.includes('export') ? 10 : 0
      const charged = await chargeCredits(headers, 'skills', `skills.${sub.replace(/^\//, '')}`, skillCredits, requestId)
      if (!charged.ok) return e(charged.status, charged.code, charged.message)
      const payload = jsonBody(body)
      if (!payload) return e(400, 'invalid_request', 'Request body is required')
      return r(200, ok({ status: 'generated', skill: { name: payload.input || 'custom-skill', format: sub.includes('export') ? sub.split('/').pop() : 'SKILL.md', compatibleWith: ['Cursor', 'Claude Code', 'OpenCode', 'Codra'], credits: skillCredits }, message: 'Skill generation is live when Talocode Cloud AI backends are connected. This endpoint is defined and ready.' }, requestId))
    }
  }

  // ── SearchLane (live engine) ──────────────────────────────────────
  if (path.startsWith('/v1/searchlane/')) {
    const sub = path.replace('/v1/searchlane', '')
    const {
      SEARCHLANE_VERSION,
      runSearchQuery,
      runSearchNews,
      runResearch,
      getSearchLanePricing,
      getSearchLaneCapabilities,
    } = await import('./searchlane-engine.mjs')

    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, {
        ok: true,
        service: 'searchlane',
        version: SEARCHLANE_VERSION,
        endpoints: getSearchLaneCapabilities().endpoints,
        meta: { requestId },
      })
    }
    if (method === 'GET' && sub === '/pricing') {
      return r(200, { ...getSearchLanePricing(), meta: { requestId } })
    }
    if (method === 'GET' && sub === '/capabilities') {
      return r(200, { ...getSearchLaneCapabilities(), meta: { requestId } })
    }
    if (method === 'POST' && (sub === '/query' || sub === '/news' || sub === '/research')) {
      const payload = jsonBody(body) || {}
      const query = typeof payload.query === 'string' ? payload.query.trim()
        : typeof payload.q === 'string' ? payload.q.trim() : ''
      if (!query) return e(422, 'validation_error', 'query is required')
      const limit = typeof payload.limit === 'number' ? payload.limit : undefined
      const creditMap = { '/query': 5, '/news': 8, '/research': 30 }
      const actionMap = { '/query': 'searchlane.query', '/news': 'searchlane.news', '/research': 'searchlane.research' }
      const credits = creditMap[sub]
      const action = actionMap[sub]
      // Charge credits via wallet (single source of truth)
      const charged = await chargeCredits(headers, 'searchlane', action, credits, requestId, { query, limit })
      if (!charged.ok) {
        return r(402, { ok: false, error: 'insufficient_credits', required: credits, available: charged.remaining, meta: { requestId } })
      }
      try {
        let result
        if (sub === '/query') result = await runSearchQuery(query, { limit })
        else if (sub === '/news') result = await runSearchNews(query, { limit })
        else result = await runResearch(query, { limit, fetchPages: payload.fetchPages !== false })
        return r(200, {
          ...result,
          usage: { credits, action, remaining: charged.remaining },
          meta: { requestId },
        })
      } catch (err) {
        return e(422, 'search_error', err.message || 'Search failed')
      }
    }
    return e(404, 'not_found', `SearchLane route not found: ${method} ${path}`)
  }


  // ── Canonical hosted capability registry ─────────────────────────
  if (method === 'GET' && path === '/v1/capabilities') {
    const { capabilityRegistry } = await import('./capabilities-registry.mjs')
    return r(200, { ok: true, ...capabilityRegistry(), meta: { requestId } })
  }
  if (method === 'GET' && path.startsWith('/v1/capabilities/')) {
    const productId = path.slice('/v1/capabilities/'.length)
    const { capabilityByProduct } = await import('./capabilities-registry.mjs')
    const product = capabilityByProduct(productId)
    if (!product) return e(404, 'not_found', `Unknown product capability: ${productId}`)
    return r(200, { ok: true, product, meta: { requestId } })
  }

  // ── Product registry (namespaces awaiting connected backends) ────
  const registryEntry = (await import('./product-registry.mjs')).getProductNamespace(path)
  if (registryEntry) {
    const { namespace, subpath, product } = registryEntry
    const { productCapabilities } = await import('./product-registry.mjs')
    if (method === 'GET' && (subpath === '/health' || subpath === '/' || subpath === '')) {
      return r(200, ok({ status: 'ok', service: namespace, version: '0.1.0', ...productCapabilities(namespace, product) }, requestId))
    }
    if (method === 'GET' && subpath === '/capabilities') return r(200, ok(productCapabilities(namespace, product), requestId))
    if (method === 'GET' && subpath === '/pricing') return r(200, ok({ product: product.name, status: 'not_configured', operations: product.operations.map((operation) => ({ operation, credits: null })) }, requestId))
    const auth = await requireApiKey(headers)
    if (!auth.ok) return e(auth.status, auth.code, auth.message)
    return r(501, fail('not_deployed', `${product.name} execution is not connected in the edge deployment. Discovery endpoints are available at /v1/${namespace}/health, /pricing, and /capabilities.`, requestId))
  }

  // ── AudioLane (live transcription) ───────────────────────────────
  if (path.startsWith('/v1/audiolane/')) {
    const sub = path.replace('/v1/audiolane', '')
    const { AUDIOLANE_VERSION, pricing, capabilities, validateInput, transcribe } = await import('./audiolane-engine.mjs')
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) return r(200, { ok: true, service: 'audiolane', version: AUDIOLANE_VERSION, workerConfigured: Boolean(process.env.AUDIOLANE_TRANSCRIBE_URL), meta: { requestId } })
    if (method === 'GET' && sub === '/pricing') return r(200, { ...pricing, meta: { requestId } })
    if (method === 'GET' && sub === '/capabilities') return r(200, { ...capabilities(), meta: { requestId } })
    if (method === 'POST' && sub === '/transcriptions') {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      const payload = jsonBody(body)
      try { validateInput(payload) } catch (err) { return e(422, 'validation_error', err.message) }
      const timestamps = payload.timestamps === 'segments' || payload.timestamps === 'words' ? payload.timestamps : 'none'
      const credits = timestamps === 'none' ? pricing.transcription : pricing['transcription.timestamps']
      try {
        const db = await loadDb()
        const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
        const action = timestamps === 'none' ? 'audiolane.transcription' : 'audiolane.transcription.timestamps'
        const dc = debitCredits(db, userId, credits, 'audiolane', action, requestId)
        if (!dc.ok) return r(402, { ok: false, error: 'insufficient_credits', required: dc.required, available: dc.balance, meta: { requestId } })
        const result = await transcribe(payload)
        db.usage_events.push({ user_id: userId, product: 'audiolane', action, credits, metadata: { mimeType: payload.mimeType, timestamps, source: payload.audioUrl ? 'url' : 'base64' }, created_at: new Date().toISOString(), request_id: requestId })
        await saveDb(db)
        return r(200, { ...result, usage: { credits, action, remaining: dc.balance }, meta: { requestId } })
      } catch (err) {
        return e(err.code === 'provider_unavailable' ? 503 : 502, err.code || 'transcription_error', err.message || 'Transcription failed')
      }
    }
    return e(404, 'not_found', `AudioLane route not found: ${method} ${path}`)
  }

  // ── CalcLane (live engine) ───────────────────────────────────────
  if (path.startsWith('/v1/calclane/')) {
    const sub = path.replace('/v1/calclane', '')
    const {
      CALCLANE_VERSION,
      evaluateExpression,
      runDispatch,
      getCalcLanePricing,
      getCalcLaneCapabilities,
    } = await import('./calclane-engine.mjs')

    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, {
        ok: true,
        service: 'calclane',
        version: CALCLANE_VERSION,
        endpoints: getCalcLaneCapabilities().endpoints,
        meta: { requestId },
      })
    }
    if (method === 'GET' && sub === '/pricing') {
      return r(200, { ...getCalcLanePricing(), meta: { requestId } })
    }
    if (method === 'GET' && sub === '/capabilities') {
      return r(200, { ...getCalcLaneCapabilities(), meta: { requestId } })
    }
    if (method === 'POST' && (sub === '/evaluate' || sub === '/dispatch')) {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      const payload = jsonBody(body) || {}
      const credits = 1
      const action = sub === '/evaluate' ? 'calclane.evaluate' : 'calclane.dispatch'
      try {
        const db = await loadDb()
        const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
        const dc = debitCredits(db, userId, credits, 'calclane', action, requestId)
        if (!dc.ok) {
          return r(402, { ok: false, error: 'insufficient_credits', required: dc.required, available: dc.balance, meta: { requestId } })
        }
        db.usage_events.push({
          user_id: userId, product: 'calclane', action, credits,
          metadata: sub === '/evaluate'
            ? { expression: String(payload.expression || payload.expr || payload.q || '').slice(0, 200) }
            : { commandCount: Array.isArray(payload.commands) ? payload.commands.length : 0 },
          created_at: new Date().toISOString(), request_id: requestId,
        })
        await saveDb(db)

        if (sub === '/evaluate') {
          const expression = typeof payload.expression === 'string' ? payload.expression
            : typeof payload.expr === 'string' ? payload.expr
            : typeof payload.q === 'string' ? payload.q : ''
          if (!String(expression).trim()) return e(422, 'validation_error', 'expression is required')
          const result = evaluateExpression(String(expression), {
            mode: payload.mode === 'standard' ? 'standard' : 'scientific',
            angle: payload.angle === 'rad' || payload.angle === 'grad' ? payload.angle : 'deg',
            fe: Boolean(payload.fe),
          })
          return r(result.ok ? 200 : 422, {
            ...result,
            usage: { credits, action, remaining: dc.balance },
            meta: { requestId },
          })
        }

        if (!Array.isArray(payload.commands)) return e(422, 'validation_error', 'commands array is required')
        const result = runDispatch({
          commands: payload.commands,
          mode: payload.mode === 'standard' ? 'standard' : 'scientific',
          angle: payload.angle === 'rad' || payload.angle === 'grad' ? payload.angle : 'deg',
        })
        return r(result.ok ? 200 : 422, {
          ...result,
          usage: { credits, action, remaining: dc.balance },
          meta: { requestId },
        })
      } catch (err) {
        return e(422, 'calc_error', err.message || 'Calculation failed')
      }
    }
    return e(404, 'not_found', `CalcLane route not found: ${method} ${path}`)
  }

  // ── GeoLane ───────────────────────────────────────────────────────
  if (path.startsWith('/v1/geolane/')) {
    const sub = path.replace('/v1/geolane', '')
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ status: 'ok', service: 'geolane-api', version: '0.1.0', timestamp: new Date().toISOString() }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') {
      return r(200, ok({ audit: 40, compare: 50, crawlers: 15, 'llms-txt': 20, 'citation-readiness': 25 }, requestId))
    }
    if (method === 'POST' && (sub === '/audit' || sub === '/compare')) {
      const payload = jsonBody(body)
      if (!payload) return e(400, 'invalid_request', 'Request body is required')
      return r(200, ok({ status: 'endpoint_defined', endpoint: sub, message: 'GeoLane endpoint is wired. Live geo-analysis requires the upstream AI backend to be connected.' }, requestId))
    }
  }

  // ── Agent Browser ─────────────────────────────────────────────────
  if (path.startsWith('/v1/agent-browser/')) {
    const sub = path.replace('/v1/agent-browser', '')
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ status: 'ok', service: 'agent-browser-api', version: '0.1.0', timestamp: new Date().toISOString() }, requestId))
    }
    if (method === 'POST' && (sub === '/check' || sub === '/screenshot' || sub === '/evidence' || sub === '/extract' || sub === '/analyze')) {
      return r(200, ok({ status: 'endpoint_defined', endpoint: sub, message: 'Agent Browser endpoint is wired. Live browser automation requires the upstream service to be connected.' }, requestId))
    }
  }

  // ── InvoiceLane ───────────────────────────────────────────────────
  if (path.startsWith('/v1/invoicelane/')) {
    const sub = path.replace('/v1/invoicelane', '')
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ status: 'ok', service: 'invoicelane-api', version: '0.1.0', timestamp: new Date().toISOString() }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') {
      return r(200, ok({ extract: 20, 'invoice/extract': 30, 'receipt/extract': 20, validate: 10, 'export/csv': 5 }, requestId))
    }
    if (method === 'POST' && (sub === '/extract' || sub === '/invoice/extract' || sub === '/receipt/extract' || sub === '/validate')) {
      return r(200, ok({ status: 'endpoint_defined', endpoint: sub, message: 'InvoiceLane endpoint is wired. Live document extraction requires the upstream AI backend to be connected.' }, requestId))
    }
  }

  // ── MCP ──────────────────────────────────────────────────────────
  if (path === '/mcp') {
    const mcpCors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, X-Api-Key, X-Talocode-Api-Key, Content-Type',
    }
    const mcpRpc = (status, obj) => respond(status, obj, mcpCors)

    // GET /mcp - health / discovery
    if (method === 'GET') {
      return mcpRpc(200, {
        ok: true,
        service: 'talocode-mcp',
        version: '0.1.0',
        endpoint: '/mcp',
        transport: 'streamable-http',
        auth: 'TALOCODE_API_KEY',
        tools: MCP_TOOLS.length,
      })
    }

    // POST /mcp - JSON-RPC
    if (method === 'POST') {
      const payload = jsonBody(body)
      if (!payload || typeof payload !== 'object') {
        return mcpRpc(400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON-RPC body' }, id: null })
      }
      const rpcId = payload.id ?? null
      const rpcMethod = payload.method

      if (rpcMethod === 'initialize') {
        return mcpRpc(200, {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            protocolVersion: payload.params && payload.params.protocolVersion ? payload.params.protocolVersion : '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'talocode-mcp', version: '0.1.0' },
          },
        })
      }

      if (rpcMethod === 'notifications/initialized' || rpcMethod === 'ping') {
        return mcpRpc(200, { jsonrpc: '2.0', id: rpcId, result: {} })
      }

      if (rpcMethod === 'tools/list') {
        return mcpRpc(200, {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            tools: MCP_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: { type: 'object', additionalProperties: true, properties: {} },
            })),
            nextCursor: null,
          },
        })
      }

      if (rpcMethod === 'tools/call') {
        let auth = { ok: false }
        try {
          auth = await requireApiKey(headers)
        } catch (err) {
          auth = { ok: false, message: 'API key storage unavailable; retry with a valid TALOCODE_API_KEY.' }
        }
        if (!auth.ok) {
          return mcpRpc(200, { jsonrpc: '2.0', id: rpcId, result: { content: [{ type: 'text', text: `MCP tools/call requires a valid TALOCODE_API_KEY: ${auth.message}` }], isError: true } })
        }
        const name = payload.params && payload.params.name
        const args = (payload.params && payload.params.arguments) || {}
        const tool = MCP_TOOLS.find((t) => t.name === name)
        if (!tool) {
          return mcpRpc(200, { jsonrpc: '2.0', id: rpcId, result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true } })
        }
        return mcpRpc(200, {
          jsonrpc: '2.0',
          id: rpcId,
          result: { content: [{ type: 'text', text: `${name} is defined on api.talocode.site/mcp. Underlying product service wiring is being connected; arguments received: ${JSON.stringify(args)}` }], isError: false },
        })
      }

      return mcpRpc(400, { jsonrpc: '2.0', error: { code: -32601, message: `Method not supported: ${rpcMethod}` }, id: rpcId })
    }

    return mcpRpc(405, { jsonrpc: '2.0', error: { code: -32600, message: 'Method not allowed' }, id: null })
  }

  // ── Cloud health (expanded) ────────────────────────────────────────
  if ((method === 'GET') && (path === '/api/v1/cloud/health' || path === '/cloud/health')) {
    const db = await loadDb()
    return r(200, ok({ status: 'ok', service: 'stacklane-cloud', version: '0.6.0', dbSize: JSON.stringify(db).length, creditsAvailable: db.profiles['user-admin-001']?.purchased_credits_balance || 0, timestamp: new Date().toISOString() }, requestId))
  }


  // ─── Talocode Cloud AI (ScreenLane / Router / Tera / Codra) ───────
  // Paths documented in CLOUD.md — required for screenlane send --target *

  // Health aliases
  if (method === 'GET' && (path === '/v1/health' || path === '/v1/router/health' || path === '/v1/screenlane/health')) {
    return r(200, ok({ status: 'ok', service: 'talocode-cloud', version: '0.6.0', base: 'https://api.talocode.site', timestamp: new Date().toISOString() }, requestId))
  }

  // OpenAI-compatible chat + router
  if (method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/router/chat/completions')) {
    const charged = await chargeCredits(headers, 'talocode-cloud', `router.${path === '/v1/router/chat/completions' ? 'chat' : 'chat'}`, 3, requestId)
    if (!charged.ok) return e(charged.status, charged.code, charged.message)
    const payload = jsonBody(body) || {}
    const messages = payload.messages
    if (!Array.isArray(messages) || !messages.length) return e(400, 'invalid_request', 'messages array required')
    try {
      const result = await providerChat(messages, payload.model, payload)
      // Normalize OpenAI-ish shape
      if (result?.result?.choices) {
        return r(200, {
          id: result.id || requestId,
          object: 'chat.completion',
          choices: result.result.choices,
          usage: result.result.usage || result.usage,
          meta: { requestId, source: 'talocode-cloud', keyUser: charged.userId },
        })
      }
      if (result?.choices) {
        return r(200, { ...result, meta: { requestId, source: 'talocode-cloud' } })
      }
      return r(200, ok(result, requestId))
    } catch (err) {
      return e(502, 'provider_error', err.message)
    }
  }

  // Tera writing rewrite (used by ScreenLane prompt polish)
  if (method === 'POST' && path === '/v1/tera/writing/rewrite') {
    const auth = await requireApiKey(headers)
    if (!auth.ok) return e(auth.status, auth.code, auth.message)
    const payload = jsonBody(body) || {}
    const text = payload.text || payload.prompt || ''
    if (!text) return e(400, 'invalid_request', 'text required')
    try {
      const result = await providerChat([
        { role: 'system', content: 'Rewrite the user text clearly. Return plain text only.' },
        { role: 'user', content: `${payload.instruction || 'Rewrite'}:\n${text}` },
      ])
      const out = result?.choices?.[0]?.message?.content
        || result?.result?.choices?.[0]?.message?.content
        || String(text)
      return r(200, ok({ text: out, notes: [] }, requestId))
    } catch (err) {
      return e(502, 'provider_error', err.message)
    }
  }

  // Codra cloud actions
  if (method === 'POST' && (path === '/v1/codra/run' || path === '/v1/codra/repo-summary')) {
    const charged = await chargeCredits(headers, 'codra', path === '/v1/codra/repo-summary' ? 'codra.repo_summary' : 'codra.run', 20, requestId)
    if (!charged.ok) return e(charged.status, charged.code, charged.message)
    const payload = jsonBody(body) || {}
    const prompt = payload.prompt || payload.text || ''
    if (!prompt) return e(400, 'invalid_request', 'prompt or text required')
    try {
      const result = await providerChat([
        { role: 'system', content: 'You are Codra, a coding agent. Be concrete and minimal.' },
        { role: 'user', content: prompt },
      ])
      const out = result?.choices?.[0]?.message?.content
        || result?.result?.choices?.[0]?.message?.content
        || 'ok'
      return r(200, ok({ output: out, endpoint: path, status: 'ok' }, requestId))
    } catch (err) {
      return e(502, 'provider_error', err.message)
    }
  }

  // GateLane call passthrough stub (policy-aware later)
  if (method === 'POST' && path === '/v1/gatelane/call') {
    const charged = await chargeCredits(headers, 'gatelane', 'gatelane.check', 2, requestId)
    if (!charged.ok) return e(charged.status, charged.code, charged.message)
    const payload = jsonBody(body) || {}
    return r(200, ok({
      allowed: true,
      tool: payload.tool || 'screenlane.command',
      input: payload.input || {},
      message: 'GateLane accepted call (policy default allow for ScreenLane).',
      usage: { credits: 2, action: 'gatelane.check', remaining: charged.remaining },
    }, requestId))
  }

  // ScreenLane cloud helpers
  if (method === 'GET' && path === '/v1/screenlane/doctor') {
    return r(200, ok({
      ok: true,
      cloud: true,
      base: 'https://api.talocode.site',
      auth: 'TALOCODE_API_KEY',
      checks: [
        { name: 'cloud_api', status: 'ok', detail: 'https://api.talocode.site' },
        { name: 'chat', status: 'ok', detail: 'POST /v1/router/chat/completions' },
      ],
    }, requestId))
  }

  if (method === 'POST' && path === '/v1/screenlane/command') {
    const auth = await requireApiKey(headers)
    if (!auth.ok) return e(auth.status, auth.code, auth.message)
    const payload = jsonBody(body) || {}
    const instruction = payload.text || payload.instruction || ''
    const contextText = payload.contextText || payload.context || ''
    if (!instruction) return e(400, 'invalid_request', 'text/instruction required')
    const lower = `${instruction}\n${contextText}`.toLowerCase()
    let intent = 'general_action'
    if (/fix|error|debug|exception/.test(lower)) intent = 'debug_error'
    else if (/explain|summar/.test(lower)) intent = 'explain'
    const prompt = [
      'You are an AI agent acting on a ScreenLane screen-aware command.',
      `Intent: ${intent}`,
      '',
      'Screen context:',
      '```',
      String(contextText).slice(0, 8000),
      '```',
      '',
      'User instruction:',
      instruction,
      '',
      'Follow the instruction using the context. Prefer minimal, safe changes.',
    ].join('\n')
    return r(200, ok({
      intent,
      instruction,
      target: payload.target || 'stdout',
      prompt,
      source: 'screenlane-cloud',
    }, requestId))
  }

  if (method === 'POST' && path === '/v1/screenlane/send') {
    const charged = await chargeCredits(headers, 'screenlane', 'screenlane.send', 3, requestId)
    if (!charged.ok) return e(charged.status, charged.code, charged.message)
    const payload = jsonBody(body) || {}
    const text = payload.text || payload.commandText || payload.prompt || ''
    if (!text) return e(400, 'invalid_request', 'text required')
    // Reuse chat completions for cloud execution
    try {
      const result = await providerChat([
        { role: 'user', content: text },
      ])
      return r(200, ok({ sent: true, result, target: payload.target || 'cloud', usage: { credits: 3, action: 'screenlane.send', remaining: charged.remaining } }, requestId))
    } catch (err) {
      return e(502, 'provider_error', err.message)
    }
  }

  if (method === 'POST' && path === '/v1/screenlane/demo') {
    return r(200, ok({
      note: 'text-mode voice simulation for deterministic demo',
      voice: { transcript: 'Fix this error' },
      command: {
        intent: 'debug_error',
        target: 'codra',
        prompt: 'You are Codra. Diagnose the error from screen context and propose a minimal fix.',
      },
    }, requestId))
  }


  // ── VerifyLane (live deterministic engine) ─────────────────────────
  if (path.startsWith('/v1/verifylane/')) {
    const sub = path.replace('/v1/verifylane', '')
    const {
      verifySecrets, verifySecurity, verifyQuality, verifyCode, verifyDiff, verifyAgentOutput,
      verifyEmail, verifyPhone, verifyIp, verifyData,
      getVerifyLanePricing, getVerifyLaneCapabilities, VERIFYLANE_VERSION,
    } = await import('./verifylane-engine.mjs')

    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ ok: true, service: 'verifylane', version: VERIFYLANE_VERSION, endpoints: getVerifyLaneCapabilities().endpoints }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') return r(200, ok(getVerifyLanePricing(), requestId))
    if (method === 'GET' && sub === '/capabilities') return r(200, ok(getVerifyLaneCapabilities(), requestId))

    const runVerify = async (action, credits, runner) => {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      try {
        const db = await loadDb()
        const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
        const result = debitCredits(db, userId, credits, 'verifylane', action, requestId)
        if (!result.ok) return r(402, { ok: false, error: 'insufficient_credits', required: result.required, available: result.balance, meta: { requestId } })
        const output = runner()
        db.usage_events.push({ user_id: userId, product: 'verifylane', action, credits, metadata: {}, created_at: new Date().toISOString(), request_id: requestId })
        await saveDb(db)
        return r(200, ok({ ...output, usage: { credits, action, remaining: result.balance } }, requestId))
      } catch (err) {
        return e(422, 'validation_error', err.message || 'verify failed')
      }
    }

    if (method === 'POST' && sub === '/secrets') return runVerify('verifylane.secrets', 3, () => verifySecrets(jsonBody(body)))
    if (method === 'POST' && sub === '/security') return runVerify('verifylane.security', 5, () => verifySecurity(jsonBody(body)))
    if (method === 'POST' && sub === '/quality') return runVerify('verifylane.quality', 3, () => verifyQuality(jsonBody(body)))
    if (method === 'POST' && sub === '/code') return runVerify('verifylane.code', 8, () => verifyCode(jsonBody(body)))
    if (method === 'POST' && sub === '/diff') return runVerify('verifylane.diff', 8, () => verifyDiff(jsonBody(body)))
    if (method === 'POST' && sub === '/agent-output') return runVerify('verifylane.agent-output', 5, () => verifyAgentOutput(jsonBody(body)))
    if (method === 'POST' && sub === '/email') {
      const payload = jsonBody(body) || {}
      const value = typeof payload.value === 'string' ? payload.value : ''
      if (!value) return e(422, 'validation_error', 'value is required.')
      return runVerify('verifylane.email', 1, () => verifyEmail(value))
    }
    if (method === 'POST' && sub === '/phone') {
      const payload = jsonBody(body) || {}
      const value = typeof payload.value === 'string' ? payload.value : ''
      if (!value) return e(422, 'validation_error', 'value is required.')
      return runVerify('verifylane.phone', 1, () => verifyPhone(value, { country: typeof payload.country === 'string' ? payload.country : undefined }))
    }
    if (method === 'POST' && sub === '/ip') {
      const payload = jsonBody(body) || {}
      const value = typeof payload.value === 'string' ? payload.value : ''
      if (!value) return e(422, 'validation_error', 'value is required.')
      return runVerify('verifylane.ip', 1, () => verifyIp(value))
    }
    if (method === 'POST' && sub === '/data') {
      const payload = jsonBody(body) || {}
      if (!Array.isArray(payload.values)) return e(422, 'validation_error', 'values array is required.')
      return runVerify('verifylane.data', 2, () => verifyData({ values: payload.values }))
    }
    return e(404, 'not_found', `VerifyLane route not found: ${method} ${path}`)
  }

  // ── SpendCaps (live deterministic engine) ─────────────────────────
  if (path.startsWith('/v1/spendcaps/')) {
    const sub = path.replace('/v1/spendcaps', '')
    const { checkSpendCap, getSpendCapsPricing, getSpendCapsCapabilities, SPENDCAPS_VERSION } = await import('./spendcaps-engine.mjs')
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ status: 'ok', service: 'spendcaps', version: SPENDCAPS_VERSION, endpoints: getSpendCapsCapabilities().endpoints }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') return r(200, ok(getSpendCapsPricing(), requestId))
    if (method === 'GET' && sub === '/capabilities') return r(200, ok(getSpendCapsCapabilities(), requestId))
    if (method === 'POST' && sub === '/check') {
      const charged = await chargeCredits(headers, 'spendcaps', 'spendcaps.check', 1, requestId)
      if (!charged.ok) return e(charged.status, charged.code, charged.message)
      try {
        const payload = jsonBody(body) || {}
        const result = checkSpendCap({ ...payload, balanceCredits: payload.balanceCredits ?? charged.remaining })
        return r(200, ok({ ...result, usage: { credits: 1, action: 'spendcaps.check', remaining: charged.remaining } }, requestId))
      } catch (err) {
        return e(422, 'validation_error', err.message || 'check failed')
      }
    }
    return e(404, 'not_found', `SpendCaps route not found: ${method} ${path}`)
  }

  // ── PolicyLane (live deterministic engine) ────────────────────────
  if (path.startsWith('/v1/policylane/')) {
    const sub = path.replace('/v1/policylane', '')
    const { checkPolicy, redact, getPolicyLanePricing, getPolicyLaneCapabilities, POLICYLANE_VERSION } = await import('./policylane-engine.mjs')
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ ok: true, service: 'policylane', version: POLICYLANE_VERSION, endpoints: getPolicyLaneCapabilities().endpoints }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') return r(200, ok(getPolicyLanePricing(), requestId))
    if (method === 'GET' && sub === '/capabilities') return r(200, ok(getPolicyLaneCapabilities(), requestId))
    if (method === 'POST' && sub === '/check') {
      const charged = await chargeCredits(headers, 'policylane', 'policylane.check', 2, requestId)
      if (!charged.ok) return e(charged.status, charged.code, charged.message)
      const payload = jsonBody(body)
      if (!payload || !payload.policy || !payload.action) return e(422, 'validation_error', 'action and policy are required.')
      try {
        const result = checkPolicy(payload)
        return r(200, ok({ ...result, usage: { credits: 2, action: 'policylane.check', remaining: charged.remaining } }, requestId))
      } catch (err) {
        return e(422, 'validation_error', err.message || 'check failed')
      }
    }
    if (method === 'POST' && sub === '/redact') {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      const payload = jsonBody(body) || {}
      try {
        const db = await loadDb()
        const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
        const credits = 1
        const dc = debitCredits(db, userId, credits, 'policylane', 'policylane.redact', requestId)
        if (!dc.ok) return r(402, { ok: false, error: 'insufficient_credits', required: dc.required, available: dc.balance, meta: { requestId } })
        const result = redact(payload.value ?? payload.payload, payload.patterns)
        db.usage_events.push({ user_id: userId, product: 'policylane', action: 'policylane.redact', credits, metadata: {}, created_at: new Date().toISOString(), request_id: requestId })
        await saveDb(db)
        return r(200, ok({ product: 'policylane', version: POLICYLANE_VERSION, ...result, usage: { credits, action: 'policylane.redact', remaining: dc.balance } }, requestId))
      } catch (err) {
        return e(422, 'validation_error', err.message || 'redact failed')
      }
    }
    return e(404, 'not_found', `PolicyLane route not found: ${method} ${path}`)
  }

  // ── ReliabilityLane (live deterministic engine) ───────────────────
  if (path.startsWith('/v1/reliabilitylane/')) {
    const sub = path.replace('/v1/reliabilitylane', '')
    const {
      FAILURE_PATTERNS, RETRY_STRATEGIES, VERIFICATION_CHECKLISTS, INCIDENT_PLAYBOOKS, ANTI_PATTERNS,
      matchFailure, planRetry, verify, incidentFor,
      getReliabilityLanePricing, getReliabilityLaneCapabilities, RELIABILITYLANE_VERSION,
    } = await import('./reliabilitylane-engine.mjs')

    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ ok: true, service: 'reliabilitylane', version: RELIABILITYLANE_VERSION, endpoints: getReliabilityLaneCapabilities().endpoints }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') return r(200, ok(getReliabilityLanePricing(), requestId))
    if (method === 'GET' && sub === '/capabilities') return r(200, ok(getReliabilityLaneCapabilities(), requestId))
    if (method === 'GET' && sub === '/antipatterns') return r(200, ok({ product: 'reliabilitylane', version: RELIABILITYLANE_VERSION, antiPatterns: ANTI_PATTERNS }, requestId))
    if (method === 'GET' && sub === '/patterns') return r(200, ok({ product: 'reliabilitylane', version: RELIABILITYLANE_VERSION, patterns: FAILURE_PATTERNS }, requestId))
    if (method === 'GET' && sub === '/retries') return r(200, ok({ product: 'reliabilitylane', version: RELIABILITYLANE_VERSION, strategies: RETRY_STRATEGIES }, requestId))
    if (method === 'GET' && sub === '/checklists') return r(200, ok({ product: 'reliabilitylane', version: RELIABILITYLANE_VERSION, checklists: VERIFICATION_CHECKLISTS }, requestId))
    if (method === 'GET' && sub === '/playbooks') return r(200, ok({ product: 'reliabilitylane', version: RELIABILITYLANE_VERSION, playbooks: INCIDENT_PLAYBOOKS }, requestId))
    const patternMatch = sub.match(/^\/patterns\/([\w-]+)$/)
    if (method === 'GET' && patternMatch) {
      const pattern = FAILURE_PATTERNS.find((p) => p.id === patternMatch[1])
      if (!pattern) return e(404, 'not_found', `ReliabilityLane pattern '${patternMatch[1]}' not found.`)
      return r(200, ok({ product: 'reliabilitylane', version: RELIABILITYLANE_VERSION, pattern }, requestId))
    }

    const runReliability = async (action, credits, runner) => {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      try {
        const db = await loadDb()
        const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
        const dc = debitCredits(db, userId, credits, 'reliabilitylane', action, requestId)
        if (!dc.ok) return r(402, { ok: false, error: 'insufficient_credits', required: dc.required, available: dc.balance, meta: { requestId } })
        const result = runner()
        db.usage_events.push({ user_id: userId, product: 'reliabilitylane', action, credits, metadata: {}, created_at: new Date().toISOString(), request_id: requestId })
        await saveDb(db)
        return r(200, ok({ ...result, usage: { credits, action, remaining: dc.balance } }, requestId))
      } catch (err) {
        return e(422, 'validation_error', err.message || 'reliabilitylane call failed')
      }
    }

    if (method === 'POST' && sub === '/match') {
      const payload = jsonBody(body) || {}
      return runReliability('reliabilitylane.patterns', 1, () => matchFailure({
        symptom: typeof payload.symptom === 'string' ? payload.symptom : '',
        error: typeof payload.error === 'string' ? payload.error : '',
        category: typeof payload.category === 'string' ? payload.category : undefined,
      }))
    }
    if (method === 'POST' && sub === '/retry-plan') {
      const payload = jsonBody(body) || {}
      return runReliability('reliabilitylane.retry', 1, () => planRetry({
        status: typeof payload.status === 'number' ? payload.status : undefined,
        code: typeof payload.code === 'string' ? payload.code : undefined,
        message: typeof payload.message === 'string' ? payload.message : undefined,
        kind: typeof payload.kind === 'string' ? payload.kind : undefined,
      }))
    }
    if (method === 'POST' && sub === '/verify') {
      const payload = jsonBody(body) || {}
      return runReliability('reliabilitylane.verify', 1, () => verify({
        checklist: typeof payload.checklist === 'string' ? payload.checklist : undefined,
        area: typeof payload.area === 'string' ? payload.area : undefined,
        evidence: payload.evidence && typeof payload.evidence === 'object' ? payload.evidence : undefined,
      }))
    }
    if (method === 'POST' && sub === '/incident') {
      const payload = jsonBody(body) || {}
      return runReliability('reliabilitylane.incident', 2, () => incidentFor({
        symptom: typeof payload.symptom === 'string' ? payload.symptom : '',
        error: typeof payload.error === 'string' ? payload.error : '',
      }))
    }
    return e(404, 'not_found', `ReliabilityLane route not found: ${method} ${path}`)
  }

  // ── DocuLane (live engine) ────────────────────────────────────────
  if (path.startsWith('/v1/doculane/')) {
    const sub = path.replace('/v1/doculane', '')
    const { readFile, writeFile, getFileInfo, extractFromDocument, getDocuLanePricing, getDocuLaneCapabilities, DOCULANE_VERSION } = await import('./doculane-engine.mjs')
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ ok: true, service: 'doculane', version: DOCULANE_VERSION, endpoints: getDocuLaneCapabilities().endpoints }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') return r(200, ok(getDocuLanePricing(), requestId))
    if (method === 'GET' && sub === '/capabilities') return r(200, ok(getDocuLaneCapabilities(), requestId))

    const runDoculane = async (action, credits, runner) => {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      try {
        const db = await loadDb()
        const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
        const dc = debitCredits(db, userId, credits, 'doculane', action, requestId)
        if (!dc.ok) return r(402, { ok: false, error: 'insufficient_credits', required: dc.required, available: dc.balance, meta: { requestId } })
        const result = await runner()
        db.usage_events.push({ user_id: userId, product: 'doculane', action, credits, metadata: {}, created_at: new Date().toISOString(), request_id: requestId })
        await saveDb(db)
        return r(200, ok({ ...result, usage: { credits, action, remaining: dc.balance } }, requestId))
      } catch (err) {
        return e(422, 'validation_error', err.message || 'doculane call failed')
      }
    }

    if (method === 'POST' && sub === '/read') {
      const payload = jsonBody(body) || {}
      if (!payload.fileUrl || !payload.fileType) return e(422, 'validation_error', 'fileUrl and fileType are required.')
      return runDoculane('doculane.read', 5, () => readFile({ fileUrl: payload.fileUrl, fileType: payload.fileType }))
    }
    if (method === 'POST' && sub === '/write') {
      const payload = jsonBody(body) || {}
      if (!payload.fileType || !payload.content) return e(422, 'validation_error', 'fileType and content are required.')
      return runDoculane('doculane.write', 5, () => writeFile({ fileType: payload.fileType, content: payload.content }))
    }
    if (method === 'POST' && sub === '/info') {
      const payload = jsonBody(body) || {}
      if (!payload.fileUrl || !payload.fileType) return e(422, 'validation_error', 'fileUrl and fileType are required.')
      return runDoculane('doculane.info', 2, () => getFileInfo({ fileUrl: payload.fileUrl, fileType: payload.fileType }))
    }
    if (method === 'POST' && sub === '/extract') {
      const payload = jsonBody(body) || {}
      if (!payload.documentUrl || !payload.prompt) return e(422, 'validation_error', 'documentUrl and prompt are required.')
      return runDoculane('doculane.extract', 30, () => extractFromDocument({
        documentUrl: payload.documentUrl,
        prompt: payload.prompt,
        format: typeof payload.format === 'string' ? payload.format : 'json',
        schema: payload.schema && typeof payload.schema === 'object' ? payload.schema : undefined,
      }))
    }
    return e(404, 'not_found', `DocuLane route not found: ${method} ${path}`)
  }

  // ── ClipLoop (live engine) ────────────────────────────────────────
  if (path.startsWith('/v1/cliploop/')) {
    const {
      generateBrief, generateScript, submitRender, getRenderStatus, createCampaign, packageCampaign,
      getClipLoopPricing, getClipLoopCapabilities, CLIPLOOP_VERSION,
    } = await import('./cliploop-engine.mjs')

    if (method === 'GET' && (path === '/v1/cliploop/health' || path === '/v1/cliploop/')) {
      return r(200, ok({ status: 'ok', service: 'cliploop', version: CLIPLOOP_VERSION, endpoints: getClipLoopCapabilities().endpoints }, requestId))
    }
    if (method === 'GET' && path === '/v1/cliploop/pricing') return r(200, ok(getClipLoopPricing(), requestId))
    if (method === 'GET' && path === '/v1/cliploop/capabilities') return r(200, ok(getClipLoopCapabilities(), requestId))

    const runClipLoop = async (action, credits, runner) => {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      try {
        const db = await loadDb()
        const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
        const dc = debitCredits(db, userId, credits, 'cliploop', action, requestId)
        if (!dc.ok) return r(402, { ok: false, error: 'insufficient_credits', required: dc.required, available: dc.balance, meta: { requestId } })
        const result = await runner()
        db.usage_events.push({ user_id: userId, product: 'cliploop', action, credits, metadata: {}, created_at: new Date().toISOString(), request_id: requestId })
        await saveDb(db)
        return r(200, ok({ ...result, usage: { credits, action, remaining: dc.balance } }, requestId))
      } catch (err) {
        if (err.message && (err.message.includes('No AI provider configured') || err.message.includes('ClipLoop provider'))) {
          return e(503, 'provider_unavailable', err.message)
        }
        return e(422, 'validation_error', err.message || 'cliploop call failed')
      }
    }

    if (method === 'POST' && path === '/v1/cliploop/brief/generate') {
      const payload = jsonBody(body) || {}
      if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) return e(422, 'validation_error', 'prompt is required.')
      return runClipLoop('cliploop.brief.generate', 15, () => generateBrief({
        prompt: payload.prompt,
        channel: typeof payload.channel === 'string' ? payload.channel : undefined,
        duration: typeof payload.duration === 'number' ? payload.duration : undefined,
      }))
    }
    if (method === 'POST' && path === '/v1/cliploop/script/generate') {
      const payload = jsonBody(body) || {}
      if (typeof payload.briefId !== 'string' || !payload.briefId.trim()) return e(422, 'validation_error', 'briefId is required.')
      return runClipLoop('cliploop.script.generate', 15, () => generateScript({
        briefId: payload.briefId,
        style: typeof payload.style === 'string' ? payload.style : undefined,
      }))
    }
    if (method === 'POST' && path === '/v1/cliploop/video/render') {
      const payload = jsonBody(body) || {}
      if (typeof payload.scriptId !== 'string' || !payload.scriptId.trim()) return e(422, 'validation_error', 'scriptId is required.')
      return runClipLoop('cliploop.video.render', 200, () => submitRender({
        scriptId: payload.scriptId,
        format: payload.format === 'landscape' || payload.format === 'square' ? payload.format : undefined,
        quality: payload.quality === 'draft' || payload.quality === 'standard' || payload.quality === 'high' ? payload.quality : undefined,
      }))
    }
    if (method === 'POST' && path === '/v1/cliploop/campaign/create') {
      const payload = jsonBody(body) || {}
      if (typeof payload.name !== 'string' || !payload.name.trim()) return e(422, 'validation_error', 'name is required.')
      if (typeof payload.platform !== 'string' || !payload.platform.trim()) return e(422, 'validation_error', 'platform is required.')
      return runClipLoop('cliploop.campaign.create', 50, () => createCampaign({
        name: payload.name,
        platform: payload.platform,
        schedule: typeof payload.schedule === 'string' ? payload.schedule : undefined,
      }))
    }
    if (method === 'POST' && path === '/v1/cliploop/campaign/package') {
      const payload = jsonBody(body) || {}
      if (typeof payload.campaignId !== 'string' || !payload.campaignId.trim()) return e(422, 'validation_error', 'campaignId is required.')
      return runClipLoop('cliploop.campaign.package', 400, () => packageCampaign(payload.campaignId))
    }
    if (method === 'GET' && path.startsWith('/v1/cliploop/video/')) {
      const renderId = decodeURIComponent(path.replace('/v1/cliploop/video/', ''))
      try {
        const result = await getRenderStatus(renderId)
        return r(200, ok(result, requestId))
      } catch (err) {
        return e(404, 'not_found', err.message || 'Render job not found.')
      }
    }
    return e(404, 'not_found', `ClipLoop route not found: ${method} ${path}`)
  }

  // ── Wiki (live engine, blob-backed) ───────────────────────────────
  if (path.startsWith('/v1/wiki/')) {
    const sub = path.replace('/v1/wiki', '')
    const { wikiInit, wikiIngest, wikiQuery, wikiLint, wikiSave, getWikiPricing, getWikiCapabilities, WIKI_VERSION } = await import('./wiki-engine.mjs')
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ status: 'ok', service: 'wiki', version: WIKI_VERSION, endpoints: ['/v1/wiki/init', '/v1/wiki/ingest', '/v1/wiki/query', '/v1/wiki/lint', '/v1/wiki/save'] }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') return r(200, ok(getWikiPricing(), requestId))
    if (method === 'GET' && sub === '/capabilities') return r(200, ok(getWikiCapabilities(), requestId))

    const runWiki = async (action, credits, runner) => {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      try {
        const db = await loadDb()
        const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
        const dc = debitCredits(db, userId, credits, 'wiki', action, requestId)
        if (!dc.ok) return r(402, { ok: false, error: 'insufficient_credits', required: dc.required, available: dc.balance, meta: { requestId } })
        const result = await runner(db)
        db.usage_events.push({ user_id: userId, product: 'wiki', action, credits, metadata: {}, created_at: new Date().toISOString(), request_id: requestId })
        await saveDb(db)
        return r(200, ok({ ...result, usage: { credits, action, remaining: dc.balance } }, requestId))
      } catch (err) {
        return e(422, 'validation_error', err.message || 'wiki call failed')
      }
    }

    if (method === 'POST' && sub === '/init') return runWiki('wiki.init', 0, (db) => wikiInit(db))
    if (method === 'POST' && sub === '/ingest') {
      const payload = jsonBody(body) || {}
      if (!payload.source && !payload.content) return e(422, 'validation_error', 'source or content required.')
      return runWiki('wiki.ingest', 5, (db) => wikiIngest(db, payload))
    }
    if (method === 'POST' && sub === '/query') {
      const payload = jsonBody(body) || {}
      if (!payload.question) return e(422, 'validation_error', 'question required.')
      return runWiki('wiki.query', 3, (db) => wikiQuery(db, payload.question))
    }
    if (method === 'POST' && sub === '/lint') return runWiki('wiki.lint', 2, (db) => wikiLint(db))
    if (method === 'POST' && sub === '/save') {
      const payload = jsonBody(body) || {}
      if (!payload.title || !payload.content) return e(422, 'validation_error', 'title and content required.')
      return runWiki('wiki.save', 2, (db) => wikiSave(db, payload))
    }
    return e(404, 'not_found', `Wiki route not found: ${method} ${path}`)
  }

  // ── VideoLane (proxy to configured server) ────────────────────────
  if (path.startsWith('/v1/videolane/')) {
    const sub = path.replace('/v1/videolane', '')
    const { generateVideoPlan, generateCaptions, generateMetadata, checkHealth, getVideoLanePricing, getVideoLaneCapabilities, VIDEOLANE_VERSION } = await import('./videolane-engine.mjs')
    const workerConfigured = Boolean(process.env.VIDEOLANE_SERVER_URL)
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      const health = workerConfigured ? await checkHealth() : { ok: false, error: 'not configured' }
      return r(200, ok({ ok: health.ok, service: 'videolane', version: VIDEOLANE_VERSION, workerConfigured, server: health }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') return r(200, ok(getVideoLanePricing(), requestId))
    if (method === 'GET' && sub === '/capabilities') return r(200, ok(getVideoLaneCapabilities(), requestId))

    const runVideoLane = async (action, credits, runner) => {
      if (!workerConfigured) return e(503, 'provider_unavailable', 'No VideoLane server is configured (VIDEOLANE_SERVER_URL).')
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      try {
        const db = await loadDb()
        const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
        const dc = debitCredits(db, userId, credits, 'videolane', action, requestId)
        if (!dc.ok) return r(402, { ok: false, error: 'insufficient_credits', required: dc.required, available: dc.balance, meta: { requestId } })
        const result = await runner()
        db.usage_events.push({ user_id: userId, product: 'videolane', action, credits, metadata: {}, created_at: new Date().toISOString(), request_id: requestId })
        await saveDb(db)
        return r(200, ok({ ...result, usage: { credits, action, remaining: dc.balance } }, requestId))
      } catch (err) {
        return e(422, 'validation_error', err.message || 'videolane call failed')
      }
    }

    if (method === 'POST' && sub === '/plan') {
      const payload = jsonBody(body) || {}
      const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
      if (!prompt) return e(422, 'validation_error', 'prompt is required.')
      return runVideoLane('videolane.plan', 30, () => generateVideoPlan({
        prompt,
        style: payload.style,
        duration: payload.duration,
      }).then((result) => {
        if (!result.ok) throw new Error(result.error || 'Video plan generation failed.')
        return { ok: true, plan: result.plan }
      }))
    }
    if (method === 'POST' && sub === '/captions') {
      const payload = jsonBody(body) || {}
      const planPath = typeof payload.plan === 'string' ? payload.plan.trim() : ''
      if (!planPath) return e(422, 'validation_error', 'plan path is required.')
      return runVideoLane('videolane.captions', 10, () => generateCaptions(planPath))
    }
    if (method === 'POST' && sub === '/metadata') {
      const payload = jsonBody(body) || {}
      const title = typeof payload.title === 'string' ? payload.title.trim() : ''
      if (!title) return e(422, 'validation_error', 'title is required.')
      return runVideoLane('videolane.metadata', 10, () => generateMetadata(title, typeof payload.outDir === 'string' ? payload.outDir : undefined))
    }
    return e(404, 'not_found', `VideoLane route not found: ${method} ${path}`)
  }

  // ── Gateway (LLM gateway proxy) ───────────────────────────────────
  if (path.startsWith('/v1/gateway/')) {
    const sub = path.replace('/v1/gateway', '')
    const {
      loadGatewayConfig, getGatewayUsage, getLLMGatewayPricing, getLLMGatewayCapabilities,
      proxyChatCompletion, LLMGATEWAY_VERSION,
    } = await import('./gateway-engine.mjs')

    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      const config = loadGatewayConfig()
      return r(200, ok({ ok: true, service: 'llmgateway', version: LLMGATEWAY_VERSION, providerConfigured: Boolean(config), endpoints: getLLMGatewayCapabilities().endpoints }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') return r(200, ok(getLLMGatewayPricing(), requestId))
    if (method === 'GET' && sub === '/capabilities') return r(200, ok(getLLMGatewayCapabilities(), requestId))

    const charge = async (action, credits) => {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return { ok: false, response: e(auth.status, auth.code, auth.message) }
      const db = await loadDb()
      const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
      const dc = debitCredits(db, userId, credits, 'llmgateway', action, requestId)
      if (!dc.ok) return { ok: false, response: r(402, { ok: false, error: 'insufficient_credits', required: dc.required, available: dc.balance, meta: { requestId } }) }
      db.usage_events.push({ user_id: userId, product: 'llmgateway', action, credits, metadata: {}, created_at: new Date().toISOString(), request_id: requestId })
      await saveDb(db)
      return { ok: true, userId, remaining: dc.balance }
    }

    if (method === 'GET' && sub === '/models') {
      const charged = await charge('llmgateway.models', 1)
      if (!charged.ok) return charged.response
      const config = loadGatewayConfig()
      const models = config ? Array.from(new Set(config.providers.flatMap((p) => p.models))) : []
      return r(200, ok({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'llmgateway' })), usage: { credits: 1, action: 'llmgateway.models', remaining: charged.remaining } }, requestId))
    }
    if (method === 'GET' && sub === '/usage') {
      const charged = await charge('llmgateway.usage', 1)
      if (!charged.ok) return charged.response
      const result = getGatewayUsage(charged.userId)
      return r(200, ok({ object: 'usage', ...result, usage: { credits: 1, action: 'llmgateway.usage', remaining: charged.remaining } }, requestId))
    }
    if (method === 'POST' && sub === '/chat/completions') {
      const config = loadGatewayConfig()
      if (!config) return e(503, 'gateway_not_configured', 'No upstream LLM provider is configured (LLMGATEWAY_PROVIDERS).')
      const charged = await charge('llmgateway.chat', 10)
      if (!charged.ok) return charged.response
      const payload = jsonBody(body)
      if (!payload) return e(400, 'invalid_request', 'Request body is required')
      try {
        const result = await proxyChatCompletion({
          config,
          body: payload,
          projectId: charged.userId,
          apiKeyId: charged.userId,
        })
        let responsePayload = result.body
        try {
          responsePayload = JSON.parse(result.body)
        } catch { /* keep raw text */ }
        return r(result.status, ok(responsePayload, requestId))
      } catch (err) {
        return e(err instanceof Error && err.message.includes('model is required') ? 422 : 502, 'gateway_error', err.message || 'Upstream provider failed.')
      }
    }
    return e(404, 'not_found', `Gateway route not found: ${method} ${path}`)
  }

  // ── TraceLane / HandoffLane / StyleLane (thin edge) ──────────────
  if (path.startsWith('/v1/tracelane/')) {
    if (method === 'GET' && path.includes('/health')) return r(200, ok({ status: 'ok', service: 'tracelane', version: '0.1.0' }, requestId))
    return r(501, fail('not_deployed', 'TraceLane full engine pending monorepo function deploy. npm @talocode/tracelane works locally.', requestId))
  }
  if (path.startsWith('/v1/handofflane/')) {
    if (method === 'GET' && path.includes('/health')) return r(200, ok({ status: 'ok', service: 'handofflane', version: '0.1.0' }, requestId))
    return r(501, fail('not_deployed', 'HandoffLane full engine pending monorepo function deploy. npm @talocode/handofflane works locally.', requestId))
  }
  if (path.startsWith('/v1/stylelane/')) {
    if (method === 'GET' && path.includes('/health')) return r(200, ok({ status: 'ok', service: 'stylelane', version: '0.1.0' }, requestId))
    return r(501, fail('not_deployed', 'StyleLane full engine pending monorepo function deploy. npm @talocode/stylelane works locally.', requestId))
  }



  // ── DataLane (live deterministic engine) ──────────────────────────
  if (path.startsWith('/v1/datalane/')) {
    const {
      DATALANE_VERSION,
      buildDataLaneChart,
      buildDataLaneHtml,
      getDataLanePricing,
      getDataLaneCapabilities,
    } = await import('./datalane-engine.mjs')

    if (method === 'GET' && (path === '/v1/datalane/health' || path === '/v1/datalane/')) {
      return r(200, ok({ status: 'ok', service: 'datalane', version: DATALANE_VERSION, endpoints: getDataLaneCapabilities().endpoints }, requestId))
    }
    if (method === 'GET' && path === '/v1/datalane/pricing') {
      return r(200, ok(getDataLanePricing(), requestId))
    }
    if (method === 'GET' && path === '/v1/datalane/capabilities') {
      return r(200, ok(getDataLaneCapabilities(), requestId))
    }
    if (method === 'POST' && (path === '/v1/datalane/analyze' || path === '/v1/datalane/render')) {
      const isRenderPre = path.endsWith('/render')
      const creditsPre = isRenderPre ? 1 : 5
      const charged = await chargeCredits(headers, 'datalane', isRenderPre ? 'datalane.render' : 'datalane.analyze', creditsPre, requestId)
      if (!charged.ok) return e(charged.status, charged.code, charged.message)
      const payload = jsonBody(body)
      if (!payload) return e(400, 'invalid_request', 'Request body is required')

      const isRender = path.endsWith('/render')
      const credits = isRender ? 1 : 5

      let rows = Array.isArray(payload.rows) ? payload.rows : null
      let intent = typeof payload.intent === 'string' ? payload.intent : ''
      if (payload.csv && typeof payload.csv === 'string') {
        const { parseCsvRows } = await import('./datalane-engine.mjs')
        rows = parseCsvRows(payload.csv)
      }
      if (isRender) {
        if (!payload.spec || typeof payload.spec !== 'object') return e(400, 'invalid_request', 'spec is required')
        if (!rows) return e(400, 'invalid_request', 'rows array is required')
        const chart = buildDataLaneChart({ spec: payload.spec, rows })
        return r(200, ok({ artifact: buildDataLaneHtml(chart), chart, credits, note: 'Editable HTML artifact with embedded spec + data. Edit and re-render.' }, requestId))
      }
      if (!intent) return e(400, 'invalid_request', 'intent is required')
      if (!rows) return e(400, 'invalid_request', 'rows array is required')
      const chart = buildDataLaneChart({ intent, rows })
      return r(200, ok({ chart, credits, note: 'Spec + transformed rows returned. POST /v1/datalane/render with the spec to get the editable HTML artifact.' }, requestId))
    }
  }


  return e(404, 'not_found', `Unknown endpoint: ${method} ${path}`)
}

export async function handler(event) {
  const method = event.httpMethod || 'GET'
  const path = event.path || '/'
  const headers = event.headers || {}
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body) : null
  const queryParams = event.queryStringParameters || {}
  try {
    return await routeHandler(method, path, headers, body, queryParams)
  } catch (error) {
    console.error('[storage]', error instanceof Error ? error.message : 'unknown storage error')
    const requestId = makeRequestId()
    const origin = headers.origin || headers.Origin || ''
    return withCors(respond(503, fail('storage_unavailable', 'Persistent storage is temporarily unavailable.', requestId)), origin)
  }
}
