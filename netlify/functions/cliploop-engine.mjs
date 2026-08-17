/**
 * ClipLoop engine — short-form video content pipeline (briefs, scripts, renders, campaigns).
 * Ported from Stacklane monorepo apps/api/src/services/cliploop/service.ts.
 * Provider-agnostic LLM call: uses CLIPLOOP_PROVIDER_URL/KEY/MODEL when set;
 * otherwise returns an honest provider_unavailable (no fake generation).
 */
import { randomUUID } from 'node:crypto'

export const CLIPLOOP_VERSION = '0.1.0'

const MOCK_ENABLED = process.env.CLIPLOOP_ALLOW_MOCK_PROVIDER === 'true'
const PROVIDER_URL = process.env.CLIPLOOP_PROVIDER_URL
const PROVIDER_KEY = process.env.CLIPLOOP_PROVIDER_KEY
const PROVIDER_MODEL = process.env.CLIPLOOP_PROVIDER_MODEL || 'default'

const renderJobs = new Map()
const campaigns = new Map()
const briefs = new Map()
const scripts = new Map()

async function callClipLoopLlm(systemInstruction, userContent) {
  if (!PROVIDER_URL || !PROVIDER_KEY) {
    if (MOCK_ENABLED) return mockClipLoopResponse(systemInstruction, userContent)
    throw new Error('No AI provider configured. Set CLIPLOOP_PROVIDER_URL and CLIPLOOP_PROVIDER_KEY, or CLIPLOOP_ALLOW_MOCK_PROVIDER=true for development.')
  }

  try {
    const response = await fetch(`${PROVIDER_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PROVIDER_KEY}`,
      },
      body: JSON.stringify({
        model: PROVIDER_MODEL,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 4000,
      }),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown')
      throw new Error(`ClipLoop provider returned status ${response.status}: ${errorBody.slice(0, 200)}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content

    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c.text || ''))).join('').trim()

    throw new Error('ClipLoop provider returned empty response')
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith('ClipLoop provider returned') || err.message.startsWith('No AI provider'))) {
      throw err
    }
    throw new Error('ClipLoop LLM request failed.')
  }
}

function mockClipLoopResponse(_systemInstruction, _userContent) {
  return JSON.stringify({
    mock: true,
    note: 'This is a mock response because CLIPLOOP_ALLOW_MOCK_PROVIDER=true.',
  })
}

function extractJson(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse provider response as JSON.')
  try {
    return JSON.parse(jsonMatch[0])
  } catch {
    throw new Error('Failed to parse provider response as JSON.')
  }
}

export async function generateBrief(input) {
  const prompt = (input.prompt || '').trim()
  if (!prompt) throw new Error('prompt is required.')

  const channel = input.channel || 'youtube'
  const duration = input.duration || 60

  if (MOCK_ENABLED) {
    const id = 'brief_' + randomUUID().slice(0, 12)
    const result = {
      id,
      title: `Mock: ${prompt.slice(0, 40)}`,
      channel,
      duration,
      hook: `Mock hook for "${prompt.slice(0, 60)}"`,
      structure: ['Introduction', 'Main Point 1', 'Main Point 2', 'Conclusion'],
      tone: 'casual',
      targetAudience: 'General audience interested in this topic',
      mock: true,
    }
    briefs.set(id, result)
    return result
  }

  const systemPrompt = `You are the ClipLoop AI — a video content strategy engine. You generate structured content briefs for short-form video.

CORE RULES:
- Return ONLY valid JSON. No markdown fences, no explanatory text.
- The product is ClipLoop.

Given a prompt, channel, and optional duration, generate a content brief with:
- title: A catchy title for the video
- channel: The target platform (youtube, tiktok, instagram, linkedin, twitter)
- duration: Target duration in seconds
- hook: An attention-grabbing opening hook (1-2 sentences)
- structure: Array of 3-6 section headings that form the video structure
- tone: The overall tone (e.g. casual, professional, humorous, educational)
- targetAudience: Brief description of the target audience`

  const userContent = JSON.stringify({ prompt, channel, duration })
  const raw = await callClipLoopLlm(systemPrompt, userContent)
  const parsed = extractJson(raw)

  const result = {
    id: 'brief_' + randomUUID().slice(0, 12),
    title: parsed.title || prompt.slice(0, 60),
    channel: parsed.channel || channel,
    duration: parsed.duration || duration,
    hook: parsed.hook || '',
    structure: Array.isArray(parsed.structure) ? parsed.structure : [],
    tone: parsed.tone || 'neutral',
    targetAudience: parsed.targetAudience || '',
  }

  briefs.set(result.id, result)
  return result
}

export async function generateScript(input) {
  if (!input.briefId) throw new Error('briefId is required.')

  const brief = briefs.get(input.briefId)
  const style = input.style || 'storytelling'

  if (MOCK_ENABLED) {
    const id = 'script_' + randomUUID().slice(0, 12)
    const scenes = [
      { index: 0, visual: 'Opening shot', narration: 'Mock opening narration', duration: 10 },
      { index: 1, visual: 'Main content visualization', narration: 'Mock main content', duration: 20 },
      { index: 2, visual: 'Closing shot', narration: 'Mock closing', duration: 10 },
    ]
    const result = {
      id,
      briefId: input.briefId,
      title: brief?.title || 'Mock Video',
      scenes,
      fullScript: scenes.map((s) => s.narration).join(' '),
      estimatedDuration: scenes.reduce((sum, s) => sum + s.duration, 0),
      mock: true,
    }
    scripts.set(id, result)
    return result
  }

  const systemPrompt = `You are the ClipLoop AI — a video script generation engine. You generate detailed, scene-by-scene video scripts.

CORE RULES:
- Return ONLY valid JSON. No markdown fences, no explanatory text.
- The product is ClipLoop.

Given a brief and optional style, generate a full script with:
- title: The video title
- scenes: Array of scene objects, each with:
  - index: Scene number (0-based)
  - visual: Description of what appears on screen
  - narration: The spoken script for this scene
  - duration: Duration in seconds
- fullScript: The complete narration text concatenated
- estimatedDuration: Total estimated duration in seconds

Style can be: storytelling, educational, promotional, entertaining`

  const userContent = JSON.stringify({
    brief: brief ? { title: brief.title, hook: brief.hook, structure: brief.structure, tone: brief.tone } : { title: 'Untitled' },
    style,
  })

  const raw = await callClipLoopLlm(systemPrompt, userContent)
  const parsed = extractJson(raw)

  const scenes = (Array.isArray(parsed.scenes) ? parsed.scenes : []).map((s, i) => ({
    index: s.index ?? i,
    visual: s.visual || '',
    narration: s.narration || '',
    duration: typeof s.duration === 'number' && s.duration > 0 ? s.duration : 10,
  }))

  const estimatedDuration = scenes.reduce((sum, s) => sum + s.duration, 0)

  const result = {
    id: 'script_' + randomUUID().slice(0, 12),
    briefId: input.briefId,
    title: parsed.title || brief?.title || 'Untitled',
    scenes,
    fullScript: parsed.fullScript || scenes.map((s) => s.narration).join('\n'),
    estimatedDuration: parsed.estimatedDuration || estimatedDuration,
  }

  scripts.set(result.id, result)
  return result
}

export async function submitRender(input) {
  if (!input.scriptId) throw new Error('scriptId is required.')

  const script = scripts.get(input.scriptId)
  if (!script) throw new Error(`Script not found: ${input.scriptId}`)

  const format = input.format || 'portrait'
  const quality = input.quality || 'standard'
  const id = 'render_' + randomUUID().slice(0, 12)

  const render = {
    id,
    status: 'processing',
    videoUrl: null,
    thumbnailUrl: null,
    duration: script.estimatedDuration,
    format,
    quality,
  }

  renderJobs.set(id, render)

  simulateRenderCompletion(id, script.estimatedDuration)

  return render
}

function simulateRenderCompletion(renderId, duration) {
  const processingTime = Math.max(2000, Math.random() * 5000)
  setTimeout(() => {
    const job = renderJobs.get(renderId)
    if (!job) return
    job.status = 'completed'
    job.videoUrl = `https://cdn.talocode.site/cliploop/renders/${renderId}.mp4`
    job.thumbnailUrl = `https://cdn.talocode.site/cliploop/thumbnails/${renderId}.jpg`
  }, processingTime)
}

