# Extraction Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a development-only harness that turns an Instagram reel URL into a labelled extraction eval row, recording every rung of the §6.2 ladder independently with its cost and latency.

**Architecture:** A pure-function library (`lib/extraction/`) driven by a thin CLI (`scripts/extract-eval.ts`). `MediaSource` is the only code that knows `yt-dlp` exists, so slice 3 later swaps `YtDlpSource` for `IgAttachmentSource` without touching the ladder. Each rung is a pure function over a local file and knows nothing of the others; `ladder.ts` owns sequencing alone; `confidence.ts` holds band boundaries as data.

**Tech Stack:** TypeScript 5 (strict), Next.js 16.3.5 repo conventions, zod 4 for row validation, Vitest for unit tests, `yt-dlp` and `ffmpeg` as system prerequisites, an OpenAI-compatible HTTP endpoint for vision and ASR.

**Spec:** `docs/superpowers/specs/2026-09-20-extraction-harness-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **H1** — library + thin CLI. Logic lives in `lib/extraction/`; `scripts/extract-eval.ts` is only a caller.
- **H2** — `MediaSource` is the only code that knows `yt-dlp` exists. No rung, and nothing in `ladder.ts`, may import from `lib/extraction/media/yt-dlp.ts`.
- **H3** — two modes: `--all-rungs` (default) and `--ladder`.
- **H4** — confidence boundaries are exported data in `confidence.ts`, never inline literals elsewhere.
- **H5** — every row is written, including total failures. A reel that fails media resolution still produces a row.
- **H6** — never deployed. A guard test asserts nothing under `app/` imports `media/yt-dlp`.
- **H7** — scraped reel media is never committed. Media cache is gitignored. Unit-test fixtures use clips we own.
- **H8** — vision and ASR vendors are swappable via env-configured base URL and model name.
- **Types:** persisted shapes use `snake_case` and `type` aliases, matching `lib/api/types.ts`. Reuse `PlaceCategory` from `lib/api/types.ts` rather than redefining it.
- **TS config:** `strict: true`, target ES2017, `moduleResolution: bundler`, path alias `@/*` → repo root.
- **Comments explain why, not what** — matching the house style in `lib/api/types.ts`.
- **No new runtime npm dependencies.** dHash is implemented inline; zod is already present. Vitest is a dev dependency only.
- **Corpus target:** ~30 reels, matching parent spec §11.

---

### Task 1: Vitest setup and core types

**Files:**
- Create: `vitest.config.mts`
- Create: `lib/extraction/types.ts`
- Create: `lib/extraction/types.test.ts`
- Modify: `package.json` (add `test` script and dev dependencies)
- Modify: `.gitignore` (add media cache)

**Interfaces:**
- Consumes: `PlaceCategory` from `lib/api/types.ts`
- Produces: `Confidence`, `Media`, `PlaceCandidate`, `CaptionRung`, `VisionRung`, `AsrRung`, `EvalRow`, `evalRowSchema`

- [ ] **Step 1: Install dev dependencies**

The Next.js guide at `node_modules/next/dist/docs/01-app/02-guides/testing/vitest.md` lists `@vitejs/plugin-react`, `jsdom` and Testing Library. This harness tests pure Node functions and renders no components, so those three are deliberately omitted.

```bash
npm install -D vitest vite-tsconfig-paths
```

- [ ] **Step 2: Create the Vitest config**

```ts
// vitest.config.mts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // 'node', not 'jsdom': the harness is pure Node — no components, no DOM.
    environment: 'node',
    include: ['lib/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
```

- [ ] **Step 3: Add the test script to package.json**

In the `"scripts"` block, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

`vitest run` (single-shot) is the default so CI and agents do not hang on watch mode.

- [ ] **Step 4: Add the media cache to .gitignore**

Append:

```
# H7: scraped reel media is never committed — it is third-party copyrighted video.
/.cache/reels/
```

- [ ] **Step 5: Write the failing test**

```ts
// lib/extraction/types.test.ts
import { describe, it, expect } from 'vitest'
import { evalRowSchema } from './types'

const validRow = {
  reel_id: 'DdRyQxKteC1',
  source_url: 'https://www.instagram.com/nasa/reel/DdRyQxKteC1/',
  fetched_at: '2026-09-20T11:42:00.000Z',
  harness_version: '1',
  media: { duration_s: 58, res: '892x1584', has_audio: true },
  rungs: {
    caption: { ok: true, text: null, keywords: [], ms: 2, cost_usd: 0 },
    vision: { ok: true, frames_used: 6, candidate: null, ms: 4120, cost_usd: 0.0031 },
    asr: { ok: true, transcript: null, language: null, ms: 8300, cost_usd: 0.0006 },
  },
  derived: { candidate: null, confidence: 'medium', decided_by: 'vision' },
  ground_truth: null,
}

describe('evalRowSchema', () => {
  it('accepts a well-formed row', () => {
    expect(evalRowSchema.safeParse(validRow).success).toBe(true)
  })

  it('accepts a row whose media failed to resolve (H5)', () => {
    const failed = {
      ...validRow,
      media: null,
      error: { stage: 'media', kind: 'blocked', message: 'HTTP 401' },
    }
    expect(evalRowSchema.safeParse(failed).success).toBe(true)
  })

  it('rejects an unknown confidence band', () => {
    const bad = { ...validRow, derived: { ...validRow.derived, confidence: 'great' } }
    expect(evalRowSchema.safeParse(bad).success).toBe(false)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run lib/extraction/types.test.ts`
Expected: FAIL — `Failed to resolve import "./types"`.

- [ ] **Step 7: Write the types**

```ts
// lib/extraction/types.ts
/**
 * Types for the extraction harness (spec 2026-09-20).
 *
 * Persisted shapes use snake_case to match `lib/api/types.ts` and the eval-row
 * format in spec §7. Writing the TS types in the same case as the JSON removes
 * a mapping layer that would otherwise need its own tests.
 */
import { z } from 'zod'
import type { PlaceCategory } from '@/lib/api/types'

/** Inherited unchanged from parent spec §6.4. The harness assigns; it never redefines. */
export type Confidence = 'high' | 'medium' | 'low' | 'none'

/** Internal, never persisted whole — only `media_summary` reaches the row. */
export type Media = {
  reel_id: string
  video_path: string
  caption_text: string | null
  duration_s: number | null
  width: number
  height: number
  has_audio: boolean
}

export type RungName = 'caption' | 'vision' | 'asr'

/**
 * Mirrored by hand from `PlaceCategory`, because zod needs a literal tuple.
 * The two guards below make drift a compile error rather than a runtime
 * surprise: `satisfies` checks every member is a real PlaceCategory, and
 * `_exhaustive` fails if PlaceCategory gains one this list is missing.
 */
export const PLACE_CATEGORIES = [
  'cafe', 'restaurant', 'exhibition', 'shop', 'activity',
] as const satisfies readonly PlaceCategory[]

type _Exhaustive =
  Exclude<PlaceCategory, (typeof PLACE_CATEGORIES)[number]> extends never ? true : never
const _exhaustive: _Exhaustive = true
void _exhaustive

export const placeCandidateSchema = z.object({
  name: z.string().nullable(),
  category: z.enum(PLACE_CATEGORIES).nullable(),
  area: z.string().nullable(),
  hook: z.string().nullable(),
  visible_price: z.string().nullable(),
  score: z.number().min(0).max(1),
})

const captionRungSchema = z.object({
  ok: z.boolean(),
  text: z.string().nullable(),
  keywords: z.array(z.string()),
  ms: z.number(),
  cost_usd: z.number(),
  error: z.string().optional(),
})

