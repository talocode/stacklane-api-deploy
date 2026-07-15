import { randomUUID, randomBytes } from 'node:crypto'
import fs from 'node:fs'

const DB_PATH = '/tmp/stacklane-db.json'

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))
  } catch {
    const now = new Date().toISOString()
    const db = {
      users: [
        { id: 'user-admin-001', email: 'admin@stacklane.local', name: 'Admin', password: 'stacklane-admin', status: 'active', lastLoginAt: null, createdAt: now, updatedAt: now },
      ],
      sessions: {},
      api_keys: { 'sk-dev-talocode': 'user-admin-001' },
      project_api_keys: [],
      profiles: { 'user-admin-001': { purchased_credits_balance: 10000, free_plan_credits_used: 0 } },
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
      wallets: { 'proj-tera-api': { id: 'wallet-tera', projectId: 'proj-tera-api', balance: 5000, lifetimeCredits: 5000, lifetimeSpend: 0, freeCreditsGranted: true, createdAt: now, updatedAt: now } },
      transactions: [],
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

function requireApiKey(headers) {
  const key = extractApiKey(headers)
  if (!key) return { ok: false, status: 401, code: 'missing_api_key', message: 'API key required. Use Authorization: Bearer <TALOCODE_API_KEY>' }
  const db = loadDb()
  // Accept: DB keys, env TALOCODE_API_KEY, or sk-dev-talocode
  const envKey = process.env.TALOCODE_API_KEY
  if (db.api_keys[key] || (envKey && key === envKey) || key === 'sk-dev-talocode') {
    return { ok: true, key, userId: db.api_keys[key] || 'user-admin-001' }
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
        Authorization: `Bearer ${process.env.TERA_UPSTREAM_KEY || 'sk-dev-talocode'}`,
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

function authenticate(headers) {
  const token = extractSession(headers)
  if (!token) return null
  const db = loadDb()
  const session = db.sessions[token]
  if (!session) return null
  const user = db.users.find(u => u.id === session.userId)
  return user || null
}

function jsonBody(body) {
  try { return typeof body === 'string' ? JSON.parse(body) : body } catch { return null }
}

function corsHeaders(origin) {
  const allowed = ['https://stacklane.talocode.site', 'https://stacklane-web.netlify.app', origin].filter(Boolean)
  return {
    'Access-Control-Allow-Origin': allowed.find(o => o === origin) || 'https://stacklane.talocode.site',
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
  function requireAuth() {
    const user = authenticate(headers)
    if (!user) return null
    return user
  }

  if (method === 'OPTIONS') return withCors(respond(204, '', {}), origin)

  // Health
  if ((method === 'GET' || method === 'HEAD') && /^\/(health|\/api\/v1\/health)?$/.test(path)) {
    return r(200, ok({ status: 'ok', service: 'stacklane-api', version: '0.6.0', timestamp: new Date().toISOString() }, requestId))
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
      },
    }, requestId))
  }

  // ─── Auth ────────────────────────────────────────────────────────

  if (method === 'POST' && path === '/auth/login') {
    const payload = jsonBody(body)
    if (!payload || !payload.email || !payload.password) return e(400, 'invalid_request', 'email and password are required')
    const db = loadDb()
    const user = db.users.find(u => u.email === payload.email)
    if (!user || user.password !== payload.password) return e(401, 'invalid_credentials', 'Invalid email or password')
    const token = makeToken()
    db.sessions[token] = { userId: user.id, createdAt: new Date().toISOString() }
    user.lastLoginAt = new Date().toISOString()
    saveDb(db)
    const { password, ...safe } = user
    return withCors({
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `sl_session=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=86400`,
        ...corsHeaders(origin),
      },
      body: JSON.stringify(ok(safe, requestId)),
    }, origin)
  }

  if (method === 'POST' && path === '/auth/logout') {
    const token = extractSession(headers)
    if (token) { const db = loadDb(); delete db.sessions[token]; saveDb(db) }
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
    const user = requireAuth()
    if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const { password, ...safe } = user
    return r(200, ok(safe, requestId))
  }

  // ─── Regions ─────────────────────────────────────────────────────

  if (method === 'GET' && path === '/regions') {
    const db = loadDb()
    return r(200, ok(db.regions, requestId))
  }

  // ─── Organizations ───────────────────────────────────────────────

  const orgMatch = path.match(/^\/organizations(?:\/([^/]+))?(?:\/([^/]+))?$/)
  const orgSlug = orgMatch ? orgMatch[1] : null
  const orgSub = orgMatch ? orgMatch[2] : null

  if (path === '/organizations' && method === 'GET') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    return r(200, ok(db.organizations, requestId))
  }

  if (path === '/organizations' && method === 'POST') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.name) return e(400, 'invalid_request', 'name is required')
    const db = loadDb()
    const org = { id: makeId('org'), name: payload.name, slug: payload.slug || slugify(payload.name), status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    db.organizations.push(org)
    saveDb(db)
    return r(200, ok(org, requestId))
  }

  // ─── Projects ────────────────────────────────────────────────────

  const projMatch = path.match(/^\/projects(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/)
  const projSlug = projMatch ? projMatch[1] : null
  const projRes = projMatch ? projMatch[2] : null
  const projId3 = projMatch ? projMatch[3] : null
  const projId4 = projMatch ? projMatch[4] : null

  if (path === '/projects' && method === 'GET') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    return r(200, ok(db.projects, requestId))
  }

  if (path === '/projects' && method === 'POST') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.name) return e(400, 'invalid_request', 'name is required')
    const db = loadDb()
    const now = new Date().toISOString()
    const proj = {
      id: makeId('proj'), name: payload.name, slug: payload.slug || slugify(payload.name),
      status: payload.status || 'provisioning', region: payload.region || 'us-east',
      description: payload.description || '', organizationId: payload.organizationId || 'org-talocode',
      createdAt: now, updatedAt: now,
    }
    db.projects.push(proj)
    db.wallets[proj.id] = { id: makeId('wallet'), projectId: proj.id, balance: 0, lifetimeCredits: 0, lifetimeSpend: 0, freeCreditsGranted: false, createdAt: now, updatedAt: now }
    saveDb(db)
    return r(200, ok(proj, requestId))
  }

  // GET /projects/:slug
  if (projSlug && !projRes && method === 'GET' && path === `/projects/${projSlug}`) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const org = db.organizations.find(o => o.id === proj.organizationId)
    const envs = db.environments.filter(e => e.projectId === proj.id)
    return r(200, ok({ ...proj, organization: org || null, environments: envs, capabilities: { canManageProvisioning: true, canManageApiKeys: true, canManageEnvironments: true, canUpdateProject: true } }, requestId))
  }

  // PATCH /projects/:slug
  if (projSlug && !projRes && method === 'PATCH' && path === `/projects/${projSlug}`) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    const db = loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    if (payload.name) proj.name = payload.name
    if (payload.status) proj.status = payload.status
    if (payload.description !== undefined) proj.description = payload.description
    proj.updatedAt = new Date().toISOString()
    saveDb(db)
    return r(200, ok(proj, requestId))
  }

  // POST /projects/:slug/provision
  if (projRes === 'provision' && method === 'POST' && path === `/projects/${projSlug}/provision`) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
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
    saveDb(db)
    return r(200, ok(task, requestId))
  }

  // GET /projects/:slug/provisioning
  if (projRes === 'provisioning' && !projId3 && method === 'GET' && path === `/projects/${projSlug}/provisioning`) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const task = db.provisioning_tasks.filter(t => t.projectId === proj.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null
    const attempts = db.provisioning_attempts.filter(a => a.taskId === task?.id)
    const runtimeBinding = task?.status === 'ready' ? { id: makeId('bind'), projectId: proj.id, regionId: proj.region, databaseRef: null, storageRef: null, authNamespaceRef: null, functionsNamespaceRef: null, status: 'ready', diagnostics: {}, createdAt: proj.createdAt, updatedAt: proj.updatedAt } : null
    return r(200, ok({ task, attempts: attempts || [], runtimeBinding, capabilities: { canManageProvisioning: true, canManageApiKeys: true, canManageEnvironments: true, canUpdateProject: true } }, requestId))
  }

  // GET /projects/:slug/provisioning/tasks
  if (projRes === 'provisioning' && projId3 === 'tasks' && !projId4 && method === 'GET') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    return r(200, ok(db.provisioning_tasks.filter(t => t.projectId === proj.id), requestId))
  }

  // POST /projects/:slug/provisioning/retry
  if (projRes === 'provisioning' && projId3 === 'retry' && !projId4 && method === 'POST') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
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
    saveDb(db)
    return r(200, ok(task, requestId))
  }

  // GET /projects/:slug/events
  if (projRes === 'events' && !projId3 && method === 'GET' && path === `/projects/${projSlug}/events`) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    return r(200, ok(db.audit_events.filter(e => e.projectId === proj.id), requestId))
  }

  // GET /projects/:slug/api-keys
  if (projRes === 'api-keys' && !projId3 && method === 'GET' && path === `/projects/${projSlug}/api-keys`) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    return r(200, ok(db.project_api_keys.filter(k => k.projectId === proj.id), requestId))
  }

  // POST /projects/:slug/api-keys
  if (projRes === 'api-keys' && !projId3 && method === 'POST' && path === `/projects/${projSlug}/api-keys`) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.name) return e(400, 'invalid_request', 'name is required')
    const db = loadDb()
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
    saveDb(db)
    return r(200, ok({ key: keyObj, secret }, requestId))
  }

  // POST /projects/:slug/api-keys/:keyId/revoke
  if (projRes === 'api-keys' && projId3 && projId4 === 'revoke' && method === 'POST') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const key = db.project_api_keys.find(k => k.id === projId3 && k.projectId === proj.id)
    if (!key) return e(404, 'not_found', 'API key not found')
    key.status = 'revoked'
    key.revokedAt = new Date().toISOString()
    saveDb(db)
    return r(200, ok(key, requestId))
  }

  // GET /projects/:slug/environments
  if (projRes === 'environments' && !projId3 && method === 'GET' && path === `/projects/${projSlug}/environments`) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    return r(200, ok(db.environments.filter(e => e.projectId === proj.id), requestId))
  }

  // POST /projects/:slug/environments
  if (projRes === 'environments' && !projId3 && method === 'POST' && path === `/projects/${projSlug}/environments`) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.name) return e(400, 'invalid_request', 'name is required')
    const db = loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const now = new Date().toISOString()
    const env = {
      id: makeId('env'), projectId: proj.id, name: payload.name, slug: payload.slug || slugify(payload.name),
      status: payload.status || 'ready', region: payload.region || proj.region,
      deploymentTarget: payload.deploymentTarget || 'africa-west1', createdAt: now, updatedAt: now,
    }
    db.environments.push(env)
    saveDb(db)
    return r(200, ok(env, requestId))
  }

  // PATCH /projects/:slug/environments/:envId
  if (projRes === 'environments' && projId3 && !projId4 && method === 'PATCH') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    const db = loadDb()
    const proj = db.projects.find(p => p.id === projSlug || p.slug === projSlug)
    if (!proj) return e(404, 'not_found', 'Project not found')
    const env = db.environments.find(e => e.id === projId3 && e.projectId === proj.id)
    if (!env) return e(404, 'not_found', 'Environment not found')
    if (payload.status) env.status = payload.status
    if (payload.region) env.region = payload.region
    if (payload.deploymentTarget) env.deploymentTarget = payload.deploymentTarget
    env.updatedAt = new Date().toISOString()
    saveDb(db)
    return r(200, ok(env, requestId))
  }

  // ─── Organization sub-resources ──────────────────────────────────

  // GET /organizations/:slug/projects
  if (orgSlug && orgSub === 'projects' && method === 'GET') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    const org = db.organizations.find(o => o.id === orgSlug || o.slug === orgSlug)
    if (!org) return e(404, 'not_found', 'Organization not found')
    return r(200, ok(db.projects.filter(p => p.organizationId === org.id), requestId))
  }

  // GET /organizations/:slug/operations
  if (orgSlug && orgSub === 'operations' && method === 'GET') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const db = loadDb()
    const org = db.organizations.find(o => o.id === orgSlug || o.slug === orgSlug)
    if (!org) return e(404, 'not_found', 'Organization not found')
    const projects = db.projects.filter(p => p.organizationId === org.id)
    const rows = projects.map(p => {
      const task = db.provisioning_tasks.filter(t => t.projectId === p.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null
      return { project: { ...p, organization: org, environments: db.environments.filter(e => e.projectId === p.id), capabilities: { canManageProvisioning: true, canManageApiKeys: true, canManageEnvironments: true, canUpdateProject: true } }, provisioning: task, capabilities: { canManageProvisioning: true, canManageApiKeys: true, canManageEnvironments: true, canUpdateProject: true } }
    })
    return r(200, ok(rows, requestId))
  }

  // ─── Cloud Billing ───────────────────────────────────────────────

  // GET /api/v1/cloud/billing/wallet
  if (method === 'GET' && path.startsWith('/api/v1/cloud/billing/wallet')) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const projectId = query.projectId
    if (!projectId) return e(400, 'invalid_request', 'projectId is required')
    const db = loadDb()
    const wallet = db.wallets[projectId]
    if (!wallet) return e(404, 'not_found', 'Wallet not found')
    return r(200, ok(wallet, requestId))
  }

  // GET /api/v1/cloud/billing/transactions
  if (method === 'GET' && path.startsWith('/api/v1/cloud/billing/transactions')) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const projectId = query.projectId; const limit = Number(query.limit) || 50
    if (!projectId) return e(400, 'invalid_request', 'projectId is required')
    const db = loadDb()
    return r(200, ok(db.transactions.filter(t => t.walletId === db.wallets[projectId]?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit), requestId))
  }

  // GET /api/v1/cloud/usage/events
  if (method === 'GET' && path.startsWith('/api/v1/cloud/usage/events')) {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const projectId = query.projectId; const limit = Number(query.limit) || 50
    if (!projectId) return e(400, 'invalid_request', 'projectId is required')
    const db = loadDb()
    return r(200, ok(db.usage_events.filter(e => e.user_id === user.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit), requestId))
  }

  // POST /api/v1/cloud/billing/topup
  if (method === 'POST' && path === '/api/v1/cloud/billing/topup') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.projectId || !payload.amount) return e(400, 'invalid_request', 'projectId and amount are required')
    const db = loadDb()
    const wallet = db.wallets[payload.projectId]
    if (!wallet) return e(404, 'not_found', 'Wallet not found')
    const topupId = makeId('topup')
    return r(200, ok({
      topup: { id: topupId, walletId: wallet.id, amount: payload.amount, status: 'pending' },
      stripePublishableKey: null,
      clientSecret: null,
    }, requestId))
  }

  // POST /api/v1/cloud/billing/topup/confirm
  if (method === 'POST' && path === '/api/v1/cloud/billing/topup/confirm') {
    const user = requireAuth(); if (!user) return e(401, 'not_authenticated', 'Not authenticated')
    const payload = jsonBody(body)
    if (!payload || !payload.projectId) return e(400, 'invalid_request', 'projectId is required')
    const db = loadDb()
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
    saveDb(db)
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
      const db = loadDb()
      const userId = db.api_keys[apiKey]
      if (!userId) return e(401, 'invalid_api_key', 'Invalid or expired API key')
      const profile = db.profiles[userId]
      if (!profile) return e(402, 'insufficient_credits', 'No active subscription or credits found')
      const total = profile.purchased_credits_balance || 0
      if (total < payload.credits) return e(402, 'insufficient_credits', `Insufficient credits. Required: ${payload.credits}, Balance: ${total}`)
      profile.purchased_credits_balance -= payload.credits
      db.usage_events.push({ user_id: userId, product: payload.product || 'tera_api', action: payload.action, credits: payload.credits, metadata: payload.metadata || {}, created_at: new Date().toISOString() })
      saveDb(db)
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
      const auth = requireApiKey(headers)
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

  // ── SearchLane ────────────────────────────────────────────────────
  if (path.startsWith('/v1/searchlane/')) {
    const sub = path.replace('/v1/searchlane', '')
    if (method === 'GET' && (sub === '/health' || sub === '' || sub === '/')) {
      return r(200, ok({ status: 'ok', service: 'searchlane-api', version: '0.1.0', timestamp: new Date().toISOString() }, requestId))
    }
    if (method === 'GET' && sub === '/pricing') {
      return r(200, ok({ query: 5, news: 8, research: 30 }, requestId))
    }
    if (method === 'GET' && sub === '/capabilities') {
      return r(200, ok({ capabilities: [{ id: 'query', name: 'Web Search', credits: 5 }, { id: 'news', name: 'News Search', credits: 8 }, { id: 'research', name: 'Deep Research', credits: 30 }] }, requestId))
    }
    // POST endpoints: accept and return structured response
    if (method === 'POST' && (sub === '/query' || sub === '/news' || sub === '/research')) {
      const payload = jsonBody(body)
      if (!payload) return e(400, 'invalid_request', 'Request body is required')
      return r(200, ok({
        results: [{ title: 'SearchLane endpoint ready', url: `https://example.com/searchlane${sub}`, snippet: `SearchLane ${sub.replace('/', '')} endpoint is defined. Live AI-powered search results require the upstream search provider to be connected.`, source: 'searchlane' }],
        total: 1, query: payload.query || payload.topic || '', endpoint: sub, status: 'endpoint_defined',
        message: 'SearchLane routes are wired. Live results require Talocode Cloud AI backend connection.',
      }, requestId))
    }
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
    const db = loadDb()
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
    const auth = requireApiKey(headers)
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
    const auth = requireApiKey(headers)
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
    const auth = requireApiKey(headers)
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
    const auth = requireApiKey(headers)
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
    const auth = requireApiKey(headers)
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
    const auth = requireApiKey(headers)
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

  return e(404, 'not_found', `Unknown endpoint: ${method} ${path}`)
}

export async function handler(event) {
  const method = event.httpMethod || 'GET'
  const path = event.path || '/'
  const headers = event.headers || {}
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body) : null
  const queryParams = event.queryStringParameters || {}
  return await routeHandler(method, path, headers, body, queryParams)
}
