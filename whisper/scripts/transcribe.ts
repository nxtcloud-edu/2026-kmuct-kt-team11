/**
 * Dev-only CLI: Instagram reel URL (or a local file) → transcript.
 *
 *   npm run transcribe -- "https://www.instagram.com/reel/XXXX/"
 *   npm run transcribe -- ./clip.mp4 --json --out transcript.txt
 *
 * This is the only caller of YtDlpSource (H1/H6). Needs `yt-dlp` and `ffmpeg` on
 * PATH for the URL path; a local mp4 under 25MB needs neither.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse_args } from '../lib/extraction/cli-args'
import { MediaError, reel_id_from_url } from '../lib/extraction/media'
import { YtDlpSource } from '../lib/extraction/media/yt-dlp'
import { run_asr } from '../lib/extraction/rungs/asr'
import { ProviderConfigError } from '../lib/extraction/provider'
import type { Media } from '../lib/extraction/types'

/**
 * tsx does not read .env.local the way `next dev` does. loadEnvFile never
 * overrides a variable that is already set, which reproduces Next's precedence:
 * a shell or Windows environment variable beats the file.
 */
function load_env() {
  for (const name of ['.env.local', '.env']) {
    if (existsSync(name)) process.loadEnvFile(name)
  }
}

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

async function resolve_media(target: string): Promise<Media> {
  if (existsSync(target) && statSync(target).isFile()) {
    return { reel_id: path.parse(target).name, video_path: path.resolve(target), duration_s: null, has_audio: true }
  }
  if (!reel_id_from_url(target)) fail(`'${target}' is neither an existing file nor an Instagram reel URL.`)
  return new YtDlpSource().resolve(target)
}

async function main() {
  load_env()
  const { target, json, out } = parse_args(process.argv.slice(2))
  if (!target) fail('usage: npm run transcribe -- <reel-url | file> [--json] [--out <file>]')

  let media: Media
  try {
    media = await resolve_media(target)
  } catch (e) {
    if (e instanceof MediaError) fail(`[media:${e.kind}] ${e.message}`, 2)
    throw e
  }

  const result = await run_asr(media)
  if (!result.ok) {
    // A missing/duplicated key is fixable by the developer, so it gets its own exit code and a plain message.
    fail(`[asr] ${result.error}`, result.error?.includes('sk-sk-') || result.error?.startsWith('No ASR key') ? 3 : 4)
  }

  if (result.skipped) console.error(`(skipped: ${result.skipped})`)
  const text = json ? JSON.stringify({ reel_id: media.reel_id, ...result }, null, 2) : (result.transcript ?? '')

  if (out) {
    writeFileSync(out, `${text}\n`, 'utf8')
    console.error(`wrote ${out}  (${result.transcript?.length ?? 0} chars, ~$${result.cost_usd.toFixed(4)}, ${result.ms}ms)`)
  } else {
    console.log(text)
    if (!json) console.error(`(${result.transcript?.length ?? 0} chars, ~$${result.cost_usd.toFixed(4)}, ${result.ms}ms)`)
  }
}

main().catch((e) => {
  if (e instanceof ProviderConfigError) fail(e.message, 3)
  fail(e instanceof Error ? e.message : String(e), 1)
})
