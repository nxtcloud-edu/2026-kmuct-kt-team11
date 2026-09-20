import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run_asr } from './asr'
import type { Media } from '../types'
import type { ProviderConfig } from '../provider'

const config: ProviderConfig = {
  base_url: 'https://asr.test/v1',
  api_key: 'test-key',
  asr_model: 'whisper-1',
}

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'asr-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function media_file(name: string, bytes = 100, has_audio = true): Media {
  const video_path = path.join(dir, name)
  writeFileSync(video_path, Buffer.alloc(bytes, 1))
  return { reel_id: 'R', video_path, duration_s: 60, has_audio }
}

/** A stand-in for fetch that records the call and answers with `reply`. */
function fake_fetch(reply: Response | (() => Response)) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return typeof reply === 'function' ? reply() : reply
  }) as typeof fetch
  return { impl, calls }
}

describe('run_asr', () => {
  it('skips cleanly when the reel has no audio track — a result, not an error', async () => {
    const { impl, calls } = fake_fetch(Response.json({}))
    const r = await run_asr(media_file('x.mp4', 100, false), { config, fetch: impl })
    expect(r).toMatchObject({ ok: true, skipped: 'no_audio', transcript: null, cost_usd: 0 })
    expect(calls).toHaveLength(0)
  })

  it('sends a supported container as-is and returns the transcript', async () => {
    const { impl, calls } = fake_fetch(Response.json({ text: '성수동 어니언 카페', language: 'korean', duration: 60 }))
    const r = await run_asr(media_file('x.mp4'), { config, fetch: impl })

    expect(r.ok).toBe(true)
    expect(r.transcript).toBe('성수동 어니언 카페')
    expect(r.language).toBe('korean')
    expect(r.cost_usd).toBeCloseTo(0.006, 6)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://asr.test/v1/audio/transcriptions')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer test-key')
    const form = calls[0].init.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect((form.get('file') as File).name).toBe('x.mp4')
  })

  it('treats a silent or music-only reel as data: ok with an empty transcript', async () => {
    const { impl } = fake_fetch(Response.json({ text: '', language: 'korean', duration: 12 }))
    const r = await run_asr(media_file('x.mp4'), { config, fetch: impl })
    expect(r).toMatchObject({ ok: true, transcript: '' })
  })

  it('records a provider failure on the result instead of throwing', async () => {
    const { impl } = fake_fetch(() => new Response('bad key', { status: 401 }))
    const r = await run_asr(media_file('x.mp4'), { config, fetch: impl })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/401/)
    expect(r.transcript).toBeNull()
  })

  it('does not leak the API key into an error message', async () => {
    const impl = (async () => { throw new Error('boom test-key boom') }) as unknown as typeof fetch
    const r = await run_asr(media_file('x.mp4'), { config, fetch: impl })
    expect(r.ok).toBe(false)
    expect(r.error).not.toContain('test-key')
  })

  it('extracts audio first when the container is unsupported, and uploads the extracted file', async () => {
    const { impl, calls } = fake_fetch(Response.json({ text: '안녕', language: 'korean', duration: 5 }))
    const extracted: string[] = []
    const r = await run_asr(media_file('clip.mov'), {
      config,
      fetch: impl,
      extract_audio: async (_src, dest) => {
        extracted.push(dest)
        writeFileSync(dest, Buffer.alloc(50, 2))
      },
    })
    expect(r.ok).toBe(true)
    expect(extracted).toHaveLength(1)
    expect(((calls[0].init.body as FormData).get('file') as File).name).toBe('audio.mp3')
  })

  it('reports a missing ffmpeg as a setup problem when extraction is needed', async () => {
    const { impl, calls } = fake_fetch(Response.json({ text: 'x' }))
    const r = await run_asr(media_file('clip.mov'), {
      config,
      fetch: impl,
      extract_audio: async () => { throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) },
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/ffmpeg/i)
    expect(calls).toHaveLength(0)
  })

  it('fails loudly when the extracted audio is still over the API limit', async () => {
    const { impl, calls } = fake_fetch(Response.json({ text: 'x' }))
    const r = await run_asr(media_file('clip.mov'), {
      config,
      fetch: impl,
      max_bytes: 10,
      extract_audio: async (_s, dest) => writeFileSync(dest, Buffer.alloc(11)),
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/too large/i)
    expect(calls).toHaveLength(0)
  })

  it('cleans up the temporary extraction directory', async () => {
    const { impl } = fake_fetch(Response.json({ text: 'x', duration: 1 }))
    let dest_dir = ''
    await run_asr(media_file('clip.mov'), {
      config,
      fetch: impl,
      extract_audio: async (_s, dest) => { dest_dir = path.dirname(dest); writeFileSync(dest, 'a') },
    })
    const { existsSync } = await import('node:fs')
    expect(dest_dir).not.toBe('')
    expect(existsSync(dest_dir)).toBe(false)
  })
})
