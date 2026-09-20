#!/usr/bin/env node
// Unit test for the model-free caption parser (lib/extract/caption-grammar.ts).
//
// The repo has no unit runner and this adds none. It compiles the two modules
// under test with the TypeScript the repo already depends on, into a temp dir,
// and requires them — so `npm i` stays a five-dependency install and the test
// still runs against the real source rather than a hand-copied duplicate.
//
// `fetch` is replaced with a throwing stub before anything is loaded. The whole
// claim of the grammar parser is that it needs no network; asserting that is
// cheaper than trusting it.
//
// Run: node scripts/test-caption-grammar.mjs
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'gaja-extract-'));

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

try {
  execFileSync(
    join(repo, 'node_modules/.bin/tsc'),
    [
      'lib/extract/caption-grammar.ts',
      'lib/extract/__fixtures__/reel-captions.ts',
      '--outDir', out,
      '--rootDir', 'lib/extract',
      '--module', 'commonjs',
      '--target', 'es2022',
      '--strict',
      '--skipLibCheck',
    ],
    { cwd: repo, stdio: 'inherit' },
  );
  writeFileSync(join(out, 'package.json'), '{"type":"commonjs"}');

  globalThis.fetch = () => {
    throw new Error('the grammar parser must not reach the network');
  };

  const require = createRequire(import.meta.url);
  const grammar = require(join(out, 'caption-grammar.js'));
  const fixtures = require(join(out, '__fixtures__/reel-captions.js'));
  const { parseCaptionGrammar, splitNumberedBlocks, countNumberedBlocks, deriveConfidence } = grammar;

  // ── the ten-café caption: emoji grammar ────────────────────────────────────
  process.stdout.write('── emoji grammar ─────────────────────────────────────\n');
  const ten = parseCaptionGrammar(fixtures.TEN_CAFE_CAPTION);

  ck('six numbered entries, and the tail is not a seventh',
    countNumberedBlocks(fixtures.TEN_CAFE_CAPTION), 6);
  ck('one candidate per numbered entry', ten.places.length, 6);
  ck('ordinals come from the N. marker', ten.places.map((p) => p.ordinal), [1, 2, 3, 4, 5, 6]);
  ck('title is the caption lead-in, not a venue',
    ten.title, '여름 날에 다녀오기 좋은 싱그러운 카페 10곳 ☀️');

  // Entry 2 is quoted verbatim from the findings doc.
  ck('entry 2 parses field for field', ten.places[1], {
    ordinal: 2,
    name: '우이그',
    name_alt: 'UIG',
    handle: 'uig.official',
    address: '서울 마포구 망원로3길 7',
    hours_raw: '매일 11:00-22:30 금,토 11:00-23:00',
    menu_raw: '티그레 (4,200) 아메리카노 (4,800)',
  });

  ck('a venue with no handle gets null, not the creator\'s',
    [ten.places[2].handle, ten.places[2].name_alt], [null, null]);
  ck('jibun addresses are accepted', ten.places[2].address, '서울 용산구 후암동 2-1');
  ck('도로명 addresses are accepted', ten.places[5].address, '서울 용산구 후암로40길 3');
  ck('an entry with no 📓 keeps a null menu, not the next entry\'s',
    ten.places[4].menu_raw, null);
  ck('hours are stored raw and unparsed', ten.places[4].hours_raw, '화-일 13:00-22:00 월 휴무');

  // ── the tail ──────────────────────────────────────────────────────────────
  process.stdout.write('── the self-promo tail ───────────────────────────────\n');
  ck('the creator\'s own @handle is never a venue handle',
    ten.places.filter((p) => p.handle === 'koh_min_').length, 0);
  ck('the tail\'s address-shaped line is never a venue address',
    ten.places.filter((p) => p.address && p.address.includes('테헤란로')).length, 0);
  ck('the tail\'s own 📍 line is never a venue name',
    ten.places.filter((p) => p.name.includes('협업')).length, 0);
  ck('last numbered entry ends at the tail, not at the caption',
    ten.places[5].menu_raw, '크루아상 (4,500) 뺑오쇼콜라 (5,000)');

  const noAddress = parseCaptionGrammar(fixtures.NO_ADDRESS_CAPTION);
  ck('an entry with no address does not adopt the tail\'s',
    noAddress.places.map((p) => p.address), [null, null]);
  ck('and the entries themselves still parse',
    noAddress.places.map((p) => [p.name, p.handle]),
    [['호우주의보', 'howoo.seoul'], ['소금집델리', 'salt.house']]);
  ck('counts agree, names present, addresses missing: medium', noAddress.confidence, 'medium');

  // ── numbering-only fallbacks ──────────────────────────────────────────────
  process.stdout.write('── numbering-only fallback ───────────────────────────\n');
  const dash = parseCaptionGrammar(fixtures.DASH_DELIMITED_CAPTION);
  ck('a dash-delimited caption still yields its entries', dash.places.length, 3);
  ck('the name stops at the separator', dash.places.map((p) => p.name),
    ['밀도', '김진환제과점', '테디뵈르하우스']);
  ck('the address is read from the right of the separator', dash.places.map((p) => p.address),
    ['서울 성동구 아차산로 68', '서울 용산구 후암동 2-1', '서울 용산구 후암로40길 3']);
  ck('no marker means no handle harvested from the tail',
    dash.places.filter((p) => p.handle !== null).length, 0);

  const bare = parseCaptionGrammar(fixtures.BARE_NUMBERED_CAPTION);
  ck('name on one line, address on the next', bare.places.map((p) => [p.name, p.address]),
    [['우이그', '서울 마포구 망원로3길 7'], ['소금집델리', '서울 마포구 포은로8길 13']]);
  ck('the trailing @handle line is not adopted by the last entry',
    bare.places.filter((p) => p.handle === 'walk_seoul').length, 0);

  // ── confidence ────────────────────────────────────────────────────────────
  process.stdout.write('── derived confidence ────────────────────────────────\n');
  ck('counts agree and every entry is addressed', ten.confidence, 'high');
  ck('a caption with no numbered entries is low',
    parseCaptionGrammar('오늘 다녀온 카페 너무 좋았어요 ☕️').confidence, 'low');
  ck('an empty caption yields nothing and says so',
    [splitNumberedBlocks('').length, parseCaptionGrammar('').places.length, parseCaptionGrammar('').confidence],
    [0, 0, 'low']);
  ck('a model that returns fewer places than there are entries is low',
    deriveConfidence(ten.places.slice(0, 5), 6), 'low');
  ck('a model that invents an extra place is low',
    deriveConfidence([...ten.places, ten.places[0]], 6), 'low');
  ck('counts agree but an address is missing: medium',
    deriveConfidence([...ten.places.slice(0, 5), { ...ten.places[5], address: null }], 6), 'medium');

  ck('the parser reports itself, not a model', ten.model, 'caption-grammar');
} finally {
  rmSync(out, { recursive: true, force: true });
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
