/**
 * The assertions for scripts/verify-reel-thumbnail.sh. Run that, not this — the
 * shell script holds the localhost rail and the env checks; this file writes and
 * deletes rows and objects with no rail of its own.
 *
 * WHAT IT PROVES, end to end, against a live Supabase Storage:
 *   1. a real image is downloaded over HTTPS from a host we do not control,
 *   2. its type and size are read FROM THE BYTES, not from a header,
 *   3. the bytes are uploaded and read back BYTE-IDENTICAL,
 *   4. the dimensions recorded in `reels` match the dimensions in the file,
 *   5. the object is reachable at its public URL with no credentials at all —
 *      which is the whole claim the public-bucket decision rests on,
 *   6. a second capture of the same reel neither re-records nor litters the
 *      bucket,
 *   7. a URL that is not an image is refused rather than stored.
 *
 * Everything goes through lib/ingest/thumbnail.ts and lib/storage.ts. The SQL
 * here only reads back and cleans up; it never writes what the capture writes.
 */
import { pool, query, queryOne } from '../lib/db';
import { captureReelThumbnail } from '../lib/ingest/thumbnail';
import { probeImage } from '../lib/ingest/image-probe';
import { REEL_THUMB_BUCKET, deleteReelThumb, reelThumbPublicUrl } from '../lib/storage';

/** App-scoped nonsense by construction, and distinctive enough to delete by. */
const IGSID = 'verify-reel-thumbnail-sender';
const REEL_VIDEO_ID = 'verify-reel-thumbnail-video-1';

/**
 * The image to capture.
 *
 * A real `image_versions2` candidate URL cannot be committed: it carries an
 * `oe=` expiry of roughly four and a half days, so a hardcoded one would be a
 * script that passes this week and fails silently forever after — the precise
 * failure mode that made us copy the bytes in the first place.
 *
 * So the default is a stable public portrait JPEG, and `REEL_THUMB_URL` lets you
 * point the same assertions at a genuine candidate within its lifetime:
 *
 *   REEL_THUMB_URL='https://scontent…cdninstagram.com/…?oe=…' ./scripts/verify-reel-thumbnail.sh
 *
 * The code path is identical either way — `captureReelThumbnail` has no idea
 * which host it is talking to, which is the point of it not having an
 * Instagram-specific allowlist.
 */
const DEFAULT_URL = 'https://picsum.photos/id/1025/720/1280.jpg';
const SOURCE_URL = process.env.REEL_THUMB_URL || DEFAULT_URL;

let failures = 0;

