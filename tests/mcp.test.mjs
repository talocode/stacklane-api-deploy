import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TOOL_ROUTES,
  AVAILABLE_FAMILIES,
  AVAILABLE_EXACT_ROUTES,
  INTERNAL_TOOLS,
  routeFamily,
  isDispatchable,
  isInternal,
  workingToolNames,
} from '../netlify/functions/mcp-tools.mjs'
import {
  buildRouteRequest,
  dispatchTool,
  listAdvertisedTools,
  advertisedToolNames,
  toolRegistrySummary,
} from '../netlify/functions/mcp-dispatch.mjs'

// The live registry carried only name + description, so these stand in for it.
const DEFINITIONS = Object.keys(TOOL_ROUTES).map((name) => ({ name, description: `${name} test` }))

function okRoute(data = { ok: true, data: { value: 1 } }) {
  return { statusCode: 200, body: JSON.stringify(data) }
}

describe('mcp tool registry', () => {
  it('gives every tool a route and an HTTP method', () => {
    const entries = Object.entries(TOOL_ROUTES)
    assert.ok(entries.length > 100, `expected a large registry, got ${entries.length}`)
    for (const [name, entry] of entries) {
      assert.match(entry.route, /^\//, `${name} route must be absolute`)
      assert.ok(['GET', 'POST'].includes(entry.method), `${name} method must be GET or POST`)
    }
  })

  it('only advertises tools whose route this deploy can serve', () => {
    for (const name of workingToolNames()) {
      const entry = TOOL_ROUTES[name]
      if (!entry) continue
      const servable =
        AVAILABLE_FAMILIES.includes(routeFamily(entry.route)) ||
        AVAILABLE_EXACT_ROUTES.includes(entry.route)
      assert.ok(servable, `${name} advertised but its route ${entry.route} is not served`)
    }
  })

  it('keeps the internal tools honest', () => {
    assert.equal(INTERNAL_TOOLS.length, 2)
    for (const tool of INTERNAL_TOOLS) {
      assert.ok(tool.name.startsWith('cloud_'), `${tool.name} should be a cloud tool`)
      assert.ok(tool.description && tool.description.length > 30, `${tool.name} needs a real description`)
      assert.equal(isInternal(tool.name), true)
      assert.equal(isDispatchable(tool.name), false, 'internal tools are not route tools')
    }
  })

  it('hides tools whose product is not deployed here, rather than faking success', () => {
    // These families have no handler in this deployment.
    for (const name of ['tradia_agent_plan', 'forgecad_design_generate', 'ugclane_hooks_generate']) {
      assert.ok(name in TOOL_ROUTES, `${name} should still be defined`)
      assert.equal(isDispatchable(name), false, `${name} must not be advertised`)
    }
  })

  it('reports defined, routed, internal and hidden counts consistently', () => {
    const summary = toolRegistrySummary(DEFINITIONS)
    assert.equal(summary.defined, DEFINITIONS.length)
    assert.equal(summary.internal, INTERNAL_TOOLS.length)
    assert.equal(summary.advertised, summary.routed + summary.internal)
    assert.equal(summary.hidden, summary.defined - summary.routed)
    assert.ok(summary.routed > 0 && summary.hidden > 0)
  })
})

describe('mcp tools/list filtering', () => {
  it('advertises working tools and omits the hidden ones', () => {
    const names = advertisedToolNames(DEFINITIONS)
    assert.ok(names.includes('calclane_evaluate'))
    assert.ok(names.includes('searchlane_health'))
    assert.ok(names.includes('cloud_pricing'), 'cloud_pricing is served by an exact route')
    assert.ok(names.includes('cloud_credits_balance'))
    assert.ok(!names.includes('tradia_agent_plan'))
    assert.ok(!names.includes('codra_review'), 'codra exposes repo-summary and run, not review')
    assert.equal(new Set(names).size, names.length, 'no duplicate tool names')
  })

  it('carries a description on every advertised tool', () => {
    for (const tool of listAdvertisedTools([...DEFINITIONS, ...INTERNAL_TOOLS])) {
      assert.ok(tool.description && tool.description.length > 10, `${tool.name} needs a description`)
    }
  })
})

describe('mcp request building', () => {
  it('maps GET tools to query parameters and skips empty values', () => {
    const entry = TOOL_ROUTES.searchlane_health ?? { route: '/v1/searchlane/health', method: 'GET' }
    const built = buildRouteRequest({ ...entry, method: 'GET' }, { a: 'x', b: '', c: null, d: 3 })
    assert.equal(built.body, null)
    assert.equal(built.query.a, 'x')
    assert.equal(built.query.d, '3')
    assert.ok(!('c' in built.query))
  })

  it('maps POST tools to a JSON body with no query', () => {
    const built = buildRouteRequest({ route: '/v1/calclane/evaluate', method: 'POST' }, { expression: '2+2' })
    assert.deepEqual(built.query, {})
    assert.deepEqual(JSON.parse(built.body), { expression: '2+2' })
  })

  it('tolerates missing or non-object arguments', () => {
    const built = buildRouteRequest({ route: '/v1/calclane/evaluate', method: 'POST' }, undefined)
    assert.deepEqual(JSON.parse(built.body), {})
  })
})

describe('mcp dispatch', () => {
  it('proxies a POST tool to its route and returns the data', async () => {
    const seen = []
    const result = await dispatchTool('calclane_evaluate', { expression: '2+2' }, {
      headers: { authorization: 'Bearer test' },
      callRoute: async (method, path, headers, body) => {
        seen.push({ method, path, headers, body: JSON.parse(body) })
        return okRoute({ ok: true, data: { result: 4 } })
      },
    })
    assert.equal(result.isError, false)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].path, '/v1/calclane/evaluate')
    assert.deepEqual(seen[0].body, { expression: '2+2' })
    assert.equal(seen[0].headers.authorization, 'Bearer test', 'caller headers must be forwarded for auth')
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, data: { result: 4 } })
  })

  it('proxies a GET tool as a query, with no body', async () => {
    const seen = []
    await dispatchTool('searchlane_health', {}, {
      headers: {},
      callRoute: async (method, path, headers, body, query) => {
        seen.push({ method, path, body, query })
        return okRoute()
      },
    })
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].body, null)
    assert.deepEqual(seen[0].query, {})
  })

  it('surfaces an insufficient-credits 402 as an MCP error, not a success', async () => {
    const result = await dispatchTool('calclane_evaluate', { expression: '1+1' }, {
      headers: {},
      callRoute: async () => ({
        statusCode: 402,
        body: JSON.stringify({ error: { code: 'insufficient_credits', message: 'Insufficient credits. Required: 1, Balance: 0' } }),
      }),
    })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'insufficient_credits')
  })

  it('surfaces a 5xx route failure as an MCP error', async () => {
    const result = await dispatchTool('calclane_evaluate', {}, {
      headers: {},
      callRoute: async () => ({ statusCode: 503, body: JSON.stringify({ error: { code: 'storage_unavailable', message: 'down' } }) }),
    })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.content[0].text).code, 'storage_unavailable')
  })

  it('errors clearly on an unknown tool', async () => {
    const result = await dispatchTool('not_a_real_tool', {}, { headers: {}, callRoute: async () => okRoute() })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.content[0].text).code, 'unknown_tool')
  })

  it('refuses a defined-but-unserved tool instead of pretending it ran', async () => {
    const result = await dispatchTool('tradia_agent_plan', {}, { headers: {}, callRoute: async () => okRoute() })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.content[0].text).code, 'tool_unavailable')
  })

  it('does not call the route layer for an unavailable tool', async () => {
    let called = false
    await dispatchTool('forgecad_design_generate', {}, {
      headers: {},
      callRoute: async () => { called = true; return okRoute() },
    })
    assert.equal(called, false)
  })

  it('reports a dispatch crash rather than throwing', async () => {
    const result = await dispatchTool('calclane_evaluate', {}, {
      headers: {},
      callRoute: async () => { throw new Error('boom') },
    })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.content[0].text).code, 'internal_error')
  })
})

