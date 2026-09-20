/**
 * Rungs two and three of the extraction ladder — collapsed into one call.
 *
 * SERVER ONLY. `GEMINI_API_KEY` is a real, billed secret. It must never be
 * prefixed `NEXT_PUBLIC_` (that prefix inlines the value into the browser bundle
 * at build time — see next/dist/docs/01-app/02-guides/environment-variables.md),
 * never be imported from anything under `app/` a client component can reach, and
 * never be logged, echoed into an error message or put in a problem response.
 * Same rule `.env.example` states for `NAVER_MAP_CLIENT_SECRET` and
 * `SUPABASE_SERVICE_ROLE_KEY`, for the same reason.
 *
 * WHY THIS CONTRADICTS THE SPEC, WRITTEN DOWN RATHER THAN SMUGGLED IN.
 * docs/superpowers/specs/2026-09-20-extraction-harness-design.md §4 lays out
 * three separate modules — `frames.ts` (8 frames, dHash-deduped), `vision.ts`
 * (frames -> candidate) and `asr.ts` (audio -> transcript). This file is all
 * three, and there is no `frames.ts`, because the premise those modules were
 * built on turned out to be false when it was measured against a real reel from
 * the project's own Instagram inbox:
 *
 *   - `clip.video_versions[].url` is a 720x1280 mp4 that answers 200 to a plain
 *     server-side fetch with NO Instagram cookies — 4,350,463 bytes for a 9.6s
 *     reel. There is no frame-extraction step to protect anyone from.
 *   - Handing that whole mp4 to `gemini-3.1-flash-lite` inline returned a
 *     correct Korean transcript in 3.9s for 966 prompt tokens (901 of them
 *     VIDEO) plus 134 output. Cheaper than eight separate image parts.
 *   - It returned the BURNED-IN ON-SCREEN TEXT in the same response as the
 *     spoken audio. That is the whole of rung 2 and the whole of rung 3, and
 *     asking for them separately would be two calls billed for the same video.
 *
 * So there is nothing for `frames.ts` to do. The dHash dedupe it existed for —
 * reels hold a static title card for seconds, and eight copies of one frame is
 * eight frames billed — survives as an instruction in the prompt below instead.
 * Restore the three-module shape only if a measurement, not a reading of the
 * spec, says the single call is worse.
 *
 * WHEN THIS RUNS: AT INGEST, NEVER LAZILY. The video URL carries an `oe=`
 * expiry, exactly like the thumbnail URLs (`.env.example`, lib/ingest/thumbnail.ts)
 * — measured at roughly four and a half days there. A design that transcribed
 * when a user opened a saved place would work in development, where every reel
 * is hours old, and return nothing at all for anything saved last week. The
 * bytes must be spent while the link is alive.
 */

import { GoogleGenAI, Type, createPartFromUri, createUserContent, type Part, type Schema } from '@google/genai';

/**
 * Pinned, not `gemini-flash-lite-latest`, for the same reason lib/extract/caption.ts
 * pins: an alias that moves under a parser turns a model upgrade into an
 * unexplained change in extraction results with no diff to point at. The
 * measurement quoted above was taken against this exact id; change the id and
 * the numbers stop describing the code.
 */
const MODEL = 'gemini-3.1-flash-lite';

/** Where a `{ url }` is fetched from. Videos are bigger than thumbnails; 10s was not enough. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * The inline ceiling, and the arithmetic behind the number.
 *
 * The Gemini API caps a whole request at about 20 MB, and `inlineData` is
 * base64 — 4 bytes on the wire for every 3 bytes of video, a 1.34x inflation
 * that is easy to forget until a 17 MB reel fails at request time with an error
 * about the request, not about the file. 12 MiB of mp4 encodes to ~16 MiB,
 * which leaves headroom for the prompt and the schema.
 *
 * At the measured rate — 4,350,463 bytes for 9.6s, about 435 KB/s — 12 MiB is
 * roughly 29 seconds of reel. Reels run to 90s and beyond, so this threshold is
 * crossed by ordinary content, not by an edge case. That is why the Files API
 * path below exists rather than a `throw new Error('too long')`.
 */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

/**
 * The absolute ceiling on what will be buffered at all, inline or not.
 *
 * Not about the Files API's own limit, which is far higher. It is about what
 * happens when a URL that promised a 20-second reel answers with something
 * unbounded: without a cap the memory ceiling of the whole ingest pass becomes
 * whatever the other end decided to send. 96 MiB is about 3.7 minutes at the
 * measured rate — past any reel and well short of dangerous.
 */
