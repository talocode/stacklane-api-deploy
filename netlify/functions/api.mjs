import { randomUUID, randomBytes } from 'node:crypto'
import fs from 'node:fs'

const DB_PATH = '/tmp/stacklane-db.json'

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))
  } catch {
    const db = {
      users: [
        { id: 'user-admin-001', email: 'admin@stacklane.local', name: 'Admin', password: 'stacklane-admin', status: 'active', lastLoginAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ],
      sessions: {},
      api_keys: { 'sk-dev-talocode': 'user-admin-001' },
      profiles: { 'user-admin-001': { purchased_credits_balance: 1000, free_plan_credits_used: 0 } },
      usage_events: [],
    }
    saveDb(db)
    return db
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db))
}

function makeToken() {
  return randomBytes(32).toString('hex')
}

function makeRequestId() {
  return `sl_req_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function extractApiKey(headers) {
  const a = headers['authorization'] || headers['Authorization'] || ''
  if (a.startsWith('Bearer ')) return a.slice(7).trim()
  return headers['x-api-key'] || headers['X-Api-Key'] || null
}

function extractSession(headers) {
  const cookie = headers['cookie'] || headers['Cookie'] || ''
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === 'sl_session') return rest.join('=')
  }
  return null
}

function json(statusCode, data, extraHeaders) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(data) }
}

function corsHeaders(origin) {
  const allowed = ['https://stacklane.talocode.site', 'https://stacklane-web.netlify.app', origin].filter(Boolean)
  return {
    'Access-Control-Allow-Origin': allowed.find(o => o === origin) || 'https://stacklane.talocode.site',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, Cookie',
    'Vary': 'Origin',
  }
}

function withCors(result, origin) {
  if (result && result.headers) {
    Object.assign(result.headers, corsHeaders(origin))
  }
  return result
}

function normalizePath(p) {
  const prefix = '/.netlify/functions/api'
  if (p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  return p
}

async function routeHandler(method, rawPath, headers, body) {
  const path = normalizePath(rawPath)
  const requestId = makeRequestId()
  const origin = headers['origin'] || headers['Origin'] || ''

  function respond(status, data, extra) {
    return withCors(json(status, data, extra), origin)
  }

  function error(status, code, message) {
    return withCors(json(status, { error: { code, message, requestId } }), origin)
  }

  if (method === 'OPTIONS') {
    return withCors({ statusCode: 204, headers: {}, body: '' }, origin)
  }

  if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '' || path === '/health' || path === '/api/v1/health')) {
    return respond(200, { status: 'ok', service: 'stacklane-api', version: '0.1.0', requestId, timestamp: new Date().toISOString() })
  }

  if (method === 'GET' && path === '/api/v1/cloud/pricing') {
    return respond(200, {
      pricing: {
        tera_api: {
          'chat.completions': 3,
          'writing.rewrite': 5,
          'writing.draft': 10,
          'coding.explain': 10,
          'coding.review': 20,
          'coding.write': 20,
        },
      },
      requestId,
    })
  }

  // ─── Auth ────────────────────────────────────────────────────────

  if (method === 'POST' && path === '/auth/login') {
    let payload
    try { payload = typeof body === 'string' ? JSON.parse(body) : body } catch {
      return error(400, 'invalid_request', 'Invalid JSON body')
    }
    if (!payload.email || !payload.password) {
      return error(400, 'invalid_request', 'email and password are required')
    }

    const db = loadDb()
    const user = db.users.find(u => u.email === payload.email)
    if (!user || user.password !== payload.password) {
      return error(401, 'invalid_credentials', 'Invalid email or password')
    }

    const token = makeToken()
    db.sessions[token] = { userId: user.id, createdAt: new Date().toISOString() }
    user.lastLoginAt = new Date().toISOString()
    saveDb(db)

    const { password, ...safeUser } = user
    return withCors({
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `sl_session=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=86400`,
        ...corsHeaders(origin),
      },
      body: JSON.stringify({ data: safeUser, meta: { requestId } }),
    }, origin)
  }

  if (method === 'POST' && path === '/auth/logout') {
    const token = extractSession(headers)
    if (token) {
      const db = loadDb()
      delete db.sessions[token]
      saveDb(db)
    }
    return withCors({
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `sl_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`,
        ...corsHeaders(origin),
      },
      body: JSON.stringify({ data: { ok: true }, meta: { requestId } }),
    }, origin)
  }

  if (method === 'GET' && path === '/auth/me') {
    const token = extractSession(headers)
    if (!token) return error(401, 'not_authenticated', 'Not authenticated')

    const db = loadDb()
    const session = db.sessions[token]
    if (!session) return error(401, 'session_expired', 'Session expired')

    const user = db.users.find(u => u.id === session.userId)
    if (!user) return error(401, 'user_not_found', 'User not found')

    const { password, ...safeUser } = user
    return respond(200, { data: safeUser, meta: { requestId } })
  }

  // ─── Existing endpoints ──────────────────────────────────────────

  if (method !== 'POST') {
    return error(404, 'not_found', `Not found: ${method} ${path}`)
  }

  if (path === '/api/v1/cloud/usage/charge') {
    const apiKey = extractApiKey(headers)
    if (!apiKey) return error(401, 'missing_api_key', 'API key required')

    let payload
    try { payload = typeof body === 'string' ? JSON.parse(body) : body } catch {
      return error(400, 'invalid_request', 'Invalid JSON body')
    }

    if (!payload.action || !payload.credits) {
      return error(400, 'invalid_request', 'action and credits are required')
    }

    try {
      const db = loadDb()
      const userId = db.api_keys[apiKey]
      if (!userId) return error(401, 'invalid_api_key', 'Invalid or expired API key')

      const profile = db.profiles[userId]
      if (!profile) return error(402, 'insufficient_credits', 'No active subscription or credits found')

      const totalCredits = profile.purchased_credits_balance || 0
      if (totalCredits < payload.credits) {
        return error(402, 'insufficient_credits', `Insufficient credits. Required: ${payload.credits}, Balance: ${totalCredits}`)
      }

      profile.purchased_credits_balance -= payload.credits
      db.usage_events.push({
        user_id: userId,
        product: payload.product || 'tera_api',
        action: payload.action,
        credits: payload.credits,
        metadata: payload.metadata || {},
        created_at: new Date().toISOString(),
      })
      saveDb(db)

      return respond(200, {
        data: { ok: true, event: { credits: payload.credits, status: 'charged', product: payload.product, action: payload.action, requestId } },
        meta: { requestId },
      })
    } catch (err) {
      return error(503, 'billing_unavailable', 'Billing service error: ' + err.message)
    }
  }

  return error(404, 'not_found', `Unknown endpoint: ${path}`)
}

export async function handler(event) {
  const method = event.httpMethod || 'GET'
  const path = event.path || '/'
  const headers = event.headers || {}
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body) : null
  return await routeHandler(method, path, headers, body)
}
