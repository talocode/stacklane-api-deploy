const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MIME_TYPES = ['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/webm']

export const AUDIOLANE_VERSION = '0.1.0'
export const pricing = { transcription: 15, 'transcription.timestamps': 20 }

export function capabilities() {
  return {
    mimeTypes: MIME_TYPES,
    maxAudioBytes: MAX_AUDIO_BYTES,
    inputs: ['audioBase64', 'audioUrl'],
    timestampModes: ['none', 'segments', 'words'],
    endpoints: ['/v1/audiolane/health', '/v1/audiolane/pricing', '/v1/audiolane/capabilities', '/v1/audiolane/transcriptions'],
  }
}

export function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Request body is required')
  const hasBase64 = typeof input.audioBase64 === 'string' && input.audioBase64.length > 0
  const hasUrl = typeof input.audioUrl === 'string' && input.audioUrl.length > 0
  if (hasBase64 === hasUrl) throw new Error('Provide exactly one of audioBase64 or audioUrl')
  if (input.mimeType && !MIME_TYPES.includes(String(input.mimeType).toLowerCase())) throw new Error(`Unsupported audio MIME type: ${input.mimeType}`)
  if (hasBase64) {
    const normalized = input.audioBase64.replace(/^data:[^,]+,/, '')
    const bytes = Buffer.byteLength(normalized, 'base64')
    if (!bytes) throw new Error('audioBase64 is empty')
    if (bytes > MAX_AUDIO_BYTES) throw new Error(`Audio exceeds the ${MAX_AUDIO_BYTES} byte limit`)
  }
  if (hasUrl) {
    let url
    try { url = new URL(input.audioUrl) } catch { throw new Error('audioUrl must be a valid URL') }
    if (url.protocol !== 'https:') throw new Error('audioUrl must use HTTPS')
  }
}

export async function transcribe(input) {
  validateInput(input)
  const endpoint = process.env.AUDIOLANE_TRANSCRIBE_URL
  if (!endpoint) {
    const error = new Error('AudioLane transcription worker is not configured')
    error.code = 'provider_unavailable'
    throw error
  }
  const headers = { 'Content-Type': 'application/json' }
  if (process.env.AUDIOLANE_TRANSCRIBE_KEY) headers.Authorization = `Bearer ${process.env.AUDIOLANE_TRANSCRIBE_KEY}`
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(90000) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || `Transcription worker returned ${response.status}`)
  if (!body.text || typeof body.text !== 'string') throw new Error('Transcription worker returned no text')
  return { id: body.id || `aud_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`, text: body.text, language: body.language || input.language, durationSeconds: body.durationSeconds, segments: body.segments, words: body.words, provider: body.provider || 'audiolane-worker', createdAt: body.createdAt || new Date().toISOString() }
}