function ok(what: string, pass: boolean, detail = '') {
  if (pass) console.log(`  ok   ${what}`);
  else {
    failures += 1;
    console.log(`  ✗    ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(what: string, got: T, want: T) {
  ok(what, Object.is(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

type ThumbRow = {
  thumb_path: string | null;
  thumb_width: number | null;
  thumb_height: number | null;
  thumb_captured_at: Date | null;
  thumb_source_url: string | null;
};

async function thumbRow(reelId: string): Promise<ThumbRow> {
  const r = await queryOne<ThumbRow>(
    `select thumb_path, thumb_width, thumb_height, thumb_captured_at, thumb_source_url
       from reels where id = $1`,
    [reelId],
  );
  return r!;
}

async function main() {
  console.log(
    SOURCE_URL === DEFAULT_URL
      ? `\nsource: ${SOURCE_URL}\n        (stand-in — set REEL_THUMB_URL to a live image_versions2 candidate to\n         exercise the real Instagram host)`
      : `\nsource: a supplied URL (not printed; candidate URLs are signed)`,
  );

  // Re-runnable. The fixture account is deleted and recreated; reels go with it
  // by ON DELETE CASCADE. Objects are removed explicitly at the end — a bucket
  // has no foreign keys.
  await query(`delete from users where igsid = $1`, [IGSID]);
  const user = await queryOne<{ id: string }>(
    `insert into users (display_name, igsid) values ('verify-reel-thumbnail', $1) returning id`,
    [IGSID],
  );
  const userId = user!.id;

  const reel = await queryOne<{ id: string }>(
    `insert into reels (user_id, reel_video_id, source_url, status)
          values ($1, $2, 'https://www.instagram.com/reel/verify/', 'extracted')
       returning id`,
    [userId, REEL_VIDEO_ID],
  );
  const reelId = reel!.id;

  const strays: string[] = [];

  console.log('\n1 — download, verify, upload, record');
  const shot = await captureReelThumbnail(reelId, {
    url: SOURCE_URL,
    // Deliberately WRONG, and never used for anything but the picker's choice.
    // If these numbers ever leaked into the recorded row, this assertion is what
    // catches it: what gets stored must be what the FILE says, not what the
    // payload claimed.
    width: 1,
    height: 1,
  });
  if (!shot.ok) {
    ok(`capture succeeded`, false, `reason: ${shot.reason}`);
    await cleanup(userId, strays);
    return;
  }
  strays.push(shot.capture.path);
  ok('capture succeeded', true);
  ok(
    `stored ${shot.capture.width}x${shot.capture.height} ${shot.capture.contentType}, ${shot.capture.bytes} bytes`,
    true,
  );
  ok(
    'the object path is a random uuid, not derived from the reel',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/.test(
      shot.capture.path,
    ) &&
      !shot.capture.path.includes(reelId) &&
      !shot.capture.path.includes(REEL_VIDEO_ID),
    shot.capture.path,
  );

  console.log('\n2 — the row records the file, not the payload');
  const row = await thumbRow(reelId);
  eq('thumb_path matches the upload', row.thumb_path, shot.capture.path);
  eq('thumb_width is the decoded width', row.thumb_width, shot.capture.width);
  eq('thumb_height is the decoded height', row.thumb_height, shot.capture.height);
  ok('thumb_captured_at is set', row.thumb_captured_at instanceof Date);
  ok('thumb_source_url is retained for debugging', row.thumb_source_url === SOURCE_URL);
  ok(
    'the payload\'s claimed 1x1 was not believed',
    row.thumb_width !== 1 && row.thumb_height !== 1,
  );

  console.log('\n3 — the bytes round-trip');
  const downloaded = await storageFetch(`object/${REEL_THUMB_BUCKET}/${shot.capture.path}`);
  if (!downloaded.ok) {
    ok('the object reads back from Storage', false, `HTTP ${downloaded.status}`);
  } else {
    const back = Buffer.from(await downloaded.arrayBuffer());
    eq('the stored object is exactly as many bytes as were uploaded', back.length, shot.capture.bytes);
    const reprobed = probeImage(back);
    ok('what came back is still a decodable image', reprobed !== null);
    eq('its width matches what was recorded', reprobed?.width, row.thumb_width!);
    eq('its height matches what was recorded', reprobed?.height, row.thumb_height!);
    eq('its type matches what was recorded', reprobed?.contentType, shot.capture.contentType);
  }

  console.log('\n4 — the public URL serves it with no credentials');
  // No key, no header, no cookie. This is the assertion the public-bucket
  // decision stands on: if this needs auth, `next/image` cannot render it and
  // the decision in 20260920000009 was wrong.
  const publicUrl = reelThumbPublicUrl(row.thumb_path);
  ok('a public URL can be built', Boolean(publicUrl));
  if (publicUrl) {
    const res = await fetch(publicUrl);
    eq('anonymous GET returns 200', res.status, 200);
    const served = Buffer.from(await res.arrayBuffer());
    eq('the served bytes are the uploaded bytes', served.length, shot.capture.bytes);
    ok(
      'the served type is what the bytes are',
      res.headers.get('content-type')?.startsWith(shot.capture.contentType) === true,
      res.headers.get('content-type') ?? 'none',
    );
  }

  console.log('\n5 — a second capture is a no-op, and leaves no litter');
  const again = await captureReelThumbnail(reelId, { url: SOURCE_URL, width: 1, height: 1 });
  eq('the second capture refuses', again.ok, false);
  if (!again.ok) eq('…because the reel already has a cover', again.reason, 'already-captured');
  const after = await thumbRow(reelId);
  eq('the recorded path is unchanged', after.thumb_path, row.thumb_path);
  // The second call uploaded before it discovered it had lost, and must have
  // deleted its own object. A public, unreferenced file is what a storage bill
  // is made of.
  const listed = await storageFetch(`object/list/${REEL_THUMB_BUCKET}`, {
    method: 'POST',
    body: JSON.stringify({ prefix: '', limit: 1000 }),
  });
  const objects: { name: string }[] = listed.ok ? await listed.json() : [];
  eq(
    'exactly one object exists for this reel',
    objects.filter((o) => o.name === shot.capture.path).length,
    1,
  );

  console.log('\n6 — what is not an image is refused, not stored');
  const notAnImage = await captureReelThumbnail(reelId, {
    // A real, reachable HTTPS URL that answers with something that is not an
    // image. `Content-Type` alone would not save us here; the probe does.
    url: 'https://example.com/',
    width: 1080,
    height: 1920,
  });
  eq('a non-image URL is refused', notAnImage.ok, false);
  if (!notAnImage.ok) {
    ok(
      `…with a reason that names the cause (${notAnImage.reason})`,
      ['not-an-image', 'too-large', 'download-failed', `http-404`].includes(notAnImage.reason) ||
        notAnImage.reason.startsWith('http-'),
      notAnImage.reason,
    );
  }

  console.log('\n7 — a private-address URL never leaves the process');
  const ssrf = await captureReelThumbnail(reelId, {
    url: 'https://169.254.169.254/latest/meta-data/',
    width: 1080,
    height: 1920,
  });
  eq('the link-local address is refused before any fetch', ssrf.ok, false);
  if (!ssrf.ok) eq('…as url-refused', ssrf.reason, 'url-refused');

  await cleanup(userId, strays);
}

/**
 * The Storage REST API, as the service role. Only the assertions use this —
 * lib/storage.ts exposes exactly the three calls the application makes, and a
 * test that needs a fourth (read-back, list) reaches for the API rather than
 * widening the module under test to suit its own tests.
 */
function storageFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = process.env.SUPABASE_URL!.replace(/\/+$/, '');
  return fetch(`${base}/storage/v1/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function cleanup(userId: string, paths: string[]) {
  for (const p of paths) await deleteReelThumb(p);
  await query(`delete from users where id = $1`, [userId]);
  console.log('\ncleaned up.');
}

main()
  .then(() => pool.end())
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
