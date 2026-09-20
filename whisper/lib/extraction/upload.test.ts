import { describe, it, expect } from 'vitest'
import { plan_upload, MAX_DIRECT_BYTES } from './upload'

const MB = 1024 * 1024

describe('plan_upload', () => {
  it('sends a supported container as-is when it fits', () => {
    expect(plan_upload('clip.mp4', 5 * MB)).toEqual({ kind: 'direct' })
    expect(plan_upload('voice.m4a', 1 * MB)).toEqual({ kind: 'direct' })
    expect(plan_upload('a.webm', 1 * MB)).toEqual({ kind: 'direct' })
  })

  it('is case-insensitive about the extension', () => {
    expect(plan_upload('CLIP.MP4', 1 * MB)).toEqual({ kind: 'direct' })
  })

  it('extracts audio from a container the API does not accept', () => {
    expect(plan_upload('clip.mov', 1 * MB)).toEqual({ kind: 'extract', reason: 'unsupported_container' })
    expect(plan_upload('clip.mkv', 1 * MB)).toEqual({ kind: 'extract', reason: 'unsupported_container' })
  })

  it('treats a file with no extension as unsupported rather than guessing', () => {
    expect(plan_upload('clip', 1 * MB)).toEqual({ kind: 'extract', reason: 'unsupported_container' })
  })

  it('extracts audio when the file is over the API limit, even if the container is fine', () => {
    expect(plan_upload('big.mp4', MAX_DIRECT_BYTES + 1)).toEqual({ kind: 'extract', reason: 'too_large' })
  })

  it('treats a file exactly at the limit as still direct', () => {
    expect(plan_upload('edge.mp4', MAX_DIRECT_BYTES)).toEqual({ kind: 'direct' })
  })
})
