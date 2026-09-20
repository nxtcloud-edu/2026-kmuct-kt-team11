import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { run_asr } from '@/lib/extraction/rungs/asr'
import { ProviderConfigError, provider_config } from '@/lib/extraction/provider'
import { MAX_DIRECT_BYTES } from '@/lib/extraction/upload'

// Transcription takes tens of seconds for a long reel; the platform default would cut it off.
export const maxDuration = 60

/**
 * Accepts an uploaded file only. There is deliberately no `url` field: fetching an
 * Instagram URL needs yt-dlp, which is dev-only (H6) — the CLI owns that path, and
 * production ingest will arrive as a DM attachment instead.
 *
 * Errors are `{ error: { kind, message } }` with a status that says whose fault it
 * is. `kind` is what a client should branch on; `message` is for a human.
 */
function fail(status: number, kind: string, message: string) {
  return Response.json({ error: { kind, message } }, { status })
}

/** File extension kept only if it is plain alphanumerics — it is the sole part of the upload's name that reaches disk. */
function safe_ext(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase()
  return /^[a-z0-9]{1,5}$/.test(ext) ? `.${ext}` : ''
}

export async function POST(req: Request) {
  // A cheap early refusal before the body is parsed. Multipart framing adds a
  // little overhead to the file itself, hence the allowance.
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DIRECT_BYTES + 1024 * 1024) {
    return fail(413, 'too_large', '파일이 너무 커요. 25MB 이하로 올려 주세요.')
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return fail(400, 'bad_request', 'multipart/form-data 로 파일을 보내 주세요.')
  }

  const file = form.get('file')
  if (!(file instanceof File)) return fail(400, 'no_file', "'file' 필드에 파일이 필요해요.")
  if (file.size === 0) return fail(400, 'empty_file', '빈 파일이에요.')
  if (file.size > MAX_DIRECT_BYTES) return fail(413, 'too_large', '파일이 너무 커요. 25MB 이하로 올려 주세요.')

  try {
    provider_config()
  } catch (e) {
    if (e instanceof ProviderConfigError) return fail(503, 'not_configured', e.message)
    throw e
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcribe-'))
  try {
    const video_path = path.join(dir, `upload${safe_ext(file.name)}`)
    await writeFile(video_path, Buffer.from(await file.arrayBuffer()))

    const result = await run_asr({ reel_id: 'upload', video_path, duration_s: null, has_audio: true })
    if (!result.ok) return fail(502, 'asr_failed', result.error ?? '전사에 실패했어요.')

    return Response.json({
      transcript: result.transcript,
      language: result.language,
      ms: result.ms,
      cost_usd: result.cost_usd,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