const visionRungSchema = z.object({
  ok: z.boolean(),
  frames_used: z.number(),
  candidate: placeCandidateSchema.nullable(),
  ms: z.number(),
  cost_usd: z.number(),
  error: z.string().optional(),
})

const asrRungSchema = z.object({
  ok: z.boolean(),
  transcript: z.string().nullable(),
  language: z.string().nullable(),
  /** Set when the rung correctly did nothing, e.g. 'no_audio'. Not an error. */
  skipped: z.string().optional(),
  ms: z.number(),
  cost_usd: z.number(),
  error: z.string().optional(),
})

/** Derived from the schema so the type and the validator can never disagree. */
export type PlaceCandidate = z.infer<typeof placeCandidateSchema>

export type CaptionRung = z.infer<typeof captionRungSchema>
export type VisionRung = z.infer<typeof visionRungSchema>
export type AsrRung = z.infer<typeof asrRungSchema>

export const evalRowSchema = z.object({
  reel_id: z.string(),
  source_url: z.string(),
  fetched_at: z.string(),
  harness_version: z.string(),
  media: z
    .object({
      duration_s: z.number().nullable(),
      res: z.string(),
      has_audio: z.boolean(),
    })
    .nullable(),
  rungs: z.object({
    caption: captionRungSchema,
    vision: visionRungSchema,
    asr: asrRungSchema,
  }),
  derived: z.object({
    candidate: placeCandidateSchema.nullable(),
    confidence: z.enum(['high', 'medium', 'low', 'none']),
    decided_by: z.enum(['caption', 'vision', 'asr']).nullable(),
  }),
  /**
   * Filled by hand. This is what makes the file an eval row rather than a log
   * line — nothing automated writes it. `place_id` stays null until slice 2 can
   * resolve candidates; see spec §7.1.
   */
  ground_truth: z
    .object({
      place_name: z.string(),
      place_id: z.string().nullable(),
      note: z.string().optional(),
    })
    .nullable(),
  /** Present only when media resolution failed outright (H5). */
  error: z
    .object({
      stage: z.literal('media'),
      kind: z.enum(['blocked', 'private', 'deleted', 'extractor', 'unknown']),
      message: z.string(),
    })
    .optional(),
})

export type EvalRow = z.infer<typeof evalRowSchema>

export const HARNESS_VERSION = '1'
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run lib/extraction/types.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 9: Commit**

```bash
git add vitest.config.mts package.json package-lock.json .gitignore lib/extraction/types.ts lib/extraction/types.test.ts
git commit -m "Harness: vitest setup and core extraction types"
```

---

### Task 2: Confidence bands

**Files:**
- Create: `lib/extraction/confidence.ts`
- Create: `lib/extraction/confidence.test.ts`

**Interfaces:**
- Consumes: `Confidence` from `lib/extraction/types.ts`
- Produces: `BANDS` (exported tunable table), `band_for(score: number): Confidence`

- [ ] **Step 1: Write the failing test**

```ts
// lib/extraction/confidence.test.ts
import { describe, it, expect } from 'vitest'
import { BANDS, band_for } from './confidence'

describe('band_for', () => {
  it('maps scores to the four bands from parent spec §6.4', () => {
    expect(band_for(0.95)).toBe('high')
    expect(band_for(0.70)).toBe('medium')
    expect(band_for(0.40)).toBe('low')
    expect(band_for(0.05)).toBe('none')
  })

  it('treats each threshold as inclusive of its own band', () => {
    expect(band_for(BANDS.high)).toBe('high')
    expect(band_for(BANDS.medium)).toBe('medium')
    expect(band_for(BANDS.low)).toBe('low')
  })

  it('clamps out-of-range input rather than throwing', () => {
    expect(band_for(2)).toBe('high')
    expect(band_for(-1)).toBe('none')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/extraction/confidence.test.ts`
Expected: FAIL — `Failed to resolve import "./confidence"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/extraction/confidence.ts
/**
 * Confidence band boundaries.
 *
 * H4: these are DATA, not code. The parent spec (§6.2) states the boundaries are
 * tuned against the extraction eval set rather than fixed at design time, so
 * tuning must be editing this table — never hunting literals across rungs.
 *
 * The starting values below are deliberate guesses. They are expected to move
 * once the first ~30-reel corpus exists; a run that moves them is the harness
 * working, not failing.
 */
import type { Confidence } from './types'

export const BANDS = {
  high: 0.85,
  medium: 0.60,
  low: 0.25,
} as const

export function band_for(score: number): Confidence {
  const s = Math.min(1, Math.max(0, score))
  if (s >= BANDS.high) return 'high'
  if (s >= BANDS.medium) return 'medium'
  if (s >= BANDS.low) return 'low'
  return 'none'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/extraction/confidence.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/confidence.ts lib/extraction/confidence.test.ts
git commit -m "Harness: confidence bands as a tunable table"
```

---

### Task 3: MediaSource interface, reel-id parsing, and the cache

**Files:**
- Create: `lib/extraction/media/index.ts`
- Create: `lib/extraction/media/index.test.ts`

**Interfaces:**
- Consumes: `Media` from `lib/extraction/types.ts`
- Produces: `MediaSource` (type), `reel_id_from_url(url: string): string | null`, `cache_dir_for(reel_id: string): string`, `MediaError` (class)

- [ ] **Step 1: Write the failing test**

```ts
// lib/extraction/media/index.test.ts
import { describe, it, expect } from 'vitest'
import { reel_id_from_url, cache_dir_for, MediaError } from './index'

describe('reel_id_from_url', () => {
  it('extracts the id from the /<user>/reel/<id>/ form', () => {
    expect(reel_id_from_url('https://www.instagram.com/nasa/reel/DdRyQxKteC1/'))
      .toBe('DdRyQxKteC1')
  })

  it('extracts the id from the bare /reel/<id>/ form', () => {
    expect(reel_id_from_url('https://instagram.com/reel/DdRyQxKteC1'))
      .toBe('DdRyQxKteC1')
  })

  it('extracts the id from the /p/<id>/ post form', () => {
    expect(reel_id_from_url('https://www.instagram.com/p/DdRyQxKteC1/'))
      .toBe('DdRyQxKteC1')
  })

  it('ignores query strings such as ?igsh=', () => {
    expect(reel_id_from_url('https://www.instagram.com/reel/DdRyQxKteC1/?igsh=abc123'))
      .toBe('DdRyQxKteC1')
  })

  it('returns null for a non-Instagram URL', () => {
    expect(reel_id_from_url('https://example.com/reel/DdRyQxKteC1/')).toBeNull()
  })

  it('returns null for unparseable input', () => {
    expect(reel_id_from_url('not a url')).toBeNull()
  })
})

describe('cache_dir_for', () => {
  it('namespaces each reel under the gitignored cache root', () => {
    expect(cache_dir_for('DdRyQxKteC1')).toMatch(/\.cache\/reels\/DdRyQxKteC1$/)
  })

  it('rejects an id containing path separators', () => {
    expect(() => cache_dir_for('../../etc')).toThrow(MediaError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/extraction/media/index.test.ts`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/extraction/media/index.ts
/**
 * The media boundary.
 *
 * H2: this interface is the ONLY seam that knows where a reel's bytes come from.
 * The dev harness implements it with yt-dlp; slice 3 implements it with the Meta
 * CDN URL that arrives on the DM webhook. Everything above this line — every
 * rung, and the ladder — sees only `Media` and a local file path, which is what
 * makes the corpus collected now still valid in production.
 *
 * This mirrors `PlaceSource` in parent spec §4: one interface, one fragile
 * implementation behind it, everything else insulated.
 */