const MAX_VIDEO_BYTES = 96 * 1024 * 1024;

/** A Files API upload is not ready the instant it returns. Bounded wait, not an open one. */
const FILE_ACTIVE_TIMEOUT_MS = 120_000;
const FILE_POLL_INTERVAL_MS = 1_000;

/** The key is not set, so no request was attempted. A deployment mistake, not a data one. */
export class AsrNotConfiguredError extends Error {
  constructor() {
    // Names the variable, never the value — an error message is the most likely
    // place a secret escapes, because it is the one string that gets logged.
    super('GEMINI_API_KEY is not set; lib/extract/asr.ts cannot call Gemini. Server-side only, never NEXT_PUBLIC_.');
    this.name = 'AsrNotConfiguredError';
  }
}

/**
 * The video never became something worth spending a model call on: the URL was
 * refused, the download failed or timed out, the bytes are not an mp4, or there
 * are too many of them.
 *
 * Deliberately a different class from a model failure. "The CDN link expired"
 * and "the model refused the content" are different problems with different
 * fixes, and a caller that collapses them logs one number for both.
 */
export class AsrMediaError extends Error {
  constructor(readonly reason: string) {
    // The reason is a short tag, safe to log and to count — never a URL and
    // never a response body. A signed CDN URL in a log line is a credential.
    super(`Reel video unusable: ${reason}`);
    this.name = 'AsrMediaError';
  }
}

export type AsrVideo = { url: string } | { bytes: Buffer };

export type AsrResult = {
  /**
   * Verbatim spoken audio, in whatever language was spoken. Null when nobody
   * speaks — which is ordinary. A large share of café reels are music over
   * b-roll, and `null` says that honestly where `''` would read as a failure.
   */
  speech: string | null;

  /**
   * Text burned into the frames — the title card, the venue name, an address,
   * a price — deduplicated across the frames that repeat it.
   *
   * This is rung 2's entire output, arriving in rung 3's response. On the one
   * measured reel the on-screen text was the TITLE ONLY ("여름 날에 다녀오기 좋은
   * 싱그러운 카페 10곳"), which names no venue; that is precisely why this is a
   * fallback and not the default path.
   */
  onScreenText: string | null;

  /** Wall-clock milliseconds for the whole thing, download and upload included. */
  ms: number;

  /** The pinned model id, so a stored result says what produced it. */
  model: string;

  /** Total billed tokens, when the response reported them. Video dominates this number. */
  tokens?: number;

  /** Which path the bytes took. Recorded because the two have very different latencies. */
  transport: 'inline' | 'files-api';

  /** What was actually downloaded or handed in. The input to the threshold decision. */
  bytes: number;
};

/**
 * Reject anything that is not a plain public HTTPS fetch.
 *
 * The URL arrives inside an undocumented third-party payload, which makes it
 * attacker-influenced input to a server-side fetch — the definition of SSRF. A
 * `file://` URL, or one pointing at 169.254.169.254, would otherwise be
 * downloaded by our server, with our network position, and uploaded to Google.
 *
 * Deliberately NOT an allowlist of `*.cdninstagram.com`: the Meta Messaging API
 * replacement serves media from different hosts, and a domain list here would
 * fail closed on the day the seam is swapped. The dangerous thing is the private
 * address space, and that is what is named.
 *
 * This duplicates the guard in lib/ingest/thumbnail.ts rather than importing it,
 * because that module imports lib/db and lib/storage — pulling `pg` and a
 * Supabase client into lib/extract, which today imports nothing but the model
 * SDK. Thirty lines of regex is a cheaper price than that coupling. If a third
 * copy ever appears, that is the moment to extract lib/net/fetchable-url.ts.
 */
function fetchableUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host.startsWith('fd') ||
    host.startsWith('fe80:') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^0\./.test(host)
  ) {
    return null;
  }
  return url;
}

/**
 * Read the body with a hard ceiling.
 *
 * `res.arrayBuffer()` would buffer whatever arrives before anyone could check
 * its size, and `Content-Length` is a claim by the sender — it can be absent, or
 * it can lie. Streaming and counting is the only version where the ceiling is
 * actually enforced.
 */
