// Talocode MCP tool dispatcher.
//
// Kept separate from api.mjs so it can be unit tested without a database: the
// caller injects the route handler, the request headers and the key context.
//
// Design: a tool call is proxied in-process to the HTTP route that implements it,
// reusing the existing route layer's API-key auth and credit charging rather than
// duplicating either. Tools listed in INTERNAL_TOOLS are answered here instead,
// because no route exists for them.

import { TOOL_ROUTES, INTERNAL_TOOLS, isDispatchable, isInternal } from './mcp-tools.mjs'

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20

function toolText(text) {
  return { content: [{ type: 'text', text }], isError: false }
}

function toolError(code, message) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code, error: message }) }],
    isError: true,
  }
}

function safeParse(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// GET tools take their arguments as query parameters, POST tools as a JSON body.
export function buildRouteRequest(entry, args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  if (entry.method === 'GET') {
    const query = {}
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue
      query[key] = typeof value === 'string' ? value : JSON.stringify(value)
    }
    return { path: entry.route, body: null, query }
  }
  return { path: entry.route, body: JSON.stringify(input), query: {} }
}

export function listAdvertisedTools(definitions) {
  const advertised = definitions.filter((d) => isDispatchable(d.name))
  const internal = INTERNAL_TOOLS.map((t) => ({ name: t.name, description: t.description }))
  return advertised.concat(internal)
}

export function advertisedToolNames(definitions) {
  return listAdvertisedTools(definitions).map((t) => t.name)
}

// Counts for GET /mcp, so the gap between defined and actually-served tools stays visible.
export function toolRegistrySummary(definitions) {
  const routed = definitions.filter((d) => isDispatchable(d.name))
  return {
    advertised: routed.length + INTERNAL_TOOLS.length,
    routed: routed.length,
    internal: INTERNAL_TOOLS.length,
    defined: definitions.length,
    hidden: definitions.length - routed.length,
  }
}

function internalTool(name, args, keyContext) {
  if (!keyContext) {
    return toolError('auth_error', 'No API key context is available for this call.')
  }

  if (name === 'cloud_credits_balance') {
    const wallet = keyContext.wallet
    if (!wallet) {
      return toolError('wallet_not_found', 'No wallet is associated with this API key.')
    }
    return toolText(
      JSON.stringify({
        ok: true,
        data: {
          projectId: keyContext.projectId ?? null,
          balance: wallet.balance ?? 0,
          lifetimeCredits: wallet.lifetimeCredits ?? 0,
          lifetimeSpend: wallet.lifetimeSpend ?? 0,
          usdApprox: Number(((wallet.balance ?? 0) * 0.01).toFixed(2)),
        },
      }),
    )
  }

  if (name === 'cloud_usage_recent') {
    const requested = Number(args && args.limit)
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LIMIT)
      : DEFAULT_LIMIT
    const events = Array.isArray(keyContext.usageEvents) ? keyContext.usageEvents : []
    const recent = events.slice(-limit).reverse()
    return toolText(JSON.stringify({ ok: true, data: { count: recent.length, events: recent } }))
  }

  return toolError('unknown_tool', `Unknown internal tool: ${name}`)
}

export async function dispatchTool(name, args, deps = {}) {
  const { headers = {}, callRoute, keyContext } = deps

  if (isInternal(name)) {
    return internalTool(name, args, keyContext)
  }

  const entry = TOOL_ROUTES[name]
  if (!entry) {
    return toolError('unknown_tool', `Unknown tool: ${name}`)
  }
  if (!isDispatchable(name)) {
    return toolError(
      'tool_unavailable',
      `${name} is registered but not served by this deployment. Its route is ${entry.route}.`,
    )
  }
  if (typeof callRoute !== 'function') {
    return toolError('internal_error', 'No route handler was provided to the MCP dispatcher.')
  }

  const { path, body, query } = buildRouteRequest(entry, args)

  let response
  try {
    response = await callRoute(entry.method, path, headers, body, query)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'route dispatch failed'
    return toolError('internal_error', message)
  }

  const status = (response && response.statusCode) || 0
  const parsed = safeParse(response && response.body)

  if (status >= 200 && status < 300) {
    const data = parsed && parsed.data !== undefined ? parsed.data : parsed
    return toolText(JSON.stringify({ ok: true, data }))
  }

  const failure = (parsed && parsed.error) || {}
  return toolError(failure.code || 'route_error', failure.message || `Route returned HTTP ${status}`)
}
