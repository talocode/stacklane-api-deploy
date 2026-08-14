import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import pg from 'pg'

const DB_PATH = '/tmp/stacklane-db.json'
const BLOB_STORE = 'stacklane-cloud'
const BLOB_KEY = 'main-db'
const { Pool } = pg

/** @type {any} */
let dbCache = null
let pool = null
let postgresReady = null

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

async function ensurePostgres() {
  if (!postgresReady) {
    postgresReady = (async () => {
      const client = await getPool().connect()
      try {
        await client.query('SELECT 1 FROM stacklane.users LIMIT 1')
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
      users: users.rows.map((row) => ({ id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash, status: row.status, lastLoginAt: row.last_login_at, createdAt: row.created_at, updatedAt: row.updated_at })),
      sessions: Object.fromEntries(sessions.rows.map((row) => [row.token_hash, { userId: row.user_id, createdAt: row.created_at }])),
      cloud_projects: projects.rows.map((row) => ({ id: row.id, ownerId: row.owner_id, name: row.name, slug: row.slug, createdAt: row.created_at, updatedAt: row.updated_at })),
      cloud_api_keys: keys.rows.map((row) => ({ id: row.id, projectId: row.project_id, userId: row.user_id, name: row.name, prefix: row.prefix, keyHash: row.key_hash, mode: row.mode, status: row.status, lastUsedAt: row.last_used_at, createdAt: row.created_at, updatedAt: row.updated_at })),
      api_keys: Object.fromEntries(keys.rows.filter((row) => row.status === 'active').map((row) => [`sha256:${row.key_hash}`, row.user_id])),
      wallets: Object.fromEntries(wallets.rows.map((row) => [row.project_id, { id: row.id, projectId: row.project_id, balance: row.balance_credits, lifetimeCredits: row.lifetime_credits, lifetimeSpend: row.lifetime_spend, freeCreditsGranted: row.free_credits_granted, createdAt: row.created_at, updatedAt: row.updated_at }])),
      transactions: transactions.rows.map((row) => ({ id: row.id, walletId: row.wallet_id, type: row.type, creditsDelta: row.credits_delta, balanceAfter: row.balance_after, reference: row.reference, metadata: row.metadata, createdAt: row.created_at })),
      usage_events: usageEvents.rows.map((row) => ({ id: row.id, project_id: row.project_id, user_id: row.user_id, api_key_id: row.api_key_id, product: row.product, action: row.action, credits: row.credits, status: row.status, metadata: row.metadata, created_at: row.created_at })),
      topups: topups.rows.map((row) => ({ id: row.id, projectId: row.project_id, credits: row.credits, amountUsd: Number(row.amount_usd), status: row.status, provider: row.provider, createdAt: row.created_at, updatedAt: row.updated_at })),
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

async function providerChat(messages, model) {
  // Prefer Mistral when configured; otherwise deterministic mock for smoke tests
  const mistral = process.env.MISTRAL_API_KEY
  if (mistral) {
    const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mistral}` },
      body: JSON.stringify({
        model: model || process.env.TERA_API_MODEL || 'mistral-small-latest',
        messages,
        temperature: 0.3,
        max_tokens: 2000,
      }),
    })
    if (!r.ok) throw new Error(`provider ${r.status}`)
    return await r.json()
  }
  // Proxy to live Tera API (accepts any bearer and mocks without MISTRAL)
  try {
    const r = await fetch('https://api.teraai.chat/v1/tera/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.TERA_UPSTREAM_KEY || ''}`,
      },
      body: JSON.stringify({ model: model || 'default', messages }),
    })
    const text = await r.text()
    try { return JSON.parse(text) } catch { return { raw: text, status: r.status } }
  } catch (err) {
    const last = messages?.[messages.length - 1]?.content || ''
    return {
      id: 'mock_chat',
      object: 'chat.completion',
      model: model || 'mock',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: `ScreenLane cloud mock: received ${String(last).slice(0, 200)}` },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }
  }
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

  if (method === 'OPTIONS') return withCors(respond(204, '', {}), origin)

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
    return r(200, ok(db.projects, requestId))
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
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
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
    const wallet = db.wallets[projectId]
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
    return r(200, ok(db.transactions.filter(t => t.walletId === db.wallets[projectId]?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit), requestId))
  }

  // GET /api/v1/cloud/usage/events
  if (method === 'GET' && path.startsWith('/api/v1/cloud/usage/events')) {
    const user = await requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const projectId = query.projectId; const limit = Number(query.limit) || 50
    if (!projectId) return e(400, 'invalid_request', 'projectId is required')
    const db = await loadDb()
    return r(200, ok(db.usage_events.filter(e => e.user_id === user.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit), requestId))
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
    if (secret && sig) {
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
    if (!topup || topup.status === 'succeeded') {
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
      const profile = db.profiles[userId]
      if (!profile) return e(402, 'insufficient_credits', 'No active subscription or credits found')
      const total = profile.purchased_credits_balance || 0
      if (total < payload.credits) return e(402, 'insufficient_credits', `Insufficient credits. Required: ${payload.credits}, Balance: ${total}`)
      profile.purchased_credits_balance -= payload.credits
      db.usage_events.push({ user_id: userId, product: payload.product || 'tera_api', action: payload.action, credits: payload.credits, metadata: payload.metadata || {}, created_at: new Date().toISOString() })
      await saveDb(db)
      return r(200, ok({ ok: true, event: { credits: payload.credits, status: 'charged', product: payload.product, action: payload.action, requestId } }, requestId))
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
    // POST endpoints → require TALOCODE_API_KEY, then provider/proxy
    if (method === 'POST' && (sub === '/chat/completions' || sub === '/writing/rewrite' || sub === '/writing/draft' || sub === '/coding/explain' || sub === '/coding/review' || sub === '/coding/write')) {
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      const payload = jsonBody(body)
      if (!payload) return e(400, 'invalid_request', 'Request body is required')
      if (sub === '/chat/completions') {
        if (!Array.isArray(payload.messages) || !payload.messages.length) {
          return e(400, 'invalid_request', 'messages array required')
        }
        try {
          const result = await providerChat(payload.messages, payload.model)
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
      const payload = jsonBody(body)
      if (!payload) return e(400, 'invalid_request', 'Request body is required')
      return r(200, ok({ status: 'generated', skill: { name: payload.input || 'custom-skill', format: sub.includes('export') ? sub.split('/').pop() : 'SKILL.md', compatibleWith: ['Cursor', 'Claude Code', 'OpenCode', 'Codra'], credits: sub.includes('github-profile') ? 80 : sub.includes('github-repo') ? 100 : sub.includes('docs') ? 100 : sub.includes('text') ? 40 : sub.includes('export') ? 10 : 0 }, message: 'Skill generation is live when Talocode Cloud AI backends are connected. This endpoint is defined and ready.' }, requestId))
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
      const auth = await requireApiKey(headers)
      if (!auth.ok) return e(auth.status, auth.code, auth.message)
      const payload = jsonBody(body) || {}
      const query = typeof payload.query === 'string' ? payload.query.trim()
        : typeof payload.q === 'string' ? payload.q.trim() : ''
      if (!query) return e(422, 'validation_error', 'query is required')
      const limit = typeof payload.limit === 'number' ? payload.limit : undefined
      const creditMap = { '/query': 5, '/news': 8, '/research': 30 }
      const actionMap = { '/query': 'searchlane.query', '/news': 'searchlane.news', '/research': 'searchlane.research' }
      const credits = creditMap[sub]
      const action = actionMap[sub]
      // Charge profile credits (JSON store)
      try {
        const db = await loadDb()
        const userId = auth.userId || db.api_keys[`sha256:${hashApiKey(auth.key)}`] || 'user-admin-001'
        const profile = db.profiles[userId] || (db.profiles[userId] = { purchased_credits_balance: 10000, free_plan_credits_used: 0 })
        const bal = profile.purchased_credits_balance || 0
        if (bal < credits) {
          return r(402, { ok: false, error: 'insufficient_credits', required: credits, available: bal, meta: { requestId } })
        }
        profile.purchased_credits_balance = bal - credits
        db.usage_events.push({
          user_id: userId, product: 'searchlane', action, credits,
          metadata: { query, limit }, created_at: new Date().toISOString(), request_id: requestId,
        })
        await saveDb(db)
        let result
        if (sub === '/query') result = await runSearchQuery(query, { limit })
        else if (sub === '/news') result = await runSearchNews(query, { limit })
        else result = await runResearch(query, { limit, fetchPages: payload.fetchPages !== false })
        return r(200, {
          ...result,
          usage: { credits, action, remaining: profile.purchased_credits_balance },
          meta: { requestId },
        })
      } catch (err) {
        return e(422, 'search_error', err.message || 'Search failed')
      }
    }
    return e(404, 'not_found', `SearchLane route not found: ${method} ${path}`)
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
        const profile = db.profiles[userId] || (db.profiles[userId] = { purchased_credits_balance: 10000, free_plan_credits_used: 0 })
        const balance = profile.purchased_credits_balance || 0
        if (balance < credits) return r(402, { ok: false, error: 'insufficient_credits', required: credits, available: balance, meta: { requestId } })
        const result = await transcribe(payload)
        profile.purchased_credits_balance = balance - credits
        const action = timestamps === 'none' ? 'audiolane.transcription' : 'audiolane.transcription.timestamps'
        db.usage_events.push({ user_id: userId, product: 'audiolane', action, credits, metadata: { mimeType: payload.mimeType, timestamps, source: payload.audioUrl ? 'url' : 'base64' }, created_at: new Date().toISOString(), request_id: requestId })
        await saveDb(db)
        return r(200, { ...result, usage: { credits, action, remaining: profile.purchased_credits_balance }, meta: { requestId } })
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
        const profile = db.profiles[userId] || (db.profiles[userId] = { purchased_credits_balance: 10000, free_plan_credits_used: 0 })
        const bal = profile.purchased_credits_balance || 0
        if (bal < credits) {
          return r(402, { ok: false, error: 'insufficient_credits', required: credits, available: bal, meta: { requestId } })
        }
        profile.purchased_credits_balance = bal - credits
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
            usage: { credits, action, remaining: profile.purchased_credits_balance },
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
          usage: { credits, action, remaining: profile.purchased_credits_balance },
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
  if (path === '/mcp' && method === 'POST') {
    const payload = jsonBody(body)
    if (!payload) return e(400, 'invalid_request', 'MCP request body required')
    return r(200, ok({
      mcp: { serverInfo: { name: 'stacklane-mcp', version: '0.1.0' }, tools: [] },
      message: 'Stacklane MCP endpoint is wired. Full MCP tool definitions are available when product services are connected.',
    }, requestId))
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
  if (method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/router/chat/completions' || path === '/v1/tera/chat/completions')) {
    const auth = await requireApiKey(headers)
    if (!auth.ok) return e(auth.status, auth.code, auth.message)
    const payload = jsonBody(body) || {}
    const messages = payload.messages
    if (!Array.isArray(messages) || !messages.length) return e(400, 'invalid_request', 'messages array required')
    try {
      const result = await providerChat(messages, payload.model)
      // Normalize OpenAI-ish shape
      if (result?.result?.choices) {
        return r(200, {
          id: result.id || requestId,
          object: 'chat.completion',
          choices: result.result.choices,
          usage: result.result.usage || result.usage,
          meta: { requestId, source: 'talocode-cloud', keyUser: auth.userId },
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
    const auth = await requireApiKey(headers)
    if (!auth.ok) return e(auth.status, auth.code, auth.message)
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
    const auth = await requireApiKey(headers)
    if (!auth.ok) return e(auth.status, auth.code, auth.message)
    const payload = jsonBody(body) || {}
    return r(200, ok({
      allowed: true,
      tool: payload.tool || 'screenlane.command',
      input: payload.input || {},
      message: 'GateLane accepted call (policy default allow for ScreenLane).',
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
    const auth = await requireApiKey(headers)
    if (!auth.ok) return e(auth.status, auth.code, auth.message)
    const payload = jsonBody(body) || {}
    const text = payload.text || payload.commandText || payload.prompt || ''
    if (!text) return e(400, 'invalid_request', 'text required')
    // Reuse chat completions for cloud execution
    try {
      const result = await providerChat([
        { role: 'user', content: text },
      ])
      return r(200, ok({ sent: true, result, target: payload.target || 'cloud' }, requestId))
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


  // ── VerifyLane / TraceLane / HandoffLane / StyleLane / SpendCaps (thin edge) ──
  if (path.startsWith('/v1/verifylane/')) {
    const sub = path.replace('/v1/verifylane', '')
    if (method === 'GET' && (sub === '/health' || sub === '/pricing' || sub === '/capabilities')) {
      return r(200, ok({ status: 'ok', service: 'verifylane', version: '0.1.0', note: 'Full engine on Stacklane monorepo deploy; edge stub health/pricing' }, requestId))
    }
    if (method === 'POST') {
      return r(501, fail('not_deployed', 'VerifyLane engine requires Stacklane monorepo function bundle with services/verifylane. Use npm @talocode/verifylane local engine until redeploy.', requestId))
    }
  }
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
  if (path.startsWith('/v1/spendcaps/')) {
    if (method === 'GET') return r(200, ok({ status: 'ok', service: 'spendcaps', version: '0.1.0', note: 'Full caps on monorepo deploy' }, requestId))
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
