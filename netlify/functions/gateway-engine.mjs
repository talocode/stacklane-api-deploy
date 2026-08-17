/**
 * LLM Gateway engine — OpenAI-compatible proxy under /v1/gateway/*.
 * Ported from Stacklane monorepo apps/api/src/services/llmgateway.ts.
 * Proxies chat completions to a configured upstream provider and meters usage.
 */
export const LLMGATEWAY_VERSION = '0.1.0'

const DEFAULT_PRICING = { inputPerM: 2, outputPerM: 8 }

/** Load providers from env. LLMGATEWAY_PROVIDER_<ID>_URL / _KEY / _MODELS. */
export function loadGatewayConfig() {
  const providers = []
  const ids = (process.env.LLMGATEWAY_PROVIDERS || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const id of ids) {
    const baseUrl = process.env[`LLMGATEWAY_PROVIDER_${id.toUpperCase()}_URL`]
    const apiKey = process.env[`LLMGATEWAY_PROVIDER_${id.toUpperCase()}_KEY`]
    const models = (process.env[`LLMGATEWAY_PROVIDER_${id.toUpperCase()}_MODELS`] || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
    if (!baseUrl || !apiKey || !models.length) continue
    providers.push({ id, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, models })
  }
  if (!providers.length) return null
  return { providers, defaultPricing: DEFAULT_PRICING }
}

export function resolveGatewayRoute(config, model) {
  const serving = config.providers.find((p) => p.models.includes(model))
  const provider = serving ?? config.providers[0]
  const pricing = provider.pricing?.[model] ?? config.defaultPricing
  return { provider, pricing }
}

export function estimateGatewayCost(pricing, prompt, completion) {
  const inputCostUsd = (prompt / 1_000_000) * pricing.inputPerM
  const outputCostUsd = (completion / 1_000_000) * pricing.outputPerM
  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: Number((inputCostUsd + outputCostUsd).toFixed(8)),
  }
}

const inMemoryUsage = []

export function recordGatewayUsage(event) {
  const full = {
    ...event,
    id: `gw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  }
  inMemoryUsage.push(full)
  if (inMemoryUsage.length > 5000) inMemoryUsage.splice(0, inMemoryUsage.length - 5000)
  return full
}

export function getGatewayUsage(projectId) {
  const events = projectId ? inMemoryUsage.filter((e) => e.projectId === projectId) : inMemoryUsage
  const summary = {
    requests: events.length,
    totalTokens: events.reduce((a, e) => a + e.totalTokens, 0),
    promptTokens: events.reduce((a, e) => a + e.promptTokens, 0),
    completionTokens: events.reduce((a, e) => a + e.completionTokens, 0),
    totalCostUsd: Number(events.reduce((a, e) => a + e.totalCostUsd, 0).toFixed(8)),
    byModel: {},
    byProvider: {},
  }
  for (const e of events) {
    summary.byModel[e.model] ??= { requests: 0, tokens: 0, costUsd: 0 }
    summary.byModel[e.model].requests += 1
    summary.byModel[e.model].tokens += e.totalTokens
    summary.byModel[e.model].costUsd = Number((summary.byModel[e.model].costUsd + e.totalCostUsd).toFixed(8))
    summary.byProvider[e.providerId] ??= { requests: 0, tokens: 0, costUsd: 0 }
    summary.byProvider[e.providerId].requests += 1
    summary.byProvider[e.providerId].tokens += e.totalTokens
    summary.byProvider[e.providerId].costUsd = Number((summary.byProvider[e.providerId].costUsd + e.totalCostUsd).toFixed(8))
  }
  return { summary, events: events.slice(-100) }
}

export async function proxyChatCompletion(input) {
  const model = typeof input.body.model === 'string' ? input.body.model : ''
  if (!model) throw new GatewayInputError('model is required.')
  const { provider, pricing } = resolveGatewayRoute(input.config, model)
  const started = Date.now()

  try {
    const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(input.body),
    })
    const text = await upstream.text()
    const latencyMs = Date.now() - started
    let parsed = {}
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }
    const usage = parsed.usage ?? {}
    const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
    const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
    const cost = estimateGatewayCost(pricing, promptTokens, completionTokens)

    recordGatewayUsage({
      projectId: input.projectId,
      apiKeyId: input.apiKeyId,
      model,
      providerId: provider.id,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      totalCostUsd: cost.totalCostUsd,
      status: upstream.ok ? 'ok' : 'error',
      latencyMs,
    })

    if (!upstream.ok) {
      return { status: upstream.status, body: text, usageEvent: null }
    }
    return { status: 200, body: text, usageEvent: null }
  } catch (error) {
    const latencyMs = Date.now() - started
    recordGatewayUsage({
      projectId: input.projectId,
      apiKeyId: input.apiKeyId,
      model,
      providerId: provider.id,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      status: 'error',
      latencyMs,
    })
    throw new GatewayUpstreamError(error instanceof Error ? error.message : 'Upstream provider failed.')
  }
}

export class GatewayInputError extends Error {}
export class GatewayUpstreamError extends Error {}

export function getLLMGatewayPricing() {
  return {
    product: 'llmgateway',
    version: LLMGATEWAY_VERSION,
    credits: {
      'llmgateway.models': 1,
      'llmgateway.chat': 10,
      'llmgateway.usage': 1,
      'llmgateway.keys': 1,
    },
    note: 'Hosted route proxies to the upstream provider configured via LLMGATEWAY_PROVIDERS. Chat completions meter at 10 credits.',
  }
}

export function getLLMGatewayCapabilities() {
  return {
    product: 'llmgateway',
    version: LLMGATEWAY_VERSION,
    endpoints: [
      'GET /v1/gateway/health',
      'GET /v1/gateway/models',
      'POST /v1/gateway/chat/completions',
      'GET /v1/gateway/usage',
      'GET /v1/gateway/pricing',
      'GET /v1/gateway/capabilities',
    ],
    features: [
      'OpenAI-compatible chat completions proxy',
      'Model→provider routing with per-model pricing',
      'Usage + cost tracking by model and provider',
      'Credits metering per call',
    ],
    limitations: [
      'Requires LLMGATEWAY_PROVIDERS env config to be active',
      'In-memory usage buffer (latest 5000 events) in hosted mode',
      'No streaming passthrough in v0.1 hosted route',
    ],
  }
}
