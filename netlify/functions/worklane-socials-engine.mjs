/**
 * WorkLane Socials engine — hosted multi-platform publishing for Talocode Cloud.
 * Posts to Facebook, Instagram, Threads, Telegram, and X using server-side
 * WORKLANE_* platform credentials configured in the Netlify environment.
 */

import { randomBytes, createHmac } from 'node:crypto'

const GRAPH = 'https://graph.facebook.com/v21.0'
const THREADS_API = 'https://graph.threads.net/v1.0'
const VERSION = '0.1.0'

export const SOCIALS_VERSION = VERSION

export const pricing = {
  'socials.publish': 15,
}

export const capabilities = [
  { id: 'socials.publish', name: 'Publish to Social Platforms', credits: 15 },
]

export function platformStatus() {
  const has = (...keys) => keys.every((k) => !!process.env[k])
  return {
    facebook: has('WORKLANE_FB_PAGE_ID', 'WORKLANE_FB_PAGE_TOKEN'),
    instagram: has('WORKLANE_IG_USER_ID', 'WORKLANE_IG_ACCESS_TOKEN'),
    threads: has('WORKLANE_THREADS_USER_ID', 'WORKLANE_THREADS_ACCESS_TOKEN'),
    telegram: has('WORKLANE_TELEGRAM_BOT_TOKEN', 'WORKLANE_TELEGRAM_CHANNEL'),
    x: has('WORKLANE_X_API_KEY', 'WORKLANE_X_API_SECRET', 'WORKLANE_X_ACCESS_TOKEN', 'WORKLANE_X_ACCESS_SECRET'),
  }
}

export function validateInput(payload) {
  if (!payload || typeof payload !== 'object') return 'Request body is required'
  if (!payload.text || typeof payload.text !== 'string') return 'text is required'
  if (!Array.isArray(payload.platforms) || !payload.platforms.length) return 'platforms array is required'
  const known = ['facebook', 'instagram', 'threads', 'telegram', 'x']
  for (const p of payload.platforms) {
    if (!known.includes(p)) return `unknown platform: ${p}`
  }
  return null
}

async function graphPost(url, params) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data).slice(0, 300)}`)
  return data
}

function oauth1(method, url, cfg, bodyParams = {}) {
  const oauth = {
    oauth_consumer_key: cfg.apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: cfg.accessToken,
    oauth_version: '1.0',
  }
  const all = { ...oauth, ...bodyParams }
  const baseParams = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`)
    .join('&')
  const base = [method.toUpperCase(), encodeURIComponent(url.split('?')[0]), encodeURIComponent(baseParams)].join('&')
  const key = `${encodeURIComponent(cfg.apiSecret)}&${encodeURIComponent(cfg.accessSecret)}`
  oauth.oauth_signature = createHmac('sha1', key).update(base).digest('base64')
  return oauth
}

function authHeader(oauth) {
  return (
    'OAuth ' +
    Object.keys(oauth)
      .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauth[k])}"`)
      .join(', ')
  )
}

async function publishFacebook(payload, env) {
  const { pageId: WORKLANE_FB_PAGE_ID, pageToken: WORKLANE_FB_PAGE_TOKEN } = env
  let out
  if (payload.videoUrl) {
    out = await graphPost(`${GRAPH}/${WORKLANE_FB_PAGE_ID}/videos`, {
      access_token: WORKLANE_FB_PAGE_TOKEN,
      description: payload.text,
      file_url: payload.videoUrl,
    })
  } else if (payload.imageUrl) {
    out = await graphPost(`${GRAPH}/${WORKLANE_FB_PAGE_ID}/photos`, {
      access_token: WORKLANE_FB_PAGE_TOKEN,
      caption: payload.text,
      url: payload.imageUrl,
    })
  } else {
    out = await graphPost(`${GRAPH}/${WORKLANE_FB_PAGE_ID}/feed`, {
      access_token: WORKLANE_FB_PAGE_TOKEN,
      message: payload.text,
    })
  }
  const id = out.post_id || out.id
  return { platform: 'facebook', ok: true, id, permalink: `https://www.facebook.com/${id}` }
}

async function publishInstagram(payload, env) {
  if (!payload.imageUrl && !payload.videoUrl) {
    return { platform: 'instagram', ok: false, error: 'instagram requires imageUrl or videoUrl' }
  }
  const container = { access_token: env.WORKLANE_IG_ACCESS_TOKEN, caption: payload.text }
  if (payload.videoUrl) {
    container.media_type = 'REELS'
    container.video_url = payload.videoUrl
  } else {
    container.image_url = payload.imageUrl
  }
  const created = await graphPost(`${GRAPH}/${env.WORKLANE_IG_USER_ID}/media`, container)
  await new Promise((r) => setTimeout(r, payload.videoUrl ? 25000 : 8000))
  const published = await graphPost(`${GRAPH}/${env.WORKLANE_IG_USER_ID}/media_publish`, {
    access_token: env.WORKLANE_IG_ACCESS_TOKEN,
    creation_id: created.id,
  })
  let permalink
  try {
    const meta = await fetch(`${GRAPH}/${published.id}?fields=permalink&access_token=${env.WORKLANE_IG_ACCESS_TOKEN}`)
    permalink = (await meta.json()).permalink
  } catch {}
  return { platform: 'instagram', ok: true, id: published.id, permalink }
}

