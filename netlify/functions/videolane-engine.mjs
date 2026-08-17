/**
 * VideoLane engine — local video production API proxy.
 * Ported from Stacklane monorepo apps/api/src/services/videolane.ts.
 * Proxies to a configured VideoLane server (VIDEOLANE_SERVER_URL). When the
 * server is not configured, health reports workerConfigured: false and POST
 * routes return an honest provider_unavailable error.
 */
export const VIDEOLANE_VERSION = '0.1.0'

const VIDEOLANE_SERVER = process.env.VIDEOLANE_SERVER_URL || 'http://localhost:3110'

export async function generateVideoPlan(input) {
  try {
    const resp = await fetch(`${VIDEOLANE_SERVER}/v1/videolane/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: input.prompt, style: input.style, duration: input.duration }),
      signal: AbortSignal.timeout(60000),
    })
    if (!resp.ok) {
      const err = await resp.text()
      return { ok: false, error: `VideoLane server error: ${resp.status} ${err}` }
    }
    const data = await resp.json()
    return { ok: true, plan: data }
  } catch (e) {
    return { ok: false, error: e?.message || 'VideoLane server unreachable' }
  }
}

export async function generateCaptions(planPath) {
  const resp = await fetch(`${VIDEOLANE_SERVER}/v1/videolane/captions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: planPath }),
    signal: AbortSignal.timeout(30000),
  })
  return resp.json()
}

export async function generateMetadata(title, outDir) {
  const resp = await fetch(`${VIDEOLANE_SERVER}/v1/videolane/metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, outDir: outDir || './youtube-metadata' }),
    signal: AbortSignal.timeout(30000),
  })
  return resp.json()
}

export async function checkHealth() {
  try {
    const resp = await fetch(`${VIDEOLANE_SERVER}/health`, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) return { ok: false, error: `Status ${resp.status}` }
    const data = await resp.json()
    return { ok: true, version: data.version }
  } catch (e) {
    return { ok: false, error: e?.message || 'unreachable' }
  }
}

export function getVideoLanePricing() {
  return {
    service: 'videolane',
    version: VIDEOLANE_VERSION,
    plans: [
      { action: 'videolane.plan', credits: 30, description: 'Generate a full video plan with scenes, voiceover script, and timing' },
      { action: 'videolane.captions', credits: 10, description: 'Generate captions (SRT/VTT) from a video plan' },
      { action: 'videolane.metadata', credits: 10, description: 'Generate YouTube metadata (title, description, tags, chapters)' },
    ],
  }
}

export function getVideoLaneCapabilities() {
  return {
    service: 'videolane',
    version: VIDEOLANE_VERSION,
    requires_local_server: true,
    server_url: VIDEOLANE_SERVER,
    endpoints: [
      { method: 'GET', path: '/v1/videolane/health', description: 'Check VideoLane server health' },
      { method: 'GET', path: '/v1/videolane/pricing', description: 'List pricing' },
      { method: 'GET', path: '/v1/videolane/capabilities', description: 'List capabilities' },
      { method: 'POST', path: '/v1/videolane/plan', description: 'Generate a video plan from a prompt', credits: 30 },
      { method: 'POST', path: '/v1/videolane/captions', description: 'Generate captions from a plan', credits: 10 },
      { method: 'POST', path: '/v1/videolane/metadata', description: 'Generate YouTube metadata', credits: 10 },
    ],
  }
}