async function readBounded(res: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;

  const body = res.body;
  if (!body) return null;

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Releases the socket on the oversize path too; without it the connection
    // stays open until GC, once per oversize response.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

/**
 * "Are these bytes actually an mp4?" — answered from the bytes, before a model
 * call is billed for them.
 *
 * WHY NOT TRUST `Content-Type`, and why this check is not optional: the URL came
 * out of an undocumented payload and carries an `oe=` expiry. An expired or
 * rate-limited CDN answers with an HTML error page, a JSON blob or a redirect
 * body — all of which are happily labelled and all of which would otherwise be
 * base64-encoded and posted to Gemini, costing a real call to be told nothing.
 * Same reasoning as `probeImage` in lib/ingest/image-probe.ts.
 *
 * An mp4 is ISO base media format: a length-prefixed box whose four-character
 * type is `ftyp`, at offset 4. That is the whole test. Brand (`isom`, `mp42`,
 * `avc1`, `dash`) deliberately goes unchecked — Instagram has shipped several
 * and a brand allowlist would reject a valid video for a cosmetic reason.
 */
export function looksLikeMp4(bytes: Uint8Array): boolean {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length < 12) return false;
  return b.subarray(4, 8).toString('latin1') === 'ftyp';
}

async function download(rawUrl: string): Promise<Buffer> {
  const url = fetchableUrl(rawUrl);
  if (!url) throw new AsrMediaError('url-refused');

  let res: Response;
  try {
    res = await fetch(url, {
      // No cookies, no Instagram headers, no credentials of any kind. This was
      // measured: the video URL answers 200 to a plain server-side fetch. It is
      // a pre-signed public link, which is also why it expires. Sending a
      // session cookie to a CDN would leak the account's strongest credential
      // for no gain.
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    // Transport failure or timeout. The message is deliberately not forwarded —
    // a fetch error stringifies the URL, and this one is signed.
    throw new AsrMediaError('download-failed');
  }

  if (!res.ok) throw new AsrMediaError(`download-status-${res.status}`);

  const bytes = await readBounded(res, MAX_VIDEO_BYTES);
  if (!bytes) throw new AsrMediaError('too-large');
  return bytes;
}

/**
 * The two channels, as a schema rather than as an instruction to "return JSON".
 *
 * `responseSchema` constrains decoding, so the failure mode is a null field
 * rather than an apology wrapped in a code fence. A reel with no speech is
 * exactly the input where a model is most tempted to explain itself instead of
 * answering, and the whole point of this rung is that its output feeds a parser.
 *
 * Both fields are `required` AND `nullable`: `required` makes the key always
 * present, `nullable` lets its value be absent. Together the response has one
 * shape, so the caller handles "this reel is silent" and never "this key might
 * be missing".
 */
const TRANSCRIPT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    speech: {
      type: Type.STRING,
      nullable: true,
      description:
        'Everything said aloud, transcribed verbatim in the language spoken. Null if nobody speaks — background music alone is not speech.',
    },
    on_screen_text: {
      type: Type.STRING,
      nullable: true,
      description:
        'Text burned into the video frames, verbatim, one item per line in reading order. Null if the video carries no text.',
    },
  },
  required: ['speech', 'on_screen_text'],
  propertyOrdering: ['speech', 'on_screen_text'],
};

/**
 * The instruction carries the three things the schema cannot.
 *
 * The dedupe rule is first because it is what `frames.ts` and its dHash existed
 * to do (spec §4): reels hold a static title card for seconds, and a model
 * reading every frame would return the same line ten times, which a numbered
 * parser downstream would read as ten venues.
 *
 * The chrome rule is second because Instagram's own UI is IN the frames — the
 * author's @handle, "Follow", the music ticker, the like count. Left in, the
 * creator's handle arrives in the on-screen text and lands in the same trap the
 * caption parser already has a rule against (eleven handles for ten venues, see
 * docs/gaja/reel-extraction-findings.md).
 */
const SYSTEM_INSTRUCTION = `You transcribe short Korean Instagram Reels about cafes, restaurants and bars.

Report two separate channels and do not mix them:
- speech: what is SAID ALOUD, transcribed verbatim in the language spoken.
- on_screen_text: what is WRITTEN in the frames — title cards, subtitles, venue names, addresses, hours, prices.

Rules:
- A title card that stays on screen for several seconds is ONE line of on_screen_text, not one per frame. Never repeat a line that did not change.
- Ignore Instagram's own interface: the account handle and Follow button at the top, the like/comment/share counts, the music ticker at the bottom, "Sponsored", and any watermark. None of it is content.
- Copy verbatim. Do not translate, romanise, summarise, reorder or correct anything, including obvious typos.
- Keep each on-screen item on its own line, in the order it is read on screen.
- A channel the video does not have is null. Background music alone is not speech. Never describe what you see — if there is no text, say null rather than narrating the picture.`;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Hand the bytes to the Files API and wait for them to become usable.
 *
 * The upload returns a `File` in `PROCESSING`; referencing it before it reaches
 * `ACTIVE` fails the generate call with a permission-shaped error that has
 * nothing to do with permissions. Hence the poll, and hence the bounded wait —
 * an unbounded one turns a stuck upload into an ingest pass that never returns.
 */
