/**
 * Proof that lib/extract/asr.ts and lib/extract/ladder.ts work against the LIVE
 * Gemini API — the request shape, the structured response, the two transports,
 * and the feedback loop that turns a transcript back into place candidates.
 *
 * NO INSTAGRAM MEDIA IS USED OR COMMITTED. Every clip here is synthesised by
 * ffmpeg at run time into a temp directory and deleted afterwards. A real reel
 * is third-party copyrighted video (spec H7), and a fixture of one would be a
 * licensing problem sitting in git forever. What this verifies is that the
 * pipeline works, not that Korean transcription is accurate — that is an eval
 * question and needs the ~30-reel corpus, not a unit check.
 *
 * THIS SPENDS REAL, BILLED GEMINI CALLS. Three on a default run, four with
 * `--with-files-api`. It writes nothing to Postgres and opens no database
 * connection.
 *
 * Run from the repo root: ./scripts/verify-reel-asr.sh [--with-files-api]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AsrMediaError, looksLikeMp4, transcribeReel } from '../lib/extract/asr';
import { runLadder } from '../lib/extract/ladder';

/**
 * ASCII, deliberately. `drawtext` renders with whatever font file this machine
 * has, and the system fonts most likely to be present carry Latin glyphs and not
 * always Hangul — a Korean string here would silently render as tofu boxes and
 * then fail an assertion about the model rather than about the font. The
 * language of the burned-in text is not what is under test.
 */
const LINE_ONE = '1. YEONNAM COFFEE';
const LINE_TWO = '2. MANGWON BAKERY';

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
];

let pass = 0;
let fail = 0;
function ck(label: string, ok: boolean, detail?: string) {
  if (ok) {
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
    pass++;
  } else {
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}\n`);
    fail++;
  }
}

function which(cmd: string): boolean {
  try {
    execFileSync('command', ['-v', cmd], { shell: '/bin/sh', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fontFile(): string {
  const found = FONT_CANDIDATES.find((f) => existsSync(f));
  if (!found) {
    throw new Error(
      `no usable font found for ffmpeg drawtext. Tried:\n  ${FONT_CANDIDATES.join('\n  ')}\nAdd one this machine has to FONT_CANDIDATES.`,
    );
  }
  return found;
}

function drawFilter(font: string): string {
  const draw = (text: string, y: number) =>
    `drawtext=fontfile=${font}:text='${text}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=${y}`;
  return `${draw(LINE_ONE, 380)},${draw(LINE_TWO, 470)}`;
}

/**
 * A six-second portrait clip carrying two numbered lines and a spoken track.
 *
 * Spoken audio comes from macOS `say` when it is there, and from a sine tone
 * when it is not. The two branches assert DIFFERENT things about `speech` on
 * purpose — the sine branch is the check that a music bed is not transcribed as
 * speech, which is a rule the prompt states and which would otherwise go
 * unverified. Neither branch is a weaker test than the other.
 */
function synthesiseClip(dir: string, font: string): { path: string; spoken: boolean } {
  const spokenText = 'Number one, Yeonnam Coffee. Number two, Mangwon Bakery.';
  const out = join(dir, 'clip.mp4');
  const spoken = which('say');

  if (spoken) {
    const aiff = join(dir, 'speech.aiff');
    // No --data-format: `say` picks one from the extension, and pairing an
    // explicit LEF32 with .aiff fails on macOS 15 with "Opening output file
    // failed: fmt?" rather than falling back.
    execFileSync('say', ['-o', aiff, spokenText], { stdio: 'inherit' });
    execFileSync(
      'ffmpeg',
      ['-y', '-hide_banner', '-loglevel', 'error',
       '-f', 'lavfi', '-i', 'color=c=0x101418:s=540x960:r=12:d=6',
       '-i', aiff,
       '-vf', drawFilter(font),
       '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out],
      { stdio: 'inherit' },
    );
  } else {
    execFileSync(
      'ffmpeg',
      ['-y', '-hide_banner', '-loglevel', 'error',
       '-f', 'lavfi', '-i', 'color=c=0x101418:s=540x960:r=12:d=6',
       '-f', 'lavfi', '-i', 'sine=frequency=420:duration=6',
       '-vf', drawFilter(font),
       '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out],
      { stdio: 'inherit' },
    );
  }

  return { path: out, spoken };
}

/** Deliberately fat: the point is to cross MAX_INLINE_BYTES and take the Files API branch. */
function synthesiseLongClip(dir: string, font: string): string {
  const out = join(dir, 'long.mp4');
  execFileSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error',
     '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=25',
     '-f', 'lavfi', '-i', 'sine=frequency=420:duration=25',
     '-vf', drawFilter(font),
     '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '6M', '-maxrate', '6M', '-bufsize', '12M',
     '-c:a', 'aac', '-shortest', out],
    { stdio: 'inherit' },
  );
  return out;
}

function saw(haystack: string | null, needle: string): boolean {
  return typeof haystack === 'string' && haystack.toUpperCase().includes(needle.toUpperCase());
}