export async function getRenderStatus(renderId) {
  if (!renderId) throw new Error('renderId is required.')

  const job = renderJobs.get(renderId)
  if (!job) throw new Error(`Render job not found: ${renderId}`)

  return {
    id: job.id,
    status: job.status,
    videoUrl: job.videoUrl,
    thumbnailUrl: job.thumbnailUrl,
    error: job.status === 'failed' ? 'Render failed due to an internal error.' : undefined,
  }
}

export async function createCampaign(input) {
  const name = (input.name || '').trim()
  if (!name) throw new Error('name is required.')
  if (!input.platform) throw new Error('platform is required.')

  const id = 'camp_' + randomUUID().slice(0, 12)

  if (MOCK_ENABLED) {
    const result = {
      id,
      name,
      status: 'draft',
      platform: input.platform,
      scheduledAt: input.schedule || undefined,
      videoCount: 0,
      mock: true,
    }
    campaigns.set(id, result)
    return result
  }

  const result = {
    id,
    name,
    status: 'draft',
    platform: input.platform,
    scheduledAt: input.schedule || undefined,
    videoCount: 0,
  }

  campaigns.set(id, result)
  return result
}

export async function packageCampaign(campaignId) {
  if (!campaignId) throw new Error('campaignId is required.')

  const campaign = campaigns.get(campaignId)
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`)

  campaign.status = 'completed'
  campaign.packageUrl = `https://cdn.talocode.site/cliploop/packages/${campaignId}.zip`
  campaign.videoCount = Math.max(campaign.videoCount, 1)

  return { ...campaign }
}

export function getClipLoopPricing() {
  return {
    product: 'cliploop',
    version: CLIPLOOP_VERSION,
    credits: {
      'cliploop.brief': 20,
      'cliploop.script': 30,
      'cliploop.render': 10,
      'cliploop.status': 1,
      'cliploop.campaign': 10,
    },
    note: 'Short-form video pipeline. Briefs/scripts use the configured provider; renders simulate delivery to the Talocode CDN.',
  }
}

export function getClipLoopCapabilities() {
  return {
    product: 'cliploop',
    version: CLIPLOOP_VERSION,
    endpoints: [
      'GET /v1/cliploop/health',
      'GET /v1/cliploop/pricing',
      'GET /v1/cliploop/capabilities',
      'POST /v1/cliploop/brief',
      'POST /v1/cliploop/script',
      'POST /v1/cliploop/render',
      'GET /v1/cliploop/render/:id',
      'POST /v1/cliploop/campaign',
      'POST /v1/cliploop/campaign/:id/package',
    ],
    features: [
      'Content brief generation',
      'Scene-by-scene script generation',
      'Render job simulation with status polling',
      'Campaign planning and packaging',
    ],
    limitations: [
      'Requires CLIPLOOP_PROVIDER_URL/KEY for real generation; mock mode for development',
      'Renders are simulated jobs, not real video rendering, in the hosted API',
    ],
  }
}
