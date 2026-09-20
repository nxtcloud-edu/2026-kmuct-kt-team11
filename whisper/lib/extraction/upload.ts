/**
 * Decides whether a file can go to the transcription API as it is.
 *
 * The API accepts video containers such as mp4 and webm directly and pulls the
 * audio out itself, so the common case — a reel saved as mp4 — needs no local
 * tooling at all. ffmpeg is only the fallback for a container the API rejects or
 * a file over its size limit, which keeps the deployed path free of system
 * binaries in the ordinary case.
 */
export const MAX_DIRECT_BYTES = 25 * 1024 * 1024

export const DIRECT_EXTENSIONS: ReadonlySet<string> = new Set([
  'flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'ogg', 'wav', 'webm',
])

export type UploadPlan =
  | { kind: 'direct' }
  | { kind: 'extract'; reason: 'unsupported_container' | 'too_large' }

export function plan_upload(file_name: string, size_bytes: number): UploadPlan {
  const dot = file_name.lastIndexOf('.')
  const ext = dot === -1 ? '' : file_name.slice(dot + 1).toLowerCase()

  // Container is checked first so the reason names the more fundamental problem:
  // extracting a smaller file would not help a container the API cannot read,
  // but extracting audio does fix an oversized supported one.
  if (!DIRECT_EXTENSIONS.has(ext)) return { kind: 'extract', reason: 'unsupported_container' }
  if (size_bytes > MAX_DIRECT_BYTES) return { kind: 'extract', reason: 'too_large' }
  return { kind: 'direct' }
}
