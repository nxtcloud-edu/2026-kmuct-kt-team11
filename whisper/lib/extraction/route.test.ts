import { describe, it, expect, afterEach, vi } from 'vitest'
import { POST } from '@/app/api/transcribe/route'

/**
 * The route is exercised through its real handler with a real multipart Request;
 * only the outbound ASR call is replaced, so no network and no key are needed.
 */
const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
  vi.unstubAllGlobals()
})

function upload(file: File | null, extra: Record<string, string> = {}) {
  const form = new FormData()
  if (file) form.append('file', file)
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  return new Request('http://localhost/api/transcribe', { method: 'POST', body: form })
}

function stub_asr(reply: Response) {
  const fetch_mock = vi.fn(async () => reply)
  vi.stubGlobal('fetch', fetch_mock)
  return fetch_mock
}

describe('POST /api/transcribe', () => {
  it('returns 503 with an actionable message when no key is configured', async () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.AI_GATEWAY_API_KEY
    const res = await POST(upload(new File([new Uint8Array(10)], 'a.mp4')))
    expect(res.status).toBe(503)
    expect((await res.json()).error.kind).toBe('not_configured')
  })

  it('returns 400 when the body is not multipart', async () => {
    process.env.OPENAI_API_KEY = 'sk-proj-x'
    const res = await POST(new Request('http://localhost/api/transcribe', { method: 'POST', body: 'nope' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.kind).toBe('bad_request')
  })

  it('returns 400 when the file field is missing', async () => {
    process.env.OPENAI_API_KEY = 'sk-proj-x'
    const res = await POST(upload(null))
    expect(res.status).toBe(400)
    expect((await res.json()).error.kind).toBe('no_file')
  })

  it('returns 400 for an empty file', async () => {
    process.env.OPENAI_API_KEY = 'sk-proj-x'
    const res = await POST(upload(new File([], 'a.mp4')))
    expect(res.status).toBe(400)
    expect((await res.json()).error.kind).toBe('empty_file')
  })

  it('returns 413 for a file over the size cap', async () => {
    process.env.OPENAI_API_KEY = 'sk-proj-x'
    const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'big.mp4')
    const res = await POST(upload(big))
    expect(res.status).toBe(413)
    expect((await res.json()).error.kind).toBe('too_large')
  })

  it('transcribes an uploaded file and returns the transcript', async () => {
    process.env.OPENAI_API_KEY = 'sk-proj-x'
    delete process.env.AI_GATEWAY_API_KEY
    const asr = stub_asr(Response.json({ text: '연남동 맛집', language: 'korean', duration: 30 }))

    const res = await POST(upload(new File([new Uint8Array(1000)], 'reel.mp4')))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.transcript).toBe('연남동 맛집')
    expect(body.language).toBe('korean')
    expect(asr).toHaveBeenCalledTimes(1)
  })

  it('never returns the API key', async () => {
    process.env.OPENAI_API_KEY = 'sk-proj-SECRETVALUE'
    stub_asr(Response.json({ text: 'x', duration: 1 }))
    const res = await POST(upload(new File([new Uint8Array(10)], 'a.mp4')))
    expect(JSON.stringify(await res.json())).not.toContain('SECRETVALUE')
  })

  it('maps a provider failure to 502, not a 500 with a stack trace', async () => {
    process.env.OPENAI_API_KEY = 'sk-proj-x'
    stub_asr(new Response('upstream down', { status: 503 }))
    const res = await POST(upload(new File([new Uint8Array(10)], 'a.mp4')))
    expect(res.status).toBe(502)
    expect((await res.json()).error.kind).toBe('asr_failed')
  })

  it('does not accept a URL field — the URL path is CLI-only (H6)', async () => {
    process.env.OPENAI_API_KEY = 'sk-proj-x'
    const asr = stub_asr(Response.json({ text: 'x' }))
    const res = await POST(upload(null, { url: 'https://www.instagram.com/reel/AAA/' }))
    expect(res.status).toBe(400)
    expect(asr).not.toHaveBeenCalled()
  })
})
