import { describe, it, expect } from 'vitest'
import { parse_args } from './cli-args'

describe('parse_args', () => {
  it('takes the target when there are no flags at all', () => {
    expect(parse_args(['./clip.mp4'])).toEqual({ target: './clip.mp4', json: false, out: null })
  })

  it('takes a URL target', () => {
    expect(parse_args(['https://www.instagram.com/reel/AAA/']).target).toBe('https://www.instagram.com/reel/AAA/')
  })

  it('reads --json', () => {
    expect(parse_args(['./clip.mp4', '--json'])).toMatchObject({ target: './clip.mp4', json: true })
  })

  it('reads --out with its value, and does not mistake the value for the target', () => {
    expect(parse_args(['./clip.mp4', '--out', 't.txt'])).toEqual({ target: './clip.mp4', json: false, out: 't.txt' })
  })

  it('finds the target when flags come first', () => {
    expect(parse_args(['--json', '--out', 't.txt', './clip.mp4'])).toEqual({ target: './clip.mp4', json: true, out: 't.txt' })
  })

  it('returns no target for an empty argv', () => {
    expect(parse_args([]).target).toBeUndefined()
  })

  it('returns no target when only flags are given', () => {
    expect(parse_args(['--json']).target).toBeUndefined()
  })

  it('treats a trailing --out with no value as unset', () => {
    expect(parse_args(['./clip.mp4', '--out']).out).toBeNull()
  })
})
