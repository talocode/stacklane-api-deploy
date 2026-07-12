import { randomUUID } from 'node:crypto'
import initSqlJs from 'sql.js'
import fs from 'node:fs'
import path from 'node:path'

export const config = {
  path: '/*',
  preferStatic: true,
}

const DB_PATH = '/tmp/stacklane.db'

let db

async function getDb() {
  if (db) return db
  const SQL = await initSqlJs()
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
  } else {
    db = new SQL.Database()
    db.run(`
      CREATE TABLE api_keys (
        key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        purchased_credits_balance INTEGER DEFAULT 0,
        free_plan_credits_used INTEGER DEFAULT 0
      );
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        product TEXT NOT NULL,
        action TEXT NOT NULL,
        credits INTEGER NOT NULL,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `)
    // Seed a dev API key
    db.run("INSERT OR IGNORE INTO api_keys (key, user_id) VALUES ('sk-dev-talocode', 'user-dev-001')")
    db.run("INSERT OR IGNORE INTO profiles (id, purchased_credits_balance) VALUES ('user-dev-001', 1000)")
    saveDb()
  }
  return db
}

function saveDb() {
  const data = db.export()
  const buffer = Buffer.from(data)
  fs.writeFileSync(DB_PATH, buffer)
}

function json(statusCode, data, extraHeaders) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(data) }
}

function makeRequestId() {
  return `sl_req_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function extractApiKey(headers) {
  const auth = headers['authorization'] || headers['Authorization'] || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return headers['x-api-key'] || headers['X-Api-Key'] || null
}

async function routeHandler(method, path, headers, body) {
  const requestId = makeRequestId()

  if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '/health' || path === '/api/v1/health')) {
    return json(200, { status: 'ok', service: 'stacklane-api', version: '0.1.0', requestId, timestamp: new Date().toISOString() })
  }

  if (method === 'GET' && path === '/api/v1/cloud/pricing') {
    return json(200, {
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

  if (method !== 'POST') return json(404, { error: { code: 'not_found', message: 'Not found', requestId } })

  if (path === '/api/v1/cloud/usage/charge') {
    const apiKey = extractApiKey(headers)
    if (!apiKey) return json(401, { error: { code: 'missing_api_key', message: 'API key required', requestId } })

    let payload
    try { payload = typeof body === 'string' ? JSON.parse(body) : body } catch {
      return json(400, { error: { code: 'invalid_request', message: 'Invalid JSON body', requestId } })
    }

    if (!payload.action || !payload.credits) {
      return json(400, { error: { code: 'invalid_request', message: 'action and credits are required', requestId } })
    }

    try {
      const database = await getDb()

      const userResult = database.exec(
        'SELECT user_id FROM api_keys WHERE key = ? LIMIT 1',
        [apiKey]
      )
      if (!userResult.length || !userResult[0].values.length) {
        return json(401, { error: { code: 'invalid_api_key', message: 'Invalid or expired API key', requestId } })
      }
      const userId = userResult[0].values[0][0]

      const profileResult = database.exec(
        'SELECT purchased_credits_balance FROM profiles WHERE id = ? LIMIT 1',
        [userId]
      )
      if (!profileResult.length || !profileResult[0].values.length) {
        return json(402, { error: { code: 'insufficient_credits', message: 'No active subscription or credits found', requestId } })
      }
      const totalCredits = profileResult[0].values[0][0] || 0
      if (totalCredits < payload.credits) {
        return json(402, { error: { code: 'insufficient_credits', message: `Insufficient credits. Required: ${payload.credits}, Balance: ${totalCredits}`, requestId } })
      }

      database.run('UPDATE profiles SET purchased_credits_balance = purchased_credits_balance - ? WHERE id = ?', [payload.credits, userId])

      database.run(
        'INSERT INTO usage_events (user_id, product, action, credits, metadata) VALUES (?, ?, ?, ?, ?)',
        [userId, payload.product || 'tera_api', payload.action, payload.credits, JSON.stringify(payload.metadata || {})]
      )

      saveDb()

      return json(200, {
        data: { ok: true, event: { credits: payload.credits, status: 'charged', product: payload.product, action: payload.action, requestId } },
        meta: { requestId },
      })
    } catch (err) {
      return json(503, { error: { code: 'billing_unavailable', message: 'Billing service error: ' + err.message, requestId } })
    }
  }

  return json(404, { error: { code: 'not_found', message: `Unknown endpoint: ${path}`, requestId } })
}

export async function handler(event) {
  const method = event.httpMethod || 'GET'
  const path = event.path || '/'
  const headers = event.headers || {}
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body) : null
  return await routeHandler(method, path, headers, body)
}