import path from 'node:path'
import type { Media } from '../types'

/** The kinds of media failure worth telling apart. See spec §8. */
export type MediaErrorKind =
  | 'blocked'    // 401/429 — IP reputation, usually a datacenter address
  | 'private'    // the post exists but is not public
  | 'deleted'    // the post is gone
  | 'extractor'  // yt-dlp parsed nothing — the extractor has rotted
  | 'unknown'

export class MediaError extends Error {
  constructor(
    readonly kind: MediaErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'MediaError'
  }
}

export type MediaSource = {
  resolve(ref: string): Promise<Media>
}

/** Repo-root-relative cache. Gitignored per H7 — this holds other people's video. */
export const CACHE_ROOT = path.join(process.cwd(), '.cache', 'reels')

const INSTAGRAM_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
])

/**
 * Instagram exposes the same media under /reel/, /reels/ and /p/, with and
 * without a username segment. All four forms appear in the wild when a user
 * copies a link, so all four are accepted.
 */
export function reel_id_from_url(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!INSTAGRAM_HOSTS.has(parsed.hostname.toLowerCase())) return null

  const segments = parsed.pathname.split('/').filter(Boolean)
  const marker = segments.findIndex((s) => s === 'reel' || s === 'reels' || s === 'p')
  if (marker === -1) return null

  const id = segments[marker + 1]
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null
}

export function cache_dir_for(reel_id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(reel_id)) {
    throw new MediaError('unknown', `unsafe reel id: ${reel_id}`)
  }
  return path.join(CACHE_ROOT, reel_id)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/extraction/media/index.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/media/index.ts lib/extraction/media/index.test.ts
git commit -m "Harness: MediaSource boundary, reel-id parsing, cache layout"
```

---

### Task 4: YtDlpSource and the H6 guard test

**Files:**
- Create: `lib/extraction/media/yt-dlp.ts`
- Create: `lib/extraction/media/yt-dlp.test.ts`
- Create: `lib/extraction/media/no-ytdlp-in-app.test.ts`

**Interfaces:**
- Consumes: `MediaSource`, `MediaError`, `cache_dir_for`, `reel_id_from_url` from `lib/extraction/media/index.ts`; `Media` from `lib/extraction/types.ts`
- Produces: `YtDlpSource` (class implementing `MediaSource`), `classify_ytdlp_error(stderr: string): MediaErrorKind`

- [ ] **Step 1: Write the failing test**

`classify_ytdlp_error` is a pure function over stderr text, so it is unit-testable without invoking yt-dlp. The download path itself is exercised manually in Task 10, not mocked here — mocking `child_process` would test the mock.

```ts
// lib/extraction/media/yt-dlp.test.ts
import { describe, it, expect } from 'vitest'
import { classify_ytdlp_error } from './yt-dlp'

describe('classify_ytdlp_error', () => {
  it('reads rate-limiting and auth walls as blocked', () => {
    expect(classify_ytdlp_error('ERROR: HTTP Error 401: Unauthorized')).toBe('blocked')
    expect(classify_ytdlp_error('ERROR: HTTP Error 429: Too Many Requests')).toBe('blocked')
    expect(classify_ytdlp_error('ERROR: Requested content is not available, rate-limit reached'))
      .toBe('blocked')
  })

  it('distinguishes a private post from a blocked request', () => {
    expect(classify_ytdlp_error('ERROR: This post is private')).toBe('private')
    expect(classify_ytdlp_error('ERROR: You need to log in to access this content'))
      .toBe('private')
  })

  it('reads a missing post as deleted', () => {
    expect(classify_ytdlp_error('ERROR: HTTP Error 404: Not Found')).toBe('deleted')
  })

  it('reads a parse failure as extractor rot, not as blocking', () => {
    expect(classify_ytdlp_error('ERROR: Unable to extract shared data')).toBe('extractor')
    expect(classify_ytdlp_error('ERROR: Unable to extract video url')).toBe('extractor')
  })

  it('falls back to unknown', () => {
    expect(classify_ytdlp_error('ERROR: something nobody predicted')).toBe('unknown')
  })
})
```

- [ ] **Step 2: Write the H6 guard test**

```ts
// lib/extraction/media/no-ytdlp-in-app.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * H6: the harness is never deployed. YtDlpSource carries ToS exposure and
 * datacenter-IP fragility, so it must not be reachable from application code.
 * Convention is not enough when the failure mode is shipping a liability.
 */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

