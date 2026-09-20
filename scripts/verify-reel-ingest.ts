/**
 * The assertions for scripts/verify-reel-ingest.sh. Run it, not this — the shell
 * script is what holds the localhost rail, and this file writes and deletes rows
 * by igsid with no rail of its own.
 *
 * Everything here goes through lib/ingest/*, never through hand-written SQL that
 * mirrors it, so a test can only pass by the real write path doing the real
 * thing. The SQL below reads and cleans up; it never writes what saveReel writes.
 */
import { pool, query, queryOne } from '../lib/db';
import { resolveSenderToUser } from '../lib/ingest/route-sender';
import { saveReel } from '../lib/ingest/save-reel';

// Distinctive enough to delete by, and app-scoped nonsense by construction: an
// igsid from a real Meta app would be digits. See the app-scoping note in
// docs/gaja/instagram-binding.md — these values mean nothing anywhere else.
const IGSID = 'verify-reel-ingest-sender';
const UNKNOWN_IGSID = 'verify-reel-ingest-nobody';
const REEL = 'verify-reel-ingest-video-1';

let failures = 0;

function ok(what: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${what}`);
  } else {
    failures += 1;
    console.log(`  ✗    ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(what: string, got: T, want: T) {
  ok(what, Object.is(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

const extraction = (places: { ordinal: number; name: string }[], confidence: 'low' | 'medium' | 'high') => ({
  places: places.map((p) => ({
    ordinal: p.ordinal,
    name: p.name,
    name_alt: null,
    handle: null,
    address: null,
    hours_raw: null,
    menu_raw: null,
  })),
  title: '성수 카페 3곳',
  confidence,
  model: 'verify-fixture',
  ms: 0,
});

async function countReels(userId: string) {
  const r = await queryOne<{ n: string }>(`select count(*) as n from reels where user_id = $1`, [userId]);
  return Number(r!.n);
}

async function ordinalsFor(reelId: string) {
  const rows = await query<{ ordinal: number }>(
    `select ordinal from saved_places where reel_id = $1 order by ordinal`,
    [reelId],
  );
  return rows.map((r) => r.ordinal);
}

async function main() {
  // Re-runnable: the fixture account is deleted and recreated, and everything
  // downstream of it — reels, saved places — goes with it by ON DELETE CASCADE.
  await query(`delete from users where igsid = any($1::text[])`, [[IGSID, UNKNOWN_IGSID]]);
  await query(`delete from places where area = 'verify'`);
  const user = await queryOne<{ id: string }>(
    `insert into users (display_name, igsid) values ('verify-reel-ingest', $1) returning id`,
    [IGSID],
  );
  const userId = user!.id;

  console.log('\n1 — a reel with three place candidates');
  const routed = await resolveSenderToUser(IGSID);
  ok('resolveSenderToUser finds the account by igsid', routed?.userId === userId);

  const first = await saveReel({
    userId,
    reelVideoId: REEL,
    sourceUrl: 'https://www.instagram.com/reel/verify/',
    rawCaption: '1.어니언 2.자그마치 3.대림창고',
    extraction: extraction(
      [
        { ordinal: 1, name: '어니언 성수' },
        { ordinal: 2, name: '자그마치' },
        { ordinal: 3, name: '대림창고' },
      ],
      'high',
    ),
  });
  eq('alreadyExisted', first.alreadyExisted, false);
  eq('one reel row', await countReels(userId), 1);
  eq('three saved_places', first.savedPlaceIds.length, 3);
  ok('ordinals are 1,2,3', JSON.stringify(await ordinalsFor(first.reelId)) === '[1,2,3]');

  const reel = await queryOne<{ status: string; extracted: { places: unknown[] } | null }>(
    `select status, extracted from reels where id = $1`,
    [first.reelId],
  );
  eq("status is 'extracted'", reel!.status, 'extracted');
  eq('the full extraction is stored', reel!.extracted?.places.length, 3);

  // place_id null is what a reel saved WITHOUT `placeIds` must still produce.
  // Section 7 covers the resolved path; this one exists to keep the unresolved
  // one intact, because it is the fallback every geocode failure lands in.
  const unresolved = await queryOne<{ n: string }>(
    `select count(*) as n from saved_places
      where reel_id = $1 and place_id is null and status = 'pending' and confirmed = false`,
    [first.reelId],
  );
  eq('rows are pending, unconfirmed, unresolved', Number(unresolved!.n), 3);

  console.log('\n2 — the same reel again (a poller sees every DM twice)');
  const second = await saveReel({
    userId,
    reelVideoId: REEL,
    sourceUrl: 'https://www.instagram.com/reel/verify/',
    rawCaption: '1.어니언 2.자그마치 3.대림창고',
    extraction: extraction([{ ordinal: 1, name: '어니언 성수' }], 'high'),
  });
  eq('alreadyExisted', second.alreadyExisted, true);
  eq('same reel id', second.reelId, first.reelId);
  eq('still one reel row', await countReels(userId), 1);
  ok('still 1,2,3 — the redelivery did not rewrite them',
    JSON.stringify(await ordinalsFor(first.reelId)) === '[1,2,3]');
  ok('the same saved_places come back',
    JSON.stringify(second.savedPlaceIds) === JSON.stringify(first.savedPlaceIds));

  console.log('\n3 — a reel from an igsid nobody owns');
  const reelsBefore = await queryOne<{ n: string }>(`select count(*) as n from reels`);
  const stranger = await resolveSenderToUser(UNKNOWN_IGSID);
  eq('resolveSenderToUser returns null', stranger, null);
  const reelsAfter = await queryOne<{ n: string }>(`select count(*) as n from reels`);
  eq('nothing was written', reelsAfter!.n, reelsBefore!.n);

  console.log('\n4 — extraction outcomes the caller has to distinguish');
  const noPlaces = await saveReel({
    userId, reelVideoId: `${REEL}-empty`, sourceUrl: null, rawCaption: '여행 브이로그',
    extraction: extraction([], 'high'),
  });
  eq('zero places → needs_review', await statusOf(noPlaces.reelId), 'needs_review');
  eq('zero places → no saved_places', noPlaces.savedPlaceIds.length, 0);

  const unsure = await saveReel({
    userId, reelVideoId: `${REEL}-low`, sourceUrl: null, rawCaption: '어디였더라',
    extraction: extraction([{ ordinal: 1, name: '아마도 성수' }], 'low'),
  });
  eq('low confidence → needs_review', await statusOf(unsure.reelId), 'needs_review');
  eq('low confidence still saves the candidate', unsure.savedPlaceIds.length, 1);

  const broken = await saveReel({
    userId, reelVideoId: `${REEL}-null`, sourceUrl: null, rawCaption: null, extraction: null,
  });
  eq('no extraction → failed', await statusOf(broken.reelId), 'failed');
  eq('no extraction → no saved_places', broken.savedPlaceIds.length, 0);

  console.log('\n5 — a reel that cannot be written completely is not written at all');
  // Two venues claiming position 3 violates `saved_places_reel_ordinal_idx`, which
  // fires AFTER the reel row is inserted. If the write were not one transaction
  // the reel would survive with a truncated list and status 'extracted' — the
  // exact half-written listicle the parent row exists to make impossible.
  const clash = `${REEL}-clash`;
  let threw = false;
  try {
    await saveReel({
      userId, reelVideoId: clash, sourceUrl: null, rawCaption: '3.어니언 3.자그마치',
      extraction: extraction(
        [{ ordinal: 3, name: '어니언 성수' }, { ordinal: 3, name: '자그마치' }],
        'high',
      ),
    });
  } catch {
    threw = true;
  }
  ok('a duplicate ordinal is refused, not silently dropped', threw);
  const rolled = await queryOne<{ n: string }>(
    `select count(*) as n from reels where user_id = $1 and reel_video_id = $2`,
    [userId, clash],
  );
  eq('the reel row rolled back with its places', Number(rolled!.n), 0);

  console.log('\n6 — deleting the reel takes its saved places with it');
  await query(`delete from reels where id = $1`, [first.reelId]);
  const orphans = await queryOne<{ n: string }>(
    `select count(*) as n from saved_places where id = any($1::uuid[])`,
    [first.savedPlaceIds],
  );
  eq('saved_places cascaded away', Number(orphans!.n), 0);

  console.log('\n7 — a reel whose candidates resolved to places');
  // The path lib/research/resolve-place.ts feeds. `placeIds` is an ordinal ->
  // places.id map; an ordinal that is absent from it is a candidate the geocoder
  // could not place, and must still be written exactly as section 1 asserts.
  const onion = await makePlace('어니언 성수-verify', 37.5445, 127.0557);
  const daelim = await makePlace('대림창고-verify', 37.5417, 127.0555);

  const mixed = await saveReel({
    userId, reelVideoId: `${REEL}-resolved`, sourceUrl: null,
    rawCaption: '1.어니언 2.자그마치 3.대림창고',
    extraction: extraction(
      [
        { ordinal: 1, name: '어니언 성수' },
        { ordinal: 2, name: '자그마치' },
        { ordinal: 3, name: '대림창고' },
      ],
      'high',
    ),
    // Ordinal 2 deliberately omitted: one venue of three failed to geocode.
    placeIds: new Map([[1, onion], [3, daelim]]),
  });
  eq('all three venues saved, resolved or not', mixed.savedPlaceIds.length, 3);
  eq('ordinal 1 carries its place', await placeIdAt(mixed.reelId, 1), onion);
  eq('ordinal 1 is resolved', await statusAt(mixed.reelId, 1), 'resolved');
  eq('ordinal 3 carries its place', await placeIdAt(mixed.reelId, 3), daelim);
  // The regression guard: one bad address must cost one venue, never the reel.
  eq('the ungeocodable venue is still saved', await placeIdAt(mixed.reelId, 2), null);
  eq('and is still pending', await statusAt(mixed.reelId, 2), 'pending');

  console.log('\n8 — a venue the user already holds');
  // `saved_places_no_duplicate_idx` is unique on (user_id, place_id, group_id)
  // for any row that is not rejected. Writing a resolved place_id the user
  // already has would raise a unique violation, and because saveReel is ONE
  // transaction that violation would take all three venues down — re-creating
  // the all-or-nothing loss the geocoding seam exists to avoid. The reel must
  // save whole, with the duplicate venue written unresolved instead.
  const repeat = await saveReel({
    userId, reelVideoId: `${REEL}-repeat`, sourceUrl: null,
    rawCaption: '1.어니언 2.자그마치',
    extraction: extraction(
      [{ ordinal: 1, name: '어니언 성수' }, { ordinal: 2, name: '자그마치' }],
      'high',
    ),
    placeIds: new Map([[1, onion]]),
  });
  eq('the reel saved whole', repeat.savedPlaceIds.length, 2);
  eq('the already-held venue is written unresolved', await placeIdAt(repeat.reelId, 1), null);
  eq('and pending, for review rather than lost', await statusAt(repeat.reelId, 1), 'pending');

  console.log('\n9 — one reel naming the same venue twice');
  // Two entries 30 m apart with similar names collapse onto one places row in
  // the dedupe, so one reel can hand the same place_id to two ordinals. Same
  // index, same consequence; the first mention keeps it.
  //
  // A FRESH place, not one section 7 already saved — reuse one and this passes
  // for section 8's reason (the user already holds it) rather than this one's,
  // which is what the first draft of this assertion did.
  const seongsu = await makePlace('성수연방-verify', 37.5430, 127.0570);
  const twice = await saveReel({
    userId, reelVideoId: `${REEL}-twice`, sourceUrl: null,
    rawCaption: '1.대림창고 2.대림창고 별관',
    extraction: extraction(
      [{ ordinal: 1, name: '대림창고' }, { ordinal: 2, name: '대림창고 별관' }],
      'high',
    ),
    placeIds: new Map([[1, seongsu], [2, seongsu]]),
  });
  eq('both entries saved', twice.savedPlaceIds.length, 2);
  eq('the first mention keeps the place', await placeIdAt(twice.reelId, 1), seongsu);
  eq('the second is written unresolved', await placeIdAt(twice.reelId, 2), null);

  await query(`delete from users where id = $1`, [userId]);
  // The fixture places are not owned by the user and do not cascade with them,
  // so they are deleted by the marker area they were created with. Leaving them
  // would make the next run's dedupe match against the last run's rows.
  await query(`delete from places where area = 'verify'`);
  console.log(failures === 0 ? '\nall assertions passed\n' : `\n${failures} assertion(s) failed\n`);
}

async function makePlace(name: string, lat: number, lng: number): Promise<string> {
  // Written directly rather than through lib/places.ts: this file proves the
  // reel WRITE path, and a `places` row here is a fixture, not the thing under
  // test. The -verify suffix in the name makes a stray row identifiable.
  const row = await queryOne<{ id: string }>(
    `insert into places (name, category, lat, lng, area)
     values ($1, 'cafe', $2, $3, 'verify')
  returning id`,
    [name, lat, lng],
  );
  return row!.id;
}

async function placeIdAt(reelId: string, ordinal: number): Promise<string | null> {
  const r = await queryOne<{ place_id: string | null }>(
    `select place_id from saved_places where reel_id = $1 and ordinal = $2`,
    [reelId, ordinal],
  );
  return r!.place_id;
}

async function statusAt(reelId: string, ordinal: number): Promise<string> {
  const r = await queryOne<{ status: string }>(
    `select status from saved_places where reel_id = $1 and ordinal = $2`,
    [reelId, ordinal],
  );
  return r!.status;
}

async function statusOf(reelId: string) {
  const r = await queryOne<{ status: string }>(`select status from reels where id = $1`, [reelId]);
  return r!.status;
}

main()
  .then(() => pool.end())
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