async function uploadAndWait(ai: GoogleGenAI, bytes: Buffer): Promise<{ part: Part; name: string }> {
  // A Blob rather than a temp file on disk: the bytes are already in memory, and
  // writing third-party copyrighted video to the filesystem of a serverless
  // instance is a copy nobody asked for and nothing deletes.
  const blob = new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });

  let file = await ai.files.upload({ file: blob, config: { mimeType: 'video/mp4' } });
  const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS;

  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new AsrMediaError('files-api-processing-timeout');
    await new Promise((r) => setTimeout(r, FILE_POLL_INTERVAL_MS));
    if (!file.name) throw new AsrMediaError('files-api-no-name');
    file = await ai.files.get({ name: file.name });
  }

  if (file.state === 'FAILED' || !file.uri || !file.name) throw new AsrMediaError('files-api-failed');
  return { part: createPartFromUri(file.uri, file.mimeType ?? 'video/mp4'), name: file.name };
}

/**
 * Transcribe one reel: spoken audio and burned-in text, in a single model call.
 *
 * Throws `AsrNotConfiguredError` when the key is unset and `AsrMediaError` when
 * the video never became usable. Deliberately not a silent null for either — a
 * missing key is a deployment mistake and an unusable video is a fact about the
 * pipeline, and a caller that got `{ speech: null }` for both has no way to tell
 * them from a reel that is genuinely silent. lib/extract/ladder.ts catches both
 * and records which, which is a decision made in one visible place.
 *
 * The key is read here rather than at module scope so that importing this file —
 * which `next build` does for any route that references it — does not require
 * the key to be present at build time.
 */
export async function transcribeReel(video: AsrVideo): Promise<AsrResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AsrNotConfiguredError();

  const startedAt = Date.now();

  const bytes = 'bytes' in video ? video.bytes : await download(video.url);
  if (bytes.length > MAX_VIDEO_BYTES) throw new AsrMediaError('too-large');
  if (!looksLikeMp4(bytes)) throw new AsrMediaError('not-mp4');

  const ai = new GoogleGenAI({ apiKey });
  const transport: AsrResult['transport'] = bytes.length <= MAX_INLINE_BYTES ? 'inline' : 'files-api';

  let part: Part;
  let uploadedName: string | null = null;
  if (transport === 'inline') {
    part = { inlineData: { mimeType: 'video/mp4', data: bytes.toString('base64') } };
  } else {
    const uploaded = await uploadAndWait(ai, bytes);
    part = uploaded.part;
    uploadedName = uploaded.name;
  }

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: createUserContent([part, 'Transcribe this reel.']),
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: TRANSCRIPT_SCHEMA,
        // Transcription has one right answer; sampling can only invent a
        // different one on a retry of the same reel.
        temperature: 0,
      },
    });

    const body = response.text;
    if (!body) {
      // A reel is user content and can be anything, including the reason a
      // safety filter returned nothing at all.
      throw new Error('Gemini returned no text for the reel transcription.');
    }

    let parsed: { speech?: unknown; on_screen_text?: unknown };
    try {
      parsed = JSON.parse(body) as { speech?: unknown; on_screen_text?: unknown };
    } catch {
      throw new Error('Gemini returned a response that was not JSON despite responseMimeType=application/json.');
    }

    return {
      speech: text(parsed.speech),
      onScreenText: text(parsed.on_screen_text),
      ms: Date.now() - startedAt,
      model: MODEL,
      tokens: response.usageMetadata?.totalTokenCount,
      transport,
      bytes: bytes.length,
    };
  } finally {
    // Delete rather than letting the 48-hour expiry do it. This is third-party
    // copyrighted video; leaving a copy sitting in a Google project for two days
    // per reel is a larger footprint than the one call needed, and the quota it
    // occupies is shared with every other upload in the project.
    if (uploadedName) await ai.files.delete({ name: uploadedName }).catch(() => {});
  }
}