describe('H6 deployment guard', () => {
  it('no file under app/ imports the yt-dlp media source', () => {
    const offenders = walk(path.join(process.cwd(), 'app')).filter((file) =>
      /from\s+['"].*media\/yt-dlp['"]/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run lib/extraction/media/`
Expected: `yt-dlp.test.ts` FAILS with `Failed to resolve import "./yt-dlp"`. `no-ytdlp-in-app.test.ts` PASSES already (nothing imports it yet) — that is correct; it is a regression guard, not a red test.

- [ ] **Step 4: Write the implementation**

```ts
// lib/extraction/media/yt-dlp.ts
/**
 * DEV-ONLY MediaSource. Never import this from `app/` — see the H6 guard test.
 *
 * yt-dlp is a system prerequisite, not an npm dependency, and deliberately so:
 * its Instagram extractor breaks on the order of weeks, and pinning a scraper as
 * a build dependency guarantees a stale extractor at the moment one is needed.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Media } from '../types'
import { MediaError, cache_dir_for, reel_id_from_url, type MediaErrorKind, type MediaSource } from './index'

const exec_file = promisify(execFile)

export function classify_ytdlp_error(stderr: string): MediaErrorKind {
  const s = stderr.toLowerCase()
  // Order matters: 'log in' appears in some rate-limit messages too, so the
  // explicit privacy phrasing is checked before the generic auth wall.
  if (s.includes('private')) return 'private'
  if (s.includes('404') || s.includes('not found')) return 'deleted'
  if (s.includes('401') || s.includes('429') || s.includes('rate-limit')) return 'blocked'
  if (s.includes('log in') || s.includes('login required')) return 'private'
  if (s.includes('unable to extract')) return 'extractor'
  return 'unknown'
}

type YtDlpJson = {
  id?: string
  description?: string
  title?: string
  duration?: number | null
  width?: number
  height?: number
  acodec?: string
}

export class YtDlpSource implements MediaSource {
  async resolve(ref: string): Promise<Media> {
    const reel_id = reel_id_from_url(ref)
    if (!reel_id) throw new MediaError('unknown', `not an Instagram URL: ${ref}`)

    const dir = cache_dir_for(reel_id)
    mkdirSync(dir, { recursive: true })

    let meta: YtDlpJson
    try {
      const { stdout } = await exec_file(
        'yt-dlp',
        [
          '--dump-json',
          '--no-warnings',
          '-o', path.join(dir, '%(id)s.%(ext)s'),
          ref,
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      )
      meta = JSON.parse(stdout) as YtDlpJson
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? String(err)
      throw new MediaError(classify_ytdlp_error(stderr), stderr.trim().slice(0, 500))
    }

    // Download only if the cache is cold. Re-running the harness over the same
    // corpus is normal (tuning), and re-downloading would multiply block risk.
    const existing = existsSync(dir)
      ? readdirSync(dir).find((f) => f.startsWith(reel_id) && !f.endsWith('.json'))
      : undefined

    if (!existing) {
      try {
        await exec_file(
          'yt-dlp',
          ['--no-warnings', '-o', path.join(dir, '%(id)s.%(ext)s'), ref],
          { maxBuffer: 32 * 1024 * 1024 },
        )
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr ?? String(err)
        throw new MediaError(classify_ytdlp_error(stderr), stderr.trim().slice(0, 500))
      }
    }

    const file = readdirSync(dir).find((f) => f.startsWith(reel_id) && !f.endsWith('.json'))
    if (!file) throw new MediaError('extractor', 'yt-dlp produced no media file')

    return {
      reel_id,
      video_path: path.join(dir, file),
      // §6.1: `title` is sometimes the caption and often empty. `description`
      // carries it when present. Both are recorded as-is; rung 1 decides what
      // is usable.
      caption_text: meta.description ?? meta.title ?? null,
      duration_s: meta.duration ?? null,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      has_audio: Boolean(meta.acodec && meta.acodec !== 'none'),
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/extraction/media/`
Expected: PASS — 6 tests in `yt-dlp.test.ts`, 1 in `no-ytdlp-in-app.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/extraction/media/yt-dlp.ts lib/extraction/media/yt-dlp.test.ts lib/extraction/media/no-ytdlp-in-app.test.ts
git commit -m "Harness: YtDlpSource with error classification and H6 guard"
```

---

### Task 5: Rung 1 — caption

**Files:**
- Create: `lib/extraction/rungs/caption.ts`
- Create: `lib/extraction/rungs/caption.test.ts`

**Interfaces:**
- Consumes: `Media`, `CaptionRung` from `lib/extraction/types.ts`
- Produces: `run_caption(media: Media): CaptionRung`

- [ ] **Step 1: Write the failing test**

```ts
// lib/extraction/rungs/caption.test.ts
import { describe, it, expect } from 'vitest'
import { run_caption } from './caption'
import type { Media } from '../types'

function media(caption_text: string | null): Media {
  return {
    reel_id: 'X', video_path: '/tmp/x.mp4', caption_text,
    duration_s: 10, width: 100, height: 200, has_audio: true,
  }
}

describe('run_caption', () => {
  it('returns no keywords when there is no caption', () => {
    const r = run_caption(media(null))
    expect(r.ok).toBe(true)
    expect(r.keywords).toEqual([])
    expect(r.cost_usd).toBe(0)
  })

  it('keeps Korean place-name tokens', () => {
    const r = run_caption(media('성수동 카페 어니언 다녀왔어요'))
    expect(r.keywords).toContain('성수동')
    expect(r.keywords).toContain('어니언')
  })

  it('strips hashtags, mentions and URLs', () => {
    const r = run_caption(media('#감성카페 @friend https://example.com 연남동'))
    expect(r.keywords).toEqual(['연남동'])
  })

  it('drops tokens shorter than two characters and de-duplicates', () => {
    const r = run_caption(media('a 성수 성수 b'))
    expect(r.keywords).toEqual(['성수'])
  })

  it('reports elapsed time and zero cost', () => {
    const r = run_caption(media('성수동'))
    expect(r.ms).toBeGreaterThanOrEqual(0)
    expect(r.cost_usd).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/extraction/rungs/caption.test.ts`
Expected: FAIL — `Failed to resolve import "./caption"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/extraction/rungs/caption.ts
/**
 * Rung 1 of the §6.2 ladder: caption text → keyword candidates.
 *
 * Free and synchronous, so it always runs. Parent spec §6.1 expects this rung to
 * be empty most of the time — a forwarded reel usually carries no caption. That
 * expectation is exactly what the corpus is being built to test, so an empty
 * result here is data, not a failure.
 */
import type { CaptionRung, Media } from '../types'

const NOISE = /(^#|^@|^https?:\/\/)/

export function run_caption(media: Media): CaptionRung {
  const started = Date.now()
  const text = media.caption_text

  const keywords = text
    ? Array.from(
        new Set(
          text
            .split(/[\s,./·|—–\-()[\]{}"'“”‘’!?]+/u)
            .filter((t) => t.length >= 2 && !NOISE.test(t)),
        ),
      )
    : []

  return {
    ok: true,
    text,
    keywords,
    ms: Date.now() - started,
    cost_usd: 0,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/extraction/rungs/caption.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/rungs/caption.ts lib/extraction/rungs/caption.test.ts
git commit -m "Harness: rung 1, caption keywords"
```

---

### Task 6: Frame sampling and dHash

**Files:**
- Create: `lib/extraction/rungs/frames.ts`
- Create: `lib/extraction/rungs/frames.test.ts`

**Interfaces:**
- Consumes: `Media` from `lib/extraction/types.ts`
- Produces: `dhash(gray_9x8: Buffer): bigint`, `hamming(a: bigint, b: bigint): number`, `sample_frames(media: Media, count?: number): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

dHash is pure arithmetic over a 72-byte grayscale buffer, so it tests without ffmpeg or any image library.

```ts
// lib/extraction/rungs/frames.test.ts
import { describe, it, expect } from 'vitest'
import { dhash, hamming } from './frames'

/** 9 columns x 8 rows of grayscale bytes, as ffmpeg emits for `-pix_fmt gray`. */
function buf(fill: (x: number, y: number) => number): Buffer {
  const b = Buffer.alloc(72)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) b[y * 9 + x] = fill(x, y)
  return b
}

describe('dhash', () => {
  it('hashes a flat image to zero — no pixel is brighter than its neighbour', () => {
    expect(dhash(buf(() => 128))).toBe(0n)
  })

  it('hashes a left-to-right ramp to all ones', () => {
    expect(dhash(buf((x) => x * 20))).toBe((1n << 64n) - 1n)
  })

  it('rejects a buffer that is not 72 bytes', () => {
    expect(() => dhash(Buffer.alloc(71))).toThrow()
  })
})

describe('hamming', () => {
  it('is zero for identical hashes', () => {
    expect(hamming(0b1011n, 0b1011n)).toBe(0)
  })

  it('counts differing bits', () => {
    expect(hamming(0b1011n, 0b1000n)).toBe(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/extraction/rungs/frames.test.ts`
Expected: FAIL — `Failed to resolve import "./frames"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/extraction/rungs/frames.ts
/**
 * Frame sampling for rung 2.
 *
 * Parent spec §6.2 calls for 8 frames, evenly sampled, deduped by perceptual
 * hash. Reels routinely hold a static title card for several seconds, so without
 * deduping the vision call pays for eight copies of the same image.
 *
 * ffmpeg is asked for a 9x8 grayscale rawvideo frame directly, which means dHash
 * needs no image-decoding library — it is arithmetic over 72 bytes. That is why
 * there is no npm image dependency here.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { Media } from '../types'

const exec_file = promisify(execFile)

/** Bits set where a pixel is brighter than the one to its right. 9 cols -> 8 bits/row. */
export function dhash(gray_9x8: Buffer): bigint {
  if (gray_9x8.length !== 72) {
    throw new Error(`dhash expects 72 bytes (9x8 gray), got ${gray_9x8.length}`)
  }
  let hash = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = gray_9x8[y * 9 + x]
      const right = gray_9x8[y * 9 + x + 1]
      hash = (hash << 1n) | (left < right ? 1n : 0n)
    }
  }
  return hash
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

/** Frames closer than this in Hamming distance are treated as the same shot. */
const DEDUPE_THRESHOLD = 8

async function grab(video_path: string, at_s: number, out_path: string): Promise<void> {
  await exec_file('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-ss', String(at_s),
    '-i', video_path,
    '-frames:v', '1',
    out_path,
  ])
}

async function fingerprint(video_path: string, at_s: number): Promise<bigint> {
  const { stdout } = await exec_file(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-ss', String(at_s),
      '-i', video_path,
      '-frames:v', '1',
      '-vf', 'scale=9:8',
      '-pix_fmt', 'gray',
      '-f', 'rawvideo', 'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  )
  return dhash(stdout as unknown as Buffer)
}

/**
 * Returns paths to the deduped sampled frames, written beside the video in the
 * reel's cache directory.
 */
export async function sample_frames(media: Media, count = 8): Promise<string[]> {
  const duration = media.duration_s && media.duration_s > 0 ? media.duration_s : 1
  const dir = path.dirname(media.video_path)

  const kept: string[] = []
  const seen: bigint[] = []

  for (let i = 0; i < count; i++) {
    // Sample at the midpoint of each of `count` equal slices, so neither the
    // first nor the last frame (often black) is guaranteed to be picked.
    const at = (duration * (i + 0.5)) / count
    let hash: bigint
    try {
      hash = await fingerprint(media.video_path, at)
    } catch {
      continue // a bad seek is not fatal; the other samples still stand
    }
    if (seen.some((h) => hamming(h, hash) < DEDUPE_THRESHOLD)) continue

    const out = path.join(dir, `frame_${String(i).padStart(2, '0')}.jpg`)
    await grab(media.video_path, at, out)
    seen.push(hash)
    kept.push(out)
  }

  return kept
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/extraction/rungs/frames.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/rungs/frames.ts lib/extraction/rungs/frames.test.ts
git commit -m "Harness: frame sampling with inline dHash dedupe"
```

---

### Task 7: The model provider seam

**Files:**
- Create: `lib/extraction/provider.ts`
- Create: `lib/extraction/provider.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `provider_config(): ProviderConfig`, `chat_json<T>(opts): Promise<{ parsed: unknown; cost_usd: number }>`, `ProviderConfigError`

- [ ] **Step 1: Write the failing test**

```ts
// lib/extraction/provider.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { provider_config, ProviderConfigError, estimate_cost } from './provider'

const saved = { ...process.env }
afterEach(() => { process.env = { ...saved } })

describe('provider_config', () => {
  it('throws a named error when the API key is absent', () => {
    delete process.env.AI_GATEWAY_API_KEY
    expect(() => provider_config()).toThrow(ProviderConfigError)
  })

  it('defaults the base URL and models when only a key is set', () => {
    process.env.AI_GATEWAY_API_KEY = 'k'
    delete process.env.AI_GATEWAY_BASE_URL
    delete process.env.VISION_MODEL
    const c = provider_config()
    expect(c.base_url).toMatch(/^https:\/\//)
    expect(c.vision_model.length).toBeGreaterThan(0)
  })

  it('lets every value be overridden, so vendors stay swappable (H8)', () => {
    process.env.AI_GATEWAY_API_KEY = 'k'
    process.env.AI_GATEWAY_BASE_URL = 'https://example.test/v1'
    process.env.VISION_MODEL = 'vendor/some-vision'
    process.env.ASR_MODEL = 'vendor/some-asr'
    const c = provider_config()
    expect(c.base_url).toBe('https://example.test/v1')
    expect(c.vision_model).toBe('vendor/some-vision')
    expect(c.asr_model).toBe('vendor/some-asr')
  })
})

describe('estimate_cost', () => {
  it('returns zero when the response carries no usage block', () => {
    expect(estimate_cost(undefined)).toBe(0)
  })

  it('prices prompt and completion tokens separately', () => {
    const cost = estimate_cost({ prompt_tokens: 1000, completion_tokens: 1000 })
    expect(cost).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/extraction/provider.test.ts`
Expected: FAIL — `Failed to resolve import "./provider"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/extraction/provider.ts
/**
 * The model seam.
 *
 * H8: Korean burned-in-text vision and Korean ASR quality are bets, not knowns.
 * Vendor choice must therefore be an eval variable, which means base URL and
 * model name are configuration and nothing in the rungs hardcodes either.
 *
 * The request shapes are the OpenAI-compatible ones, which every gateway and
 * most vendors implement, so swapping providers is an env change rather than a
 * code change.
 */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderConfigError'
  }
}

export type ProviderConfig = {
  base_url: string
  api_key: string
  vision_model: string
  asr_model: string
}

export function provider_config(): ProviderConfig {
  const api_key = process.env.AI_GATEWAY_API_KEY
  if (!api_key) {
    throw new ProviderConfigError(
      'AI_GATEWAY_API_KEY is not set — see .env.example',
    )
  }
  return {
    base_url: process.env.AI_GATEWAY_BASE_URL ?? 'https://ai-gateway.vercel.sh/v1',
    api_key,
    vision_model: process.env.VISION_MODEL ?? 'anthropic/claude-sonnet-5',
    asr_model: process.env.ASR_MODEL ?? 'openai/whisper-1',
  }
}

export type Usage = { prompt_tokens?: number; completion_tokens?: number }

/**
 * A deliberately rough per-token estimate. The corpus compares rungs against one
 * another, so relative cost is what matters; exact billing is not the question
 * this harness answers. Adjust the two rates when the chosen vendor is settled.
 */
const USD_PER_PROMPT_TOKEN = 3 / 1_000_000
const USD_PER_COMPLETION_TOKEN = 15 / 1_000_000

export function estimate_cost(usage: Usage | undefined): number {
  if (!usage) return 0
  return (
    (usage.prompt_tokens ?? 0) * USD_PER_PROMPT_TOKEN +
    (usage.completion_tokens ?? 0) * USD_PER_COMPLETION_TOKEN
  )
}

export type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export async function chat_json(opts: {
  config: ProviderConfig
  content: ChatContent[]
  max_tokens?: number
}): Promise<{ raw: string; cost_usd: number }> {
  const res = await fetch(`${opts.config.base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.config.api_key}`,
    },
    body: JSON.stringify({
      model: opts.config.vision_model,
      max_tokens: opts.max_tokens ?? 800,
      messages: [{ role: 'user', content: opts.content }],
    }),
  })

  if (!res.ok) {
    throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: Usage
  }

  return {
    raw: body.choices?.[0]?.message?.content ?? '',
    cost_usd: estimate_cost(body.usage),
  }
}
```

- [ ] **Step 4: Add the env keys to .env.example**

Append:

```
# Extraction harness (dev only — see docs/superpowers/specs/2026-09-20-extraction-harness-design.md).
# Vision and ASR both route through one OpenAI-compatible endpoint so that vendor
# choice stays an eval variable rather than a hardcoded bet (H8).
AI_GATEWAY_API_KEY=
AI_GATEWAY_BASE_URL=
VISION_MODEL=
ASR_MODEL=
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run lib/extraction/provider.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/extraction/provider.ts lib/extraction/provider.test.ts .env.example
git commit -m "Harness: env-configured provider seam for vision and ASR"
```

---

### Task 8: Rung 2 — vision

**Files:**
- Create: `lib/extraction/rungs/vision.ts`
- Create: `lib/extraction/rungs/vision.test.ts`

**Interfaces:**
- Consumes: `sample_frames` from `rungs/frames.ts`; `chat_json`, `provider_config` from `provider.ts`; `Media`, `VisionRung`, `PlaceCandidate` from `types.ts`
- Produces: `parse_candidate(raw: string): PlaceCandidate | null`, `run_vision(media: Media): Promise<VisionRung>`

- [ ] **Step 1: Write the failing test**

`parse_candidate` is the part worth testing: models wrap JSON in prose and fences, and a parse failure must not crash the run.

```ts
// lib/extraction/rungs/vision.test.ts
import { describe, it, expect } from 'vitest'
import { parse_candidate } from './vision'

describe('parse_candidate', () => {
  it('parses a bare JSON object', () => {
    const c = parse_candidate(
      '{"name":"어니언","category":"cafe","area":"성수","hook":null,"visible_price":null,"score":0.9}',
    )
    expect(c?.name).toBe('어니언')
    expect(c?.category).toBe('cafe')
    expect(c?.score).toBe(0.9)
  })

  it('parses JSON wrapped in a fenced code block', () => {
    const c = parse_candidate('```json\n{"name":"어니언","category":null,"area":null,"hook":null,"visible_price":null,"score":0.5}\n```')
    expect(c?.name).toBe('어니언')
  })

  it('returns null for an unparseable response rather than throwing', () => {
    expect(parse_candidate('I could not find a place name.')).toBeNull()
  })

  it('returns null when the shape does not validate', () => {
    expect(parse_candidate('{"name":"X","score":5}')).toBeNull()
  })

  it('rejects a category outside PlaceCategory', () => {
    expect(
      parse_candidate('{"name":"X","category":"nightclub","area":null,"hook":null,"visible_price":null,"score":0.5}'),
    ).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/extraction/rungs/vision.test.ts`
Expected: FAIL — `Failed to resolve import "./vision"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/extraction/rungs/vision.ts
/**
 * Rung 2 of the §6.2 ladder: sampled frames → PlaceCandidate.
 *
 * Parent spec §6.1 concludes that the place name usually exists only as text
 * burned into the video, which makes this the rung the ladder leans on. Whether
 * that conclusion holds is open question 1 in the harness spec — this rung's
 * output across the corpus is the evidence.
 */
import { readFileSync } from 'node:fs'
import type { Media, PlaceCandidate, VisionRung } from '../types'
import { placeCandidateSchema } from '../types'
import { chat_json, provider_config } from '../provider'
import { sample_frames } from './frames'

const PROMPT = `These frames are from a Korean Instagram reel about a place.
Read any text burned into the images (signage, captions, menus, stickers).

Reply with ONLY a JSON object, no prose:
{"name": string|null, "category": "cafe"|"restaurant"|"exhibition"|"shop"|"activity"|null,
 "area": string|null, "hook": string|null, "visible_price": string|null, "score": number}

name: the place's own name as written, in Korean if shown in Korean.
area: the neighbourhood (예: 성수동, 연남동) if visible or clearly implied.
hook: the one line that makes this place worth visiting, in Korean.
score: your confidence from 0 to 1 that "name" is the real place name.
Use null rather than guessing.`

/** Models wrap JSON in prose and fences; a parse failure must not end the run. */
export function parse_candidate(raw: string): PlaceCandidate | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }

  const result = placeCandidateSchema.safeParse(parsed)
  return result.success ? result.data : null
}

export async function run_vision(media: Media): Promise<VisionRung> {
  const started = Date.now()
  try {
    const config = provider_config()
    const frames = await sample_frames(media)
    if (frames.length === 0) {
      return { ok: false, frames_used: 0, candidate: null, ms: Date.now() - started, cost_usd: 0, error: 'no frames sampled' }
    }

    const { raw, cost_usd } = await chat_json({
      config,
      content: [
        { type: 'text', text: PROMPT },
        ...frames.map((f) => ({
          type: 'image_url' as const,
          image_url: { url: `data:image/jpeg;base64,${readFileSync(f).toString('base64')}` },
        })),
      ],
    })

    return {
      ok: true,
      frames_used: frames.length,
      candidate: parse_candidate(raw),
      ms: Date.now() - started,
      cost_usd,
    }
  } catch (err) {
    return {
      ok: false,
      frames_used: 0,
      candidate: null,
      ms: Date.now() - started,
      cost_usd: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/extraction/rungs/vision.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/rungs/vision.ts lib/extraction/rungs/vision.test.ts
git commit -m "Harness: rung 2, vision over sampled frames"
```

---

### Task 9: Rung 3 — ASR, and the ladder

**Files:**
- Create: `lib/extraction/rungs/asr.ts`
- Create: `lib/extraction/rungs/asr.test.ts`
- Create: `lib/extraction/ladder.ts`
- Create: `lib/extraction/ladder.test.ts`

**Interfaces:**
- Consumes: `provider_config` from `provider.ts`; `run_caption`, `run_vision` from the rung modules; `band_for` from `confidence.ts`; all row types from `types.ts`
- Produces: `run_asr(media: Media): Promise<AsrRung>`, `derive(rungs): { candidate; confidence; decided_by }`, `run_ladder(media, opts): Promise<EvalRow['rungs'] & derived>`

- [ ] **Step 1: Write the failing test for ASR**

```ts
// lib/extraction/rungs/asr.test.ts
import { describe, it, expect } from 'vitest'
import { run_asr } from './asr'
import type { Media } from '../types'

describe('run_asr', () => {
  it('skips cleanly when the reel has no audio track — a result, not an error', async () => {
    const media: Media = {
      reel_id: 'X', video_path: '/tmp/x.mp4', caption_text: null,
      duration_s: 10, width: 100, height: 200, has_audio: false,
    }
    const r = await run_asr(media)
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe('no_audio')
    expect(r.transcript).toBeNull()
    expect(r.cost_usd).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/extraction/rungs/asr.test.ts`
Expected: FAIL — `Failed to resolve import "./asr"`.

- [ ] **Step 3: Write the ASR rung**

```ts
// lib/extraction/rungs/asr.ts
/**
 * Rung 3 of the §6.2 ladder: audio → transcript.
 *
 * The parent spec marks this rung "+cost" and reserves it for low-confidence
 * cases, on the reasoning that Korean reels frequently *say* the place name.
 * Whether it earns that cost given rung 2's result on the same reel is open
 * question 3 — which is why the harness runs it unconditionally in --all-rungs.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AsrRung, Media } from '../types'
import { provider_config } from '../provider'

const exec_file = promisify(execFile)

export async function run_asr(media: Media): Promise<AsrRung> {
  const started = Date.now()

  if (!media.has_audio) {
    return { ok: true, transcript: null, language: null, skipped: 'no_audio', ms: Date.now() - started, cost_usd: 0 }
  }

  try {
    const config = provider_config()
    const audio_path = path.join(path.dirname(media.video_path), `${media.reel_id}.mp3`)

    // 16 kHz mono is what speech models expect; sending the full-rate stereo
    // track costs more and buys nothing.
    await exec_file('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', media.video_path,
      '-vn', '-ac', '1', '-ar', '16000',
      audio_path,
    ])

    const form = new FormData()
    form.append('file', new Blob([readFileSync(audio_path)]), `${media.reel_id}.mp3`)
    form.append('model', config.asr_model)
    form.append('response_format', 'verbose_json')

    const res = await fetch(`${config.base_url}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.api_key}` },
      body: form,
    })

    if (!res.ok) {
      throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }

    const body = (await res.json()) as { text?: string; language?: string; duration?: number }

    // Speech models bill by audio minute, not tokens, so cost is derived from
    // duration rather than from a usage block.
    const minutes = (body.duration ?? media.duration_s ?? 0) / 60
    return {
      ok: true,
      transcript: body.text ?? null,
      language: body.language ?? null,
      ms: Date.now() - started,
      cost_usd: minutes * 0.006,
    }
  } catch (err) {
    return {
      ok: false,
      transcript: null,
      language: null,
      ms: Date.now() - started,
      cost_usd: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
```

- [ ] **Step 4: Write the failing test for the ladder**

```ts
// lib/extraction/ladder.test.ts
import { describe, it, expect } from 'vitest'
import { derive } from './ladder'
import type { AsrRung, CaptionRung, VisionRung } from './types'

const caption: CaptionRung = { ok: true, text: null, keywords: [], ms: 1, cost_usd: 0 }
const asr: AsrRung = { ok: true, transcript: null, language: null, ms: 1, cost_usd: 0 }

function vision(score: number | null): VisionRung {
  return {
    ok: true,
    frames_used: 8,
    candidate: score === null ? null : {
      name: '어니언', category: 'cafe', area: '성수', hook: null, visible_price: null, score,
    },
    ms: 1,
    cost_usd: 0.003,
  }
}

describe('derive', () => {
  it('credits vision when it produced the surviving candidate', () => {
    const d = derive({ caption, vision: vision(0.9), asr })
    expect(d.decided_by).toBe('vision')
    expect(d.confidence).toBe('high')
    expect(d.candidate?.name).toBe('어니언')
  })

  it('bands a weak candidate down without discarding it', () => {
    const d = derive({ caption, vision: vision(0.3), asr })
    expect(d.confidence).toBe('low')
    expect(d.candidate).not.toBeNull()
  })

  it('returns none with no decider when every rung came back empty', () => {
    const d = derive({ caption, vision: vision(null), asr })
    expect(d.decided_by).toBeNull()
    expect(d.confidence).toBe('none')
    expect(d.candidate).toBeNull()
  })

  it('falls back to caption keywords when vision found nothing', () => {
    const with_keywords: CaptionRung = { ...caption, text: '성수동 어니언', keywords: ['성수동', '어니언'] }
    const d = derive({ caption: with_keywords, vision: vision(null), asr })
    expect(d.decided_by).toBe('caption')
    expect(d.confidence).toBe('low')
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run lib/extraction/ladder.test.ts`
Expected: FAIL — `Failed to resolve import "./ladder"`.

- [ ] **Step 6: Write the ladder**

```ts
// lib/extraction/ladder.ts
/**
 * Sequencing, and nothing else.
 *
 * H3: --all-rungs runs every rung unconditionally so the corpus can compare
 * them; --ladder short-circuits as production will. Keeping both policies in one
 * file means changing the policy is a one-file change (H1).
 */
import type { AsrRung, CaptionRung, Confidence, Media, PlaceCandidate, RungName, VisionRung } from './types'
import { band_for } from './confidence'
import { run_caption } from './rungs/caption'
import { run_vision } from './rungs/vision'
import { run_asr } from './rungs/asr'

export type Rungs = { caption: CaptionRung; vision: VisionRung; asr: AsrRung }

export type Derived = {
  candidate: PlaceCandidate | null
  confidence: Confidence
  decided_by: RungName | null
}

/**
 * Preference order is vision, then caption, then ASR — the §6.2 ladder order.
 * A caption-only hit is banded 'low' deliberately: keywords are not a place name
 * until something resolves them, so they must not outrank a real vision read.
 */
export function derive(rungs: Rungs): Derived {
  if (rungs.vision.candidate) {
    return {
      candidate: rungs.vision.candidate,
      confidence: band_for(rungs.vision.candidate.score),
      decided_by: 'vision',
    }
  }

  if (rungs.caption.keywords.length > 0) {
    return {
      candidate: {
        name: rungs.caption.keywords[0],
        category: null,
        area: null,
        hook: null,
        visible_price: null,
        score: 0.3,
      },
      confidence: 'low',
      decided_by: 'caption',
    }
  }

  if (rungs.asr.transcript && rungs.asr.transcript.trim().length > 0) {
    return {
      candidate: {
        name: null, category: null, area: null, hook: null, visible_price: null, score: 0.25,
      },
      confidence: 'low',
      decided_by: 'asr',
    }
  }

  return { candidate: null, confidence: 'none', decided_by: null }
}

const SKIPPED_ASR: AsrRung = { ok: true, transcript: null, language: null, skipped: 'short_circuit', ms: 0, cost_usd: 0 }

export async function run_ladder(
  media: Media,
  opts: { mode: 'all-rungs' | 'ladder' },
): Promise<{ rungs: Rungs; derived: Derived }> {
  const caption = run_caption(media)

  if (opts.mode === 'all-rungs') {
    // No data dependency between rungs, so they run together. Sequential
    // execution would also let an early result bias how a later rung is called,
    // which would contaminate the comparison the corpus exists to make.
    const [vision, asr] = await Promise.all([run_vision(media), run_asr(media)])
    const rungs = { caption, vision, asr }
    return { rungs, derived: derive(rungs) }
  }

  const vision = await run_vision(media)
  const after_vision = derive({ caption, vision, asr: SKIPPED_ASR })
  if (after_vision.confidence === 'high' || after_vision.confidence === 'medium') {
    return { rungs: { caption, vision, asr: SKIPPED_ASR }, derived: after_vision }
  }

  const asr = await run_asr(media)
  const rungs = { caption, vision, asr }
  return { rungs, derived: derive(rungs) }
}

export { SKIPPED_ASR }
```

- [ ] **Step 7: Run both tests to verify they pass**

Run: `npx vitest run lib/extraction/ladder.test.ts lib/extraction/rungs/asr.test.ts`
Expected: PASS — 4 ladder tests, 1 ASR test.

- [ ] **Step 8: Commit**

```bash
git add lib/extraction/rungs/asr.ts lib/extraction/rungs/asr.test.ts lib/extraction/ladder.ts lib/extraction/ladder.test.ts
git commit -m "Harness: rung 3 ASR and the two-mode ladder"
```

---

### Task 10: Row writer and CLI

**Files:**
- Create: `lib/extraction/row.ts`
- Create: `lib/extraction/row.test.ts`
- Create: `scripts/extract-eval.ts`
- Modify: `package.json` (add `extract` script)

**Interfaces:**
- Consumes: `evalRowSchema`, `HARNESS_VERSION`, all row types from `types.ts`; `Rungs`, `Derived`, `run_ladder` from `ladder.ts`; `YtDlpSource`, `MediaError`, `reel_id_from_url` from the media modules
- Produces: `build_row(args): EvalRow`, `failed_row(args): EvalRow`, `write_row(row: EvalRow): string`

- [ ] **Step 1: Write the failing test**

```ts
// lib/extraction/row.test.ts
import { describe, it, expect } from 'vitest'
import { build_row, failed_row } from './row'
import { evalRowSchema } from './types'
import type { Rungs } from './ladder'

const rungs: Rungs = {
  caption: { ok: true, text: null, keywords: [], ms: 1, cost_usd: 0 },
  vision: { ok: true, frames_used: 8, candidate: null, ms: 10, cost_usd: 0.003 },
  asr: { ok: true, transcript: null, language: null, ms: 20, cost_usd: 0.001 },
}

describe('build_row', () => {
  it('produces a row that satisfies the schema', () => {
    const row = build_row({
      source_url: 'https://www.instagram.com/reel/AAA/',
      media: { reel_id: 'AAA', video_path: '/tmp/a.mp4', caption_text: null, duration_s: 58, width: 892, height: 1584, has_audio: true },
      rungs,
      derived: { candidate: null, confidence: 'none', decided_by: null },
    })
    expect(evalRowSchema.safeParse(row).success).toBe(true)
    expect(row.media?.res).toBe('892x1584')
  })

  it('always leaves ground_truth null — nothing automated writes it', () => {
    const row = build_row({
      source_url: 'https://www.instagram.com/reel/AAA/',
      media: { reel_id: 'AAA', video_path: '/tmp/a.mp4', caption_text: null, duration_s: 1, width: 1, height: 1, has_audio: false },
      rungs,
      derived: { candidate: null, confidence: 'none', decided_by: null },
    })
    expect(row.ground_truth).toBeNull()
  })
})

describe('failed_row', () => {
  it('still produces a schema-valid row when media resolution failed (H5)', () => {
    const row = failed_row({
      source_url: 'https://www.instagram.com/reel/BBB/',
      reel_id: 'BBB',
      kind: 'blocked',
      message: 'HTTP 401',
    })
    expect(evalRowSchema.safeParse(row).success).toBe(true)
    expect(row.media).toBeNull()
    expect(row.error?.kind).toBe('blocked')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/extraction/row.test.ts`
Expected: FAIL — `Failed to resolve import "./row"`.

- [ ] **Step 3: Write the row module**

```ts
// lib/extraction/row.ts
/**
 * Row assembly and persistence.
 *
 * H5: every reel produces a row, including one whose media never resolved.
 * If blocked, private and deleted reels silently vanished from the corpus, the
 * confidence bands would be tuned on survivors only — selection bias that makes
 * production look better than it is, which is the silent degradation D10 exists
 * to prevent.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { EvalRow, Media } from './types'
import { HARNESS_VERSION, evalRowSchema } from './types'
import type { Derived, Rungs } from './ladder'
import type { MediaErrorKind } from './media'

export const EVAL_DIR = path.join(process.cwd(), 'docs', 'gaja', 'evals', 'extraction')

const EMPTY_RUNGS: Rungs = {
  caption: { ok: false, text: null, keywords: [], ms: 0, cost_usd: 0, error: 'media unresolved' },
  vision: { ok: false, frames_used: 0, candidate: null, ms: 0, cost_usd: 0, error: 'media unresolved' },
  asr: { ok: false, transcript: null, language: null, ms: 0, cost_usd: 0, error: 'media unresolved' },
}

export function build_row(args: {
  source_url: string
  media: Media
  rungs: Rungs
  derived: Derived
}): EvalRow {
  return {
    reel_id: args.media.reel_id,
    source_url: args.source_url,
    fetched_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    media: {
      duration_s: args.media.duration_s,
      res: `${args.media.width}x${args.media.height}`,
      has_audio: args.media.has_audio,
    },
    rungs: args.rungs,
    derived: args.derived,
    ground_truth: null,
  }
}

export function failed_row(args: {
  source_url: string
  reel_id: string
  kind: MediaErrorKind
  message: string
}): EvalRow {
  return {
    reel_id: args.reel_id,
    source_url: args.source_url,
    fetched_at: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    media: null,
    rungs: EMPTY_RUNGS,
    derived: { candidate: null, confidence: 'none', decided_by: null },
    ground_truth: null,
    error: { stage: 'media', kind: args.kind, message: args.message },
  }
}

export function write_row(row: EvalRow): string {
  // Validate before writing: a malformed row discovered at scoring time, after
  // the reel is gone, cannot be recovered.
  evalRowSchema.parse(row)
  mkdirSync(EVAL_DIR, { recursive: true })
  const out = path.join(EVAL_DIR, `${row.reel_id}.json`)
  writeFileSync(out, `${JSON.stringify(row, null, 2)}\n`, 'utf8')
  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/extraction/row.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Write the CLI**

```ts
// scripts/extract-eval.ts
/**
 * Dev-only CLI. The only caller of lib/extraction (H1).
 *
 *   npx tsx scripts/extract-eval.ts <url|file> [--ladder] [--max-cost-usd 2]
 *
 * Accepts a single reel URL or a file containing one URL per line.
 */
import { readFileSync, existsSync } from 'node:fs'
import { MediaError, reel_id_from_url } from '@/lib/extraction/media'
import { YtDlpSource } from '@/lib/extraction/media/yt-dlp'
import { run_ladder } from '@/lib/extraction/ladder'
import { build_row, failed_row, write_row } from '@/lib/extraction/row'

function parse_args(argv: string[]) {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const mode = argv.includes('--ladder') ? ('ladder' as const) : ('all-rungs' as const)
  const cap_index = argv.indexOf('--max-cost-usd')
  const max_cost = cap_index === -1 ? Infinity : Number(argv[cap_index + 1])
  return { target: positional[0], mode, max_cost }
}

async function main() {
  const { target, mode, max_cost } = parse_args(process.argv.slice(2))
  if (!target) {
    console.error('usage: extract-eval <url|file> [--ladder] [--max-cost-usd N]')
    process.exit(1)
  }

  const urls = existsSync(target)
    ? readFileSync(target, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : [target]

  const source = new YtDlpSource()
  let spent = 0

  for (const url of urls) {
    // The ceiling is checked before each reel, not after: a typo in a URL file
    // should not become a surprise bill.
    if (spent >= max_cost) {
      console.error(`cost ceiling reached ($${spent.toFixed(4)}) — stopping`)
      break
    }

    const reel_id = reel_id_from_url(url) ?? 'unknown'
    try {
      const media = await source.resolve(url)
      const { rungs, derived } = await run_ladder(media, { mode })
      const row = build_row({ source_url: url, media, rungs, derived })
      spent += rungs.caption.cost_usd + rungs.vision.cost_usd + rungs.asr.cost_usd
      console.log(`${write_row(row)}  ${derived.confidence}  by=${derived.decided_by ?? '-'}`)
    } catch (err) {
      const kind = err instanceof MediaError ? err.kind : 'unknown'
      const message = err instanceof Error ? err.message : String(err)
      // H5: write the failure row too.
      console.log(`${write_row(failed_row({ source_url: url, reel_id, kind, message }))}  FAILED ${kind}`)
    }
  }

  console.log(`\nspent ~$${spent.toFixed(4)}`)
}

main()
```

- [ ] **Step 6: Add the extract script and tsx**

```bash
npm install -D tsx
```

In `"scripts"`, add:

```json
"extract": "tsx scripts/extract-eval.ts"
```

- [ ] **Step 7: Verify the full suite passes**

Run: `npm test`
Expected: PASS — all tests across `lib/extraction/`.

- [ ] **Step 8: Manual end-to-end check**

Run against one real public reel, from your own machine (not a datacenter IP — see spec §8):

```bash
AI_GATEWAY_API_KEY=... npm run extract -- "https://www.instagram.com/nasa/reel/DdRyQxKteC1/" --max-cost-usd 0.50
```

Expected: a file at `docs/gaja/evals/extraction/DdRyQxKteC1.json` that validates, with all three rungs populated and `ground_truth: null`.

- [ ] **Step 9: Commit**

```bash
git add lib/extraction/row.ts lib/extraction/row.test.ts scripts/extract-eval.ts package.json package-lock.json
git commit -m "Harness: row writer and dev CLI"
```

---

## After the plan

The harness exists; the corpus does not. The next action is not code — it is
running the harness over ~30 real 성수 reels (parent spec §11) chosen to test
open question 1 first: does a forwarded reel carry a usable caption, or is the
place name only ever burned into the video?

Hand-label `ground_truth` on those rows, then read `decided_by` and the per-rung
costs. That aggregate is what settles the band boundaries in `confidence.ts` and
whether rung 3 stays in the ladder at all.