describe('mcp internal tools', () => {
  const keyContext = {
    projectId: 'proj_1',
    userId: 'usr_1',
    wallet: { balance: 1250, lifetimeCredits: 5000, lifetimeSpend: 3750 },
    usageEvents: Array.from({ length: 5 }, (_, i) => ({ product: 'calclane', action: 'evaluate', credits: i + 1 })),
  }

  it('returns the wallet balance for the key', async () => {
    const result = await dispatchTool('cloud_credits_balance', {}, { headers: {}, keyContext })
    assert.equal(result.isError, false)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.data.balance, 1250)
    assert.equal(payload.data.projectId, 'proj_1')
    assert.equal(payload.data.usdApprox, 12.5)
  })

  it('returns recent usage, newest first, and honours the limit', async () => {
    const result = await dispatchTool('cloud_usage_recent', { limit: 2 }, { headers: {}, keyContext })
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.data.count, 2)
    assert.equal(payload.data.events[0].credits, 5, 'newest event first')
  })

  it('caps the limit and defaults it', async () => {
    const many = { ...keyContext, usageEvents: Array.from({ length: 200 }, (_, i) => ({ i })) }
    const capped = JSON.parse((await dispatchTool('cloud_usage_recent', { limit: 5000 }, { headers: {}, keyContext: many })).content[0].text)
    assert.equal(capped.data.count, 100)
    const defaulted = JSON.parse((await dispatchTool('cloud_usage_recent', {}, { headers: {}, keyContext: many })).content[0].text)
    assert.equal(defaulted.data.count, 20)
  })

  it('errors when there is no key context', async () => {
    const result = await dispatchTool('cloud_credits_balance', {}, { headers: {}, keyContext: null })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.content[0].text).code, 'auth_error')
  })

  it('errors when the key has no wallet', async () => {
    const result = await dispatchTool('cloud_credits_balance', {}, { headers: {}, keyContext: { wallet: null } })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.content[0].text).code, 'wallet_not_found')
  })
})
