import { randomUUID } from 'node:crypto'
import pg from 'pg'

export const config = {
  path: '/*',
  preferStatic: true,
}

const { Pool } = pg

let pool
function getPool() {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL
    if (databaseUrl) {
      pool = new Pool({ connectionString: databaseUrl, max: 3 })
    }
  }
  return pool
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
      const db = getPool()

      if (!db) {
        return json(200, {
          data: { ok: true, event: { credits: payload.credits, status: 'charged', product: payload.product, action: payload.action, requestId } },
          meta: { requestId },
        })
      }

      const userResult = await db.query(
        'SELECT user_id FROM api_keys WHERE api_key = $1 LIMIT 1',
        [apiKey]
      )
      if (userResult.rows.length === 0) {
        return json(401, { error: { code: 'invalid_api_key', message: 'Invalid or expired API key', requestId } })
      }
      const userId = userResult.rows[0].user_id

      const profileResult = await db.query(
        'SELECT purchased_credits_balance, free_plan_credits_used FROM profiles WHERE id = $1 LIMIT 1',
        [userId]
      )
      if (profileResult.rows.length === 0) {
        return json(402, { error: { code: 'insufficient_credits', message: 'No active subscription or credits found', requestId } })
      }
      const profile = profileResult.rows[0]
      const totalCredits = profile.purchased_credits_balance || 0
      if (totalCredits < payload.credits) {
        return json(402, { error: { code: 'insufficient_credits', message: `Insufficient Talocode Cloud credits. Required: ${payload.credits}, Balance: ${totalCredits}`, requestId } })
      }

      await db.query(
        'UPDATE profiles SET purchased_credits_balance = purchased_credits_balance - $1 WHERE id = $2',
        [payload.credits, userId]
      )

      await db.query(
        'INSERT INTO usage_events (user_id, product, action, credits, metadata) VALUES ($1, $2, $3, $4, $5)',
        [userId, payload.product || 'tera_api', payload.action, payload.credits, payload.metadata || {}]
      ).catch(() => {})

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
