#!/usr/bin/env node
// Sequencing tests for the extraction ladder (lib/extract/ladder.ts) and its
// boundary table (lib/extract/confidence.ts).
//
// NO MODEL IS CALLED AND NO BYTE IS DOWNLOADED. `runLadder` takes its two rungs
// as injectable dependencies for exactly this reason, so the policy can be
// exercised across the whole table with stubs — spec §9, "ladder sequencing
// tests use stubbed rung results to assert short-circuit behaviour and band
// assignment across the boundary table."
//
// The test that matters most is the first one: the video rung's stub THROWS, so
// a run that reaches it fails loudly. That is the economic argument made
// executable — a reel whose caption already names venues must never pay for a
// 4 MB download and a video model call.
//
// Same compile-and-require harness as scripts/test-caption-grammar.mjs: the repo
// has no unit runner and this adds none.
//
// Run: node scripts/test-ladder.mjs
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'gaja-ladder-'));

let pass = 0;
let fail = 0;
function ck(label, actual, expected) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  if (got === want) {
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
    pass++;
  } else {
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n      got  ${got}\n      want ${want}\n`);
    fail++;
  }
}

/** A stub rung-one result. `confidence` is passed in rather than derived — that is the point of a stub. */
const extraction = (places, confidence, model = 'stub') => ({
  places: Array.from({ length: places }, (_, i) => ({
    ordinal: i + 1,
    name: `venue ${i + 1}`,
    name_alt: null,
    handle: null,
    address: null,
    hours_raw: null,
    menu_raw: null,
  })),
  title: null,
  confidence,
  model,
  ms: 1,
});

const asr = (onScreenText, speech) => ({
  speech,
  onScreenText,
  ms: 3900,
  model: 'gemini-stub',
  tokens: 1100,
  transport: 'inline',
  bytes: 4350463,
});

const VIDEO = { url: 'https://scontent.cdninstagram.com/v/fake.mp4?oe=DEADBEEF' };

try {
  execFileSync(
    join(repo, 'node_modules/.bin/tsc'),
    [
      'lib/extract/ladder.ts',
      '--outDir', out,
      '--rootDir', 'lib/extract',
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'es2022',
      '--lib', 'es2022,dom',
      '--types', 'node',
      '--esModuleInterop',
      '--strict',
      '--skipLibCheck',
    ],
    { cwd: repo, stdio: 'inherit' },
  );
  writeFileSync(join(out, 'package.json'), '{"type":"commonjs"}');
  // The compiled ladder requires @google/genai at load time (it imports the ASR
  // rung, which imports the SDK). A temp dir outside the repo cannot resolve it,
  // so node_modules is linked in rather than compiling into the working tree.
  symlinkSync(join(repo, 'node_modules'), join(out, 'node_modules'), 'dir');

  const require = createRequire(import.meta.url);
  const { runLadder, transcriptToText } = require(join(out, 'ladder.js'));
  const { clearsBand, RUNG_BANDS, bandFor } = require(join(out, 'confidence.js'));
  const { looksLikeMp4 } = require(join(out, 'asr.js'));

  // The network is fenced off AFTER the modules load — the model SDK is imported
  // at the top of ladder.ts and that import must stay free. Anything that calls
  // out during a run trips this.
  globalThis.fetch = () => {
    throw new Error('the ladder must not reach the network when its rungs are stubbed');
  };

  const neverRuns = () => {
    throw new Error('the video rung ran when the caption had already answered');
  };

  // ── the short circuit ─────────────────────────────────────────────────────
  process.stdout.write('── short circuit ─────────────────────────────────────\n');

  const high = await runLadder(
    { caption: '1.📍우이그\n서울 마포구 망원로3길 7', video: VIDEO },
    { extractCaption: async () => extraction(10, 'high'), transcribe: neverRuns },
  );
  ck('a high-confidence caption decides the reel', high.decided_by, 'caption');
  ck('and the video is never touched', high.rungs.video, { ran: false, skipped: 'caption-sufficient' });
  ck('ten venues survive to the result', high.places.length, 10);

  const medium = await runLadder(
    { caption: '1. 우이그', video: VIDEO },
    { extractCaption: async () => extraction(6, 'medium'), transcribe: neverRuns },
  );
  ck('medium clears the caption band too', medium.decided_by, 'caption');

  // ── the climb ─────────────────────────────────────────────────────────────
  process.stdout.write('── the climb ─────────────────────────────────────────\n');

  let transcribedWith = null;
  const climbed = await runLadder(
    { caption: '오늘 다녀온 카페 너무 좋았어요', video: VIDEO },
    {
      // First call is the caption (low), second is the transcript fed back
      // through the SAME extractor — that reuse is the contract.
      extractCaption: async (text) => (text.includes('카페 너무') ? extraction(0, 'low') : extraction(2, 'low')),
      transcribe: async (v) => {
        transcribedWith = v;
        return asr('1. 연남동 커피\n2. 망원 베이커리', '오늘은 두 곳 소개합니다');
      },
    },
  );
  ck('a low-confidence caption climbs to the video', climbed.decided_by, 'video');
  ck('the video rung got the url it was handed', transcribedWith, VIDEO);
  ck('the ASR observation is kept beside the result', climbed.rungs.video.asr.tokens, 1100);
  ck('the transcript itself is kept for the review queue',
    climbed.rungs.video.asr.onScreenText, '1. 연남동 커피\n2. 망원 베이커리');

  const thin = await runLadder(
    { caption: 'prose', video: VIDEO },
    {
      extractCaption: async (text) => (text === 'prose' ? extraction(3, 'low') : extraction(1, 'low')),
      transcribe: async () => asr('한 곳', null),
    },
  );
  ck('a three-venue low caption is not thrown away for a one-venue low transcript',
    [thin.decided_by, thin.places.length], ['caption', 3]);
  ck('but the video rung is still recorded as having run', thin.rungs.video.ran, true);

  // ── failure is not a failed run ───────────────────────────────────────────
  process.stdout.write('── failure is not a failed run ───────────────────────\n');

  const noCaption = await runLadder(
    { caption: null, video: VIDEO },
    { extractCaption: async () => extraction(9, 'high'), transcribe: async () => asr('1. 어떤 곳', null) },
  );
  ck('no caption skips rung one rather than failing it', noCaption.rungs.caption, { ran: false, skipped: 'no-caption' });
  ck('and the video rung still runs', noCaption.decided_by, 'video');

  const captionBroke = await runLadder(
    { caption: '1. 우이그', video: VIDEO },
    {
      extractCaption: async (text) => {
        if (text === '1. 우이그') throw new Error('Gemini returned no text for https://x.test/a?key=SECRET');
        return extraction(1, 'low');
      },
      transcribe: async () => asr('1. 어떤 곳', null),
    },
  );
  ck('a broken rung one does not stop the climb', captionBroke.decided_by, 'video');
  ck('and the url is stripped out of the recorded error',
    captionBroke.rungs.caption.error, 'Gemini returned no text for <url>');

  const videoBroke = await runLadder(
    { caption: 'prose', video: VIDEO },
    {
      extractCaption: async () => extraction(0, 'low'),
      transcribe: async () => { throw new Error('Reel video unusable: download-status-403'); },
    },
  );
  ck('an expired CDN link is recorded, not thrown', videoBroke.rungs.video.ok, false);
  ck('and the run still returns a usable shape', [videoBroke.decided_by, videoBroke.places.length], ['none', 0]);

  const silent = await runLadder(
    { caption: null, video: VIDEO },
    { extractCaption: async () => extraction(0, 'low'), transcribe: async () => asr(null, null) },
  );
  ck('a silent reel with no burned-in text is ok with zero places, not an error',
    [silent.rungs.video.ok, silent.rungs.video.places, silent.decided_by], [true, 0, 'none']);

  const nothing = await runLadder({ caption: null, video: null }, { transcribe: neverRuns });
  ck('nothing in, nothing out, and nobody threw',
    [nothing.decided_by, nothing.rungs.video.skipped, nothing.confidence], ['none', 'no-video', 'low']);

  // ── the boundary table ────────────────────────────────────────────────────
  process.stdout.write('── boundary table ────────────────────────────────────\n');
  ck('two rungs, in ladder order', RUNG_BANDS.map((b) => b.rung), ['caption', 'video']);
  ck('the caption band sits between medium and low', bandFor('caption').minConfidence, 'medium');
  ck('a low caption does not clear', clearsBand(extraction(10, 'low'), 'caption'), false);
  ck('a medium caption does', clearsBand(extraction(1, 'medium'), 'caption'), true);
  ck('a caption that named nothing never clears, whatever it scored',
    clearsBand(extraction(0, 'high'), 'caption'), false);
  ck('a low transcript clears the video band', clearsBand(extraction(1, 'low'), 'video'), true);

  // ── the transcript, rearranged for rung one ───────────────────────────────
  process.stdout.write('── transcript arrangement ────────────────────────────\n');
  ck('on-screen text comes first so its numbering is visible to the parser',
    transcriptToText({ onScreenText: '1. 우이그', speech: '안녕하세요' }), '1. 우이그\n\n안녕하세요');
  ck('a silent reel still yields its burned-in text',
    transcriptToText({ onScreenText: '1. 우이그', speech: null }), '1. 우이그');
  ck('nothing at all is null, not an empty string',
    transcriptToText({ onScreenText: null, speech: '   ' }), null);

  // ── the bytes are checked before a call is billed ─────────────────────────
  process.stdout.write('── mp4 sniffing ──────────────────────────────────────\n');
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
  ck('an ISO base media file is accepted', looksLikeMp4(ftyp), true);
  ck('a CDN error page is not', looksLikeMp4(Buffer.from('<!DOCTYPE html><html><head></head></html>')), false);
  ck('a JPEG is not', looksLikeMp4(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0, 0])), false);
  ck('twelve bytes of nothing is not', looksLikeMp4(Buffer.alloc(4)), false);
} finally {
  rmSync(out, { recursive: true, force: true });
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