async function main() {
  const withFilesApi = process.argv.includes('--with-files-api');
  const dir = mkdtempSync(join(tmpdir(), 'gaja-asr-verify-'));

  try {
    const font = fontFile();

    // ── the bytes are checked before a call is billed ─────────────────────────
    // Cheap and first, because these two are the guards that stop money being
    // spent on a CDN that answered with an error page.
    process.stdout.write('── refusals, before any model call ───────────────────\n');
    ck('an HTML error page is not an mp4', !looksLikeMp4(Buffer.from('<!DOCTYPE html><html></html>')));

    let refusal: unknown;
    try {
      await transcribeReel({ bytes: Buffer.from('<!DOCTYPE html><html><head></head></html>') });
    } catch (e) {
      refusal = e;
    }
    ck('HTML bytes are refused by name, not sent',
      refusal instanceof AsrMediaError && refusal.reason === 'not-mp4',
      `got ${String(refusal)}`);

    let ssrf: unknown;
    try {
      await transcribeReel({ url: 'https://127.0.0.1/reel.mp4' });
    } catch (e) {
      ssrf = e;
    }
    ck('a loopback URL is refused rather than fetched',
      ssrf instanceof AsrMediaError && ssrf.reason === 'url-refused',
      `got ${String(ssrf)}`);

    // ── one real call, inline transport ───────────────────────────────────────
    process.stdout.write('\n── live Gemini call: inline transport ────────────────\n');
    const { path, spoken } = synthesiseClip(dir, font);
    const bytes = readFileSync(path);
    ck('ffmpeg produced an ISO base media file', looksLikeMp4(bytes));

    const asr = await transcribeReel({ bytes });
    process.stdout.write(
      `\n  model        ${asr.model}\n` +
      `  transport    ${asr.transport}\n` +
      `  video bytes  ${asr.bytes.toLocaleString()}\n` +
      `  latency      ${asr.ms} ms\n` +
      `  tokens       ${asr.tokens ?? 'not reported'}\n` +
      `  on-screen    ${JSON.stringify(asr.onScreenText)}\n` +
      `  speech       ${JSON.stringify(asr.speech)}\n\n`,
    );

    ck('a small clip goes inline', asr.transport === 'inline');
    ck('the model id is the pinned one', asr.model === 'gemini-3.1-flash-lite', asr.model);
    ck('the first burned-in line came back', saw(asr.onScreenText, 'YEONNAM'));
    ck('the second burned-in line came back', saw(asr.onScreenText, 'MANGWON'));
    ck('the response reported token usage', typeof asr.tokens === 'number' && asr.tokens > 0);
    if (spoken) {
      ck('the spoken track was transcribed', saw(asr.speech, 'YEONNAM'), JSON.stringify(asr.speech));
    } else {
      ck('a sine tone is not reported as speech', asr.speech === null, JSON.stringify(asr.speech));
    }

    // ── the ladder, end to end, with no caption ───────────────────────────────
    // This is the case the video rung exists for: a share with no caption at all.
    // Rung one is skipped, rung two runs, and its transcript goes back through
    // the SAME place extractor — so the result is a CaptionExtraction with real
    // candidates in it, not a transcript a caller has to interpret.
    process.stdout.write('── live ladder: no caption, video decides ────────────\n');
    const decided = await runLadder({ caption: null, video: { bytes } });
    process.stdout.write(
      `\n  decided_by   ${decided.decided_by}\n` +
      `  confidence   ${decided.confidence}\n` +
      `  places       ${JSON.stringify(decided.places.map((p) => p.name))}\n` +
      `  caption rung ${JSON.stringify(decided.rungs.caption)}\n\n`,
    );

    ck('rung one is skipped rather than failed', 'skipped' in decided.rungs.caption);
    ck('the video rung decided the reel', decided.decided_by === 'video', decided.decided_by);
    ck('the transcript became place candidates', decided.places.length === 2, `${decided.places.length} places`);
    ck('the numbering in the frames survived into the ordinals',
      decided.places.map((p) => p.ordinal).join(',') === '1,2');
    ck('the ASR observation is attached to the rung record',
      decided.rungs.video.ran === true && decided.rungs.video.ok === true && !!decided.rungs.video.asr);

    // ── the Files API branch ──────────────────────────────────────────────────
    if (withFilesApi) {
      process.stdout.write('── live Gemini call: files-api transport ─────────────\n');
      const longBytes = readFileSync(synthesiseLongClip(dir, font));
      ck('the long clip is over the inline ceiling',
        longBytes.length > 12 * 1024 * 1024, `${longBytes.length} bytes`);

      const long = await transcribeReel({ bytes: longBytes });
      process.stdout.write(
        `\n  transport    ${long.transport}\n` +
        `  video bytes  ${long.bytes.toLocaleString()}\n` +
        `  latency      ${long.ms} ms\n` +
        `  tokens       ${long.tokens ?? 'not reported'}\n` +
        `  on-screen    ${JSON.stringify(long.onScreenText)}\n\n`,
      );
      ck('a clip past the ceiling takes the Files API path', long.transport === 'files-api');
      ck('and it still reads the burned-in text', saw(long.onScreenText, 'YEONNAM'));
    } else {
      process.stdout.write('── files-api branch skipped (pass --with-files-api) ──\n');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
