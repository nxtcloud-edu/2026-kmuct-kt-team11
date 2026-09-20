/**
 * The ASR rung: speech in a video or audio file → text.
 *
 * It transcribes what is SAID. Burned-in captions, signage and menu boards are
 * invisible to it — that is the vision rung's job, which this slice does not
 * include. A music-only reel legitimately returns an empty transcript.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AsrRung, Media } from '../types'
import { estimate_asr_cost, provider_config, type ProviderConfig } from '../provider'
import { MAX_DIRECT_BYTES, plan_upload } from '../upload'

const exec_file = promisify(execFile)

export type AsrDeps = {
  config?: ProviderConfig
  fetch?: typeof fetch
  /** Pulls audio out of `src` into `dest`. Defaults to ffmpeg. */
  extract_audio?: (src: string, dest: string) => Promise<void>
  max_bytes?: number
}

/**
 * 16 kHz mono is what speech models are trained on; sending the full-rate stereo
 * track costs upload time and buys no accuracy. Low bitrate keeps a long reel
 * under the API's size limit.
 */
async function ffmpeg_extract(src: string, dest: string): Promise<void> {
  await exec_file('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', dest])
}

/** Strips the key from anything that is about to become a message, in case a provider echoes headers. */
function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text
}

export async function run_asr(media: Media, deps: AsrDeps = {}): Promise<AsrRung> {
  const started = Date.now()
  const elapsed = () => Date.now() - started

  if (!media.has_audio) {
    return { ok: true, transcript: null, language: null, skipped: 'no_audio', ms: elapsed(), cost_usd: 0 }
  }

  let scratch: string | null = null
  let secret = ''
  try {
    const config = deps.config ?? provider_config()
    secret = config.api_key
    const max_bytes = deps.max_bytes ?? MAX_DIRECT_BYTES

    let upload_path = media.video_path
    let upload_name = path.basename(media.video_path)

    const plan = plan_upload(upload_name, statSync(media.video_path).size)
    if (plan.kind === 'extract') {
      scratch = mkdtempSync(path.join(os.tmpdir(), 'asr-'))
      const dest = path.join(scratch, 'audio.mp3')
      try {
        await (deps.extract_audio ?? ffmpeg_extract)(media.video_path, dest)
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') {
          throw new Error(
            `ffmpeg is required for this file (${plan.reason === 'too_large' ? 'over the API size limit' : 'a container the API does not accept'}) but was not found on PATH`,
          )
        }
        throw err
      }
      upload_path = dest
      upload_name = 'audio.mp3'

      if (statSync(dest).size > max_bytes) {
        throw new Error('audio is still too large for the transcription API after extraction')
      }
    }

    const form = new FormData()
    form.append('file', new Blob([readFileSync(upload_path)]), upload_name)
    form.append('model', config.asr_model)
    form.append('response_format', 'verbose_json')

    const res = await (deps.fetch ?? fetch)(`${config.base_url}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.api_key}` },
      body: form,
      // A stuck upload should fail this rung, not hang the request or the CLI.
      signal: AbortSignal.timeout(120_000),
    })

    if (!res.ok) {
      throw new Error(`provider returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }

    const body = (await res.json()) as { text?: string; language?: string; duration?: number }
    return {
      ok: true,
      transcript: body.text ?? '',
      language: body.language ?? null,
      ms: elapsed(),
      cost_usd: estimate_asr_cost(body.duration ?? media.duration_s ?? 0),
    }
  } catch (err) {
    return {
      ok: false,
      transcript: null,
      language: null,
      ms: elapsed(),
      cost_usd: 0,
      error: scrub(err instanceof Error ? err.message : String(err), secret),
    }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
}
