/**
 * Types for the ASR slice of the extraction harness (spec 2026-09-20).
 *
 * Persisted/returned shapes use snake_case to match `lib/api/types.ts`, so the
 * TS types and the JSON the route returns are one spelling with no mapping layer.
 */

/** What every rung sees: a local file and a little metadata. Never a URL or a stream. */
export type Media = {
  reel_id: string
  video_path: string
  duration_s: number | null
  /**
   * `false` only when the source *knows* there is no audio track (yt-dlp reports
   * it). An uploaded file is not probed, so it is `true` and a silent one simply
   * comes back with an empty transcript.
   */
  has_audio: boolean
}

export type AsrRung = {
  ok: boolean
  /** `''` means the API heard no speech — data, not failure. `null` means no attempt or a failed one. */
  transcript: string | null
  language: string | null
  /** Set when the rung correctly did nothing, e.g. 'no_audio'. Not an error. */
  skipped?: string
  ms: number
  cost_usd: number
  error?: string
}
