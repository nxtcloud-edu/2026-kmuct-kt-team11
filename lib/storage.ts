/**
 * Supabase Storage, and the one exception to "Supabase is an identity provider".
 *
 * Every other use of Supabase in this codebase is the OAuth handshake
 * (lib/supabase.ts); Postgres is reached directly through `lib/db.ts` and no
 * table is ever read through a Supabase client. That posture is written down in
 * .env.example and it still holds for TABLES.
 *
 * This file is the exception, stated rather than smuggled in: reel cover frames
 * are OBJECTS, and objects need somewhere to live that is not a Postgres column
 * and not the repo. Storing bytes is not reading tables, and nothing here
 * touches PostgREST or any row of application data. If a later change finds
 * itself doing `.from('reels').select()` through this module, the exception has
 * been abused and the right fix is `lib/db.ts`.
 *
 * WHY THE BYTES AND NOT THE INSTAGRAM URL is argued in
 * supabase/migrations/20260920000009_reel_thumbnails.sql: the candidate URLs
 * carry an `oe=` expiry measured at ~4.5 days, so a stored URL is a stored 404.
 *
 * WHY `fetch` AND NOT `@supabase/supabase-js`, WHICH IS ALREADY A DEPENDENCY.
 * `createClient()` builds an auth client and a realtime client before it will
 * hand you `.storage`, and the realtime one demands a native `WebSocket` — which
 * Node 20, the version this repo runs, does not have. It throws on construction:
 * "Node.js detected but native WebSocket not found". Measured, not assumed. The
 * three calls needed here are a POST, a GET and a DELETE against a documented
 * REST API; going through a client that opens a websocket to make them is the
 * larger dependency, not the smaller one. The SDK stays in package.json for
 * `@supabase/ssr` and the OAuth flow.
 */

/**
 * PUBLIC bucket. The decision and its counter-arguments are argued at length in
 * 20260920000009_reel_thumbnails.sql — read that before changing it, because the
 * unguessable object path in lib/ingest/thumbnail.ts is load-bearing for it.
 */
export const REEL_THUMB_BUCKET = 'reel-thumbs';

/**
 * Whether thumbnail capture can run at all.
 *
 * Checked before a pass rather than discovered inside one, so an unconfigured
 * deployment ingests reels with null thumbnails and a single log line, instead
 * of throwing once per clip and making every pass look half-broken.
 */
export function reelThumbStorageConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * SERVICE ROLE, and only ever on the server.
 *
 * Writing to Storage needs a role that bypasses `storage.objects` RLS; the anon
 * key can read the public path and nothing else, which is exactly the split we
 * want — measured: an anon `POST /object/list/reel-thumbs` returns `[]` with an
 * object sitting in the bucket, because no policy grants it a row. The
 * consequence is that this key is a full-project credential and must never be
 * `NEXT_PUBLIC_`, never logged, and never reach a client component.
 */
function credentials(): { base: string; key: string } {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Names the variables, never the values. An error message is the likeliest
  // place a secret escapes: it is the one string that gets logged, forwarded to
  // an error tracker and pasted into a chat.
  if (!base || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to store reel thumbnails. See .env.example.',
    );
  }
  return { base: base.replace(/\/+$/, ''), key };
}

/** Path segments are uuids today, but encoding them is one call and a path is user-adjacent data. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export type StoragePut = { ok: true } | { ok: false; reason: string };

/**
 * Write one object, refusing to overwrite.
 *
 * Without `x-upsert` the API answers 409 `KeyAlreadyExists`, which is what we
 * want: paths are random uuids, a collision is not a thing that happens, and if
 * one somehow did then silently replacing another reel's cover is the worst
 * available outcome. A visible failure is better.
 */
export async function putReelThumb(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<StoragePut> {
  const { base, key } = credentials();
  const res = await fetch(`${base}/storage/v1/object/${REEL_THUMB_BUCKET}/${encodePath(path)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': contentType,
      // The path is unique per object and an object is never rewritten, so the
      // bytes behind a URL can never change. A year is safe and keeps the deck
      // off the network on every revisit. Storage stores this and serves it back
      // on the public GET.
      'cache-control': 'max-age=31536000, immutable',
    },
    // A `Uint8Array` IS a valid request body at runtime — undici accepts any
    // BufferSource. The cast is a types problem, not a behaviour one: this
    // project's DOM lib declares `BodyInit` without `Uint8Array<ArrayBufferLike>`,
    // so tsc rejects the one shape that actually works. Copying into a Blob to
    // satisfy it would duplicate the buffer for nothing.
    body: bytes as unknown as BodyInit,
  });
  // The response body is Storage's own JSON error and may quote the path; the
  // status is the whole of what a caller needs, and a status cannot leak a key.
  return res.ok ? { ok: true } : { ok: false, reason: `storage-${res.status}` };
}

/**
 * Remove one object. Used only to clean up an upload that lost a race — see
 * lib/ingest/thumbnail.ts. Returns whether it is gone; callers do not branch on
 * a failure to delete, they log it.
 */
export async function deleteReelThumb(path: string): Promise<boolean> {
  const { base, key } = credentials();
  const res = await fetch(`${base}/storage/v1/object/${REEL_THUMB_BUCKET}/${encodePath(path)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${key}` },
  });
  return res.ok;
}

/**
 * The browser-facing URL for a stored cover.
 *
 * Built as a string rather than by asking Storage, because this runs once per
 * saved place in a list serialiser and the answer is a concatenation of two
 * things we already hold. The format is Storage's own public-object route; if
 * that ever changes, it changes here.
 *
 * Returns null when `SUPABASE_URL` is unset — a deployment with thumbnails in
 * the database and no Supabase configured renders the fallback rather than an
 * `undefined/storage/...` src.
 */
export function reelThumbPublicUrl(path: string | null): string | null {
  if (!path) return null;
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/storage/v1/object/public/${REEL_THUMB_BUCKET}/${encodePath(path)}`;
}
