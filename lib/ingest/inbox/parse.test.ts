/**
 * Unit tests for the pure half of the poller. Run with scripts/test-ingest.sh,
 * which compiles this file and parse.ts ALONE and runs them under `node --test`.
 *
 * No live Instagram request is made here and none may be added. The fixture is
 * synthetic — hand-written to the shape docs/gaja/reel-extraction-findings.md
 * recorded, with invented ids, handles, venues and captions — because a real
 * capture would commit a stranger's DM and a creator's caption into the repo.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { THUMB_TARGET_WIDTH, detectBlock, parseInboxClips, pickThumbCandidate } from './parse';

/** Run from the repo root; scripts/test-ingest.sh enforces that. */
const payload: unknown = JSON.parse(
  readFileSync(join(process.cwd(), 'lib/ingest/inbox/__fixtures__/inbox-response.json'), 'utf8'),
);

/** The fixture's `ds_user_id` — the polling account itself. */
const SELF = '17841499999999999';

test('returns only clip items, oldest first', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  assert.deepEqual(
    clips.map((c) => c.reelVideoId),
    ['OLDSHARE006', 'FLATSHAPE004', 'FIXTURECODE01'],
  );
});

test('the text item is not a clip', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  assert.equal(
    clips.some((c) => c.caption === '여기 한번 봐봐'),
    false,
  );
});

test('items the polling account sent itself are skipped', () => {
  // Otherwise the account's own outgoing shares get filed under whichever Gaja
  // user happens to hold that igsid.
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  assert.equal(
    clips.some((c) => c.reelVideoId === 'SELFSHARE003'),
    false,
  );
  assert.equal(
    clips.some((c) => c.igsid === SELF),
    false,
  );
});

test('a media with neither code nor pk is skipped, and costs its siblings nothing', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  // Three survive from a thread that contains one unidentifiable item.
  assert.equal(clips.length, 3);
});

test('the full caption survives, emoji grammar and all', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  const listicle = clips.find((c) => c.reelVideoId === 'FIXTURECODE01');
  assert.ok(listicle);
  const caption = listicle.caption ?? '';
  // The markers the extractor parses. A truncated caption is the failure mode
  // nothing downstream can detect: a prefix of a listicle parses cleanly.
  assert.equal((caption.match(/📍/g) ?? []).length, 3);
  assert.equal((caption.match(/🕰️/g) ?? []).length, 3);
  assert.equal((caption.match(/📓/g) ?? []).length, 3);
  assert.ok(caption.includes('#예시태그'), 'the trailing hashtags are part of the caption');
});

test('a reel posted without a caption yields null, not an empty string', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  const flat = clips.find((c) => c.reelVideoId === 'FLATSHAPE004');
  assert.equal(flat?.caption, null);
});

test('the flattened item.clip shape parses as well as the nested one', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  assert.ok(clips.find((c) => c.reelVideoId === 'FLATSHAPE004'));
});

test('sourceUrl is built from the shortcode', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  const listicle = clips.find((c) => c.reelVideoId === 'FIXTURECODE01');
  assert.equal(listicle?.sourceUrl, 'https://www.instagram.com/reel/FIXTURECODE01/');
});

test('timestamps are microseconds, not milliseconds', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  const listicle = clips.find((c) => c.reelVideoId === 'FIXTURECODE01');
  // 1758330000000000 µs. Read as ms this would be the year 57,700, every clip
  // would sort after every cursor, and the poller would re-ingest the whole
  // inbox every pass while reporting success.
  assert.equal(listicle?.sharedAt.toISOString(), '2025-09-20T01:00:00.000Z');
});

test('since is exclusive at the boundary', () => {
  const all = parseInboxClips(payload, { selfUserId: SELF, since: null });
  const boundary = all[0].sharedAt;
  const after = parseInboxClips(payload, { selfUserId: SELF, since: boundary });
  assert.equal(
    after.some((c) => c.sharedAt.getTime() === boundary.getTime()),
    false,
    'a clip exactly at the cursor has already been through a pass',
  );
  assert.equal(after.length, all.length - 1);
});

test('garbage in gives an empty array, not a throw', () => {
  // One malformed response must not take the whole pass down.
  for (const junk of [null, undefined, 42, 'nope', [], {}, { inbox: {} }, { inbox: null }]) {
    assert.deepEqual(parseInboxClips(junk, { selfUserId: SELF, since: null }), []);
  }
});

// ── The cover frame ──────────────────────────────────────────────────────────