async function publishThreads(payload, env) {
  if (!payload.imageUrl && !payload.videoUrl) {
    return { platform: 'threads', ok: false, error: 'threads requires imageUrl for media posts; text-only supported without' }
  }
  const body = {
    access_token: env.WORKLANE_THREADS_ACCESS_TOKEN,
    media_type: payload.imageUrl ? 'IMAGE' : 'TEXT',
    text: String(payload.text).slice(0, 490),
  }
  if (payload.imageUrl) body.image_url = payload.imageUrl
  const created = await graphPost(`${THREADS_API}/${env.WORKLANE_THREADS_USER_ID}/threads`, body)
  await new Promise((r) => setTimeout(r, 5000))
  const published = await graphPost(`${THREADS_API}/${env.WORKLANE_THREADS_USER_ID}/threads_publish`, {
    access_token: env.WORKLANE_THREADS_ACCESS_TOKEN,
    creation_id: created.id,
  })
  let permalink
  try {
    const meta = await fetch(`${THREADS_API}/${published.id}?fields=permalink&access_token=${env.WORKLANE_THREADS_ACCESS_TOKEN}`)
    permalink = (await meta.json()).permalink
  } catch {}
  return { platform: 'threads', ok: true, id: published.id, permalink }
}

async function publishTelegram(payload, env) {
  const method = payload.imageUrl ? 'sendPhoto' : 'sendMessage'
  const body = payload.imageUrl
    ? { chat_id: env.WORKLANE_TELEGRAM_CHANNEL, photo: payload.imageUrl, caption: String(payload.text).slice(0, 1024) }
    : { chat_id: env.WORKLANE_TELEGRAM_CHANNEL, text: String(payload.text).slice(0, 4096) }
  const res = await fetch(`https://api.telegram.org/bot${env.WORKLANE_TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const out = await res.json().catch(() => ({}))
  const messageId = out?.result?.message_id
  let permalink
  if (String(env.WORKLANE_TELEGRAM_CHANNEL).startsWith('@') && messageId) {
    permalink = `https://t.me/${String(env.WORKLANE_TELEGRAM_CHANNEL).slice(1)}/${messageId}`
  }
  return { platform: 'telegram', ok: out?.ok === true, id: messageId ? String(messageId) : undefined, permalink }
}

async function publishX(payload, env) {
  const cfg = {
    apiKey: env.WORKLANE_X_API_KEY,
    apiSecret: env.WORKLANE_X_API_SECRET,
    accessToken: env.WORKLANE_X_ACCESS_TOKEN,
    accessSecret: env.WORKLANE_X_ACCESS_SECRET,
  }
  const tweetUrl = 'https://api.twitter.com/2/tweets'
  let mediaId
  if (payload.imageUrl && payload.imageUrl.startsWith('http')) {
    const mediaRes = await fetch(payload.imageUrl)
    if (!mediaRes.ok) return { platform: 'x', ok: false, error: `failed to download imageUrl: ${mediaRes.status}` }
    const buf = Buffer.from(await mediaRes.arrayBuffer())
    const oauth = oauth1('POST', 'https://upload.twitter.com/1.1/media/upload.json', cfg)
    const form = new FormData()
    form.append('media_data', buf.toString('base64'))
    const up = await fetch('https://upload.twitter.com/1.1/media/upload.json', {
      method: 'POST',
      headers: { Authorization: authHeader(oauth) },
      body: form,
    })
    const upData = await up.json().catch(() => ({}))
    if (!up.ok) return { platform: 'x', ok: false, error: `media upload failed: ${JSON.stringify(upData).slice(0, 200)}` }
    mediaId = upData.media_id_string
  }
  const body = { text: String(payload.text).slice(0, 280) }
  if (mediaId) body.media = { media_ids: [mediaId] }
  const oauth = oauth1('POST', tweetUrl, cfg, mediaId ? { media_ids: mediaId } : {})
  const res = await fetch(tweetUrl, {
    method: 'POST',
    headers: { Authorization: authHeader(oauth), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { platform: 'x', ok: false, error: `${res.status} ${JSON.stringify(data).slice(0, 300)}` }
  const id = data?.data?.id
  return { platform: 'x', ok: true, id, permalink: id ? `https://x.com/${data?.data?.username || 'i'}/status/${id}` : undefined }
}

const PUBLISHERS = {
  facebook: publishFacebook,
  instagram: publishInstagram,
  threads: publishThreads,
  telegram: publishTelegram,
  x: publishX,
}

export async function publish(payload) {
  const env = process.env
  const status = platformStatus()
  const results = []
  for (const platform of payload.platforms) {
    if (!status[platform]) {
      results.push({ platform, ok: false, error: `hosted credentials for ${platform} are not configured` })
      continue
    }
    try {
      results.push(await PUBLISHERS[platform](payload, env))
    } catch (err) {
      results.push({ platform, ok: false, error: String(err?.message || err).slice(0, 300) })
    }
  }
  return results
}