/** The portrait ladder and the square ladder, as observed: 14 entries. */
const LADDER = [
  { url: 'p1215', width: 1215, height: 2160 },
  { url: 'p1080', width: 1080, height: 1920 },
  { url: 'p720', width: 720, height: 1280 },
  { url: 'p640', width: 640, height: 1138 },
  { url: 'p480', width: 480, height: 853 },
  { url: 'p320', width: 320, height: 569 },
  { url: 'p240', width: 240, height: 427 },
  { url: 's1080', width: 1080, height: 1080 },
  { url: 's750', width: 750, height: 750 },
  { url: 's640', width: 640, height: 640 },
  { url: 's480', width: 480, height: 480 },
  { url: 's320', width: 320, height: 320 },
  { url: 's240', width: 240, height: 240 },
  { url: 's150', width: 150, height: 150 },
];

test('the smallest portrait candidate that clears the target wins', () => {
  const picked = pickThumbCandidate(LADDER);
  // Not 1215 (four times the area the deck ever paints, stored forever) and not
  // 720 (below the target, and there is no second chance to fetch a bigger one).
  assert.equal(picked?.url, 'p1080');
  assert.ok(picked && picked.width >= THUMB_TARGET_WIDTH);
});

test('a square is never preferred to a portrait, even when it is bigger', () => {
  // A reel is 9:16. The square variants are a centre crop, not a smaller copy —
  // the venue, the sign and the plate are what the crop throws away.
  const squareHeavy = [
    { url: 's1080', width: 1080, height: 1080 },
    { url: 'p640', width: 640, height: 1138 },
    { url: 'p480', width: 480, height: 853 },
  ];
  assert.equal(pickThumbCandidate(squareHeavy)?.url, 'p640');
});

test('when nothing reaches the target the largest portrait is taken', () => {
  const small = LADDER.filter((c) => c.width < 700);
  assert.equal(pickThumbCandidate(small)?.url, 'p640');
});

test('a ladder with no portrait at all still yields a cover', () => {
  // Degraded, not absent: a square cover beats a hole in the deck.
  const squares = LADDER.filter((c) => c.width === c.height);
  assert.equal(pickThumbCandidate(squares)?.url, 's1080');
});

test('the picker is total — nonsense in, null out', () => {
  assert.equal(pickThumbCandidate([]), null);
  assert.equal(
    pickThumbCandidate([
      { url: '', width: 1080, height: 1920 },
      { url: 'zero', width: 0, height: 0 },
      { url: 'nan', width: Number.NaN, height: 1920 },
      { url: 'neg', width: -1080, height: -1920 },
    ]),
    null,
  );
});

test('the choice does not depend on the order the payload happened to use', () => {
  const reversed = [...LADDER].reverse();
  assert.equal(pickThumbCandidate(reversed)?.url, pickThumbCandidate(LADDER)?.url);
});

test('a clip carries the chosen candidate, not the whole ladder', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  const listicle = clips.find((c) => c.reelVideoId === 'FIXTURECODE01');
  assert.equal(listicle?.thumb?.width, 1080);
  assert.equal(listicle?.thumb?.height, 1920);
  assert.ok(listicle?.thumb?.url.includes('p1080x1920'));
});

test('malformed candidates cost the thumbnail nothing it can still choose from', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  const flat = clips.find((c) => c.reelVideoId === 'FLATSHAPE004');
  // That item's ladder holds an empty url, a candidate with no url at all and one
  // with no dimensions, alongside a 1080 square and two real portraits.
  assert.equal(flat?.thumb?.width, 640);
  assert.equal(flat?.thumb?.height, 1138);
});

test('a clip with no image_versions2 has a null thumb, and keeps everything else', () => {
  const clips = parseInboxClips(payload, { selfUserId: SELF, since: null });
  const old = clips.find((c) => c.reelVideoId === 'OLDSHARE006');
  assert.equal(old?.thumb, null);
  // The caption is the product. It must survive the absence of a picture of it.
  assert.equal(old?.caption, '커서보다 오래된 공유');
});

test('detectBlock trips on the statuses that mean stop', () => {
  assert.equal(detectBlock(401, {}), 'http-401-session-invalid');
  assert.equal(detectBlock(429, {}), 'http-429-rate-limited');
  assert.equal(detectBlock(400, { message: 'challenge_required' }), 'challenge_required');
  assert.equal(detectBlock(403, { message: 'checkpoint_required' }), 'checkpoint_required');
  assert.equal(detectBlock(403, { message: 'login_required' }), 'login_required');
  assert.equal(detectBlock(200, { checkpoint_url: '/challenge/' }), 'checkpoint_required');
  assert.equal(detectBlock(200, { challenge: { url: '/challenge/' } }), 'challenge_required');
  assert.equal(detectBlock(400, { require_login: true }), 'login_required');
});

test('detectBlock leaves ordinary responses alone', () => {
  assert.equal(detectBlock(200, payload), null);
  // A plain failure with no spelled-out reason is not a verdict on the account —
  // a malformed cursor returns this too — so it must not cost a manual reset.
  assert.equal(detectBlock(400, { status: 'fail' }), null);
  assert.equal(detectBlock(500, {}), null);
});
