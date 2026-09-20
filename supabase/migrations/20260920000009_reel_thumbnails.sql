-- The reel's cover frame, stored as bytes we own.
--
-- Until now the deck showed one of 24 stock JPEGs picked by hashing a row id
-- (lib/reel-thumb.ts, a documented mock). The real frame was always in the DM
-- payload: every `clip` item carries `image_versions2.candidates`, 14 entries of
-- `{url, width, height}` from 1215x2160 down to 150x150.
--
-- WHY THE BYTES AND NOT THE URL. Those candidate URLs expire. The `oe=` query
-- parameter is a hex unix timestamp, and a live sample measured 107.8 hours
-- (~4.5 days) of remaining life at capture. A `thumb_url` column pointed at the
-- Instagram CDN would therefore be a column of 404s within a week of being
-- written — the failure would arrive quietly, after the ingest pass that looked
-- like it worked, and would look like a Gaja bug. So the poller copies the bytes
-- into our own object store at ingest time and this table records where they
-- landed.
--
-- WHY ON `reels` AND NOT `saved_places`. One reel is ten saved places (see
-- 20260920000005). The cover frame belongs to the reel; hanging it off the child
-- would store the same image ten times and leave no answer to "have we captured
-- this reel's thumbnail yet?" that did not mean reading ten rows and hoping they
-- agree. `SAVED_PLACE_SELECT` already joins `reels` to recover `source_url`, so
-- the read costs nothing new.

alter table reels
  -- Object path inside the `reel-thumbs` bucket, WITHOUT the bucket name —
  -- `lib/storage.ts` owns the join between the two, so moving buckets is one
  -- constant rather than an UPDATE over every row.
  --
  -- The path is a random uuid, NOT derived from `reels.id`, the user, the
  -- shortcode or anything else a stranger could hold. That is a load-bearing
  -- property of the public-bucket decision argued below, not a stylistic choice:
  -- see lib/ingest/thumbnail.ts.
  add column thumb_path         text,

  -- The dimensions of the bytes we actually stored, DECODED FROM THE FILE rather
  -- than copied from the candidate's own `width`/`height`. Instagram's number is
  -- a claim about a URL; ours is a fact about the object. They have agreed in
  -- every sample so far, and the day they disagree is the day the deck reserves
  -- the wrong aspect ratio and every card jumps on load.
  add column thumb_width        integer check (thumb_width  > 0),
  add column thumb_height       integer check (thumb_height > 0),

  -- When the copy was made. Not `shared_at`: a reel shared in March whose
  -- thumbnail was backfilled in May has two different answers, and the one that
  -- matters for "is this object still there" is this one.
  add column thumb_captured_at  timestamptz,

  -- The CDN URL the bytes came from. KEPT FOR DEBUGGING ONLY, AND EXPECTED TO BE
  -- DEAD. By the time anyone reads this column the `oe=` expiry has almost
  -- certainly passed — see the header. Its value is answering "which candidate
  -- did the picker choose, and did it pick a portrait one?" from a row, weeks
  -- later, without a re-poll. Nothing may fetch it; nothing may render it.
  add column thumb_source_url   text,

  -- All four or none. A path with no dimensions is an image the deck cannot
  -- reserve space for, and dimensions with no path are a measurement of nothing.
  -- `thumb_source_url` is deliberately outside the constraint: it is a debugging
  -- note about a URL, not part of the record of a stored object.
  add constraint reels_thumb_complete check (
    (thumb_path is null     and thumb_width is null     and thumb_height is null     and thumb_captured_at is null)
    or
    (thumb_path is not null and thumb_width is not null and thumb_height is not null and thumb_captured_at is not null)
  );

-- "Which reels still have no cover?" — the backfill's own read, and the guard
-- that keeps a re-ingest from re-downloading. Partial, because the rows worth
-- finding are exactly the null ones and a full index over a column that is
-- mostly non-null in the steady state is dead weight.
create index reels_thumb_pending_idx on reels (user_id, shared_at desc)
  where thumb_path is null;

-- ── The bucket, and why it is public ─────────────────────────────────────────
--
-- THIS IS THE FIRST DATA-PLANE USE OF SUPABASE IN THIS CODEBASE. Everything
-- before it went through `lib/db.ts` to Postgres directly, and .env.example says
-- in as many words that Supabase is an identity provider and nothing else. That
-- sentence now carries a stated exception; it was updated in the same change as
-- this migration rather than being left to mislead the next reader.
--
-- PUBLIC, decided as follows.
--
-- For public:
--   * `next/image` can take a plain URL. A private bucket needs a signed URL per
--     object per render, which is a Storage round trip for every card in a deck
--     the user flicks through — and the signature expires, which reintroduces
--     the exact rot (a link that 404s after N hours) that copying the bytes
--     exists to eliminate, only this time with our name on it.
--   * The bytes are not a secret. This is the cover frame of a reel its creator
--     published publicly on Instagram; it was fetched server-side with no
--     cookies, no token and no session — HTTP 200 to a plain `fetch`. A public
--     object here exposes nothing that instagram.com does not already serve to
--     anyone who asks.
--
-- Against, and how it is answered:
--   * The project's posture is RLS-everywhere, and a public bucket has no RLS on
--     the read path. So the OBJECT PATH is the capability: a random uuid, never
--     the reel id, the user id or a sequence. There is nothing to enumerate by
--     guessing, and the URL only ever reaches a client that is already allowed to
--     see the saved place it belongs to.
--   * Listing is a separate permission from public read. `storage.objects` keeps
--     its own RLS and this migration adds NO policy for `anon` or
--     `authenticated`, so neither role may list the bucket — the public path
--     serves one known object, it does not publish an index. Do not add a select
--     policy here "for convenience"; that would turn the unguessable path back
--     into a directory.
--
-- If a reel ever needs a genuinely private image — a frame from a private
-- account, or anything a user rather than a creator authored — it does not
-- belong in this bucket. Make a second, private one; do not make this one
-- private and bolt signing onto the deck.
do $$
begin
  -- Guarded so the migration is runnable against a plain Postgres with no
  -- Supabase Storage schema. The columns above are the part the application
  -- cannot run without; the bucket is provisioning, and provisioning that
  -- aborts a schema migration on a bare database helps nobody.
  if to_regclass('storage.buckets') is null then
    raise notice 'storage.buckets not present; skipping reel-thumbs bucket creation';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
       values (
         'reel-thumbs', 'reel-thumbs', true,
         -- 8 MiB. The largest candidate observed was 1215x2160 at ~150 KB, so
         -- this is two orders of magnitude of headroom and still a hard stop
         -- against a CDN that answers a thumbnail request with a video.
         -- lib/ingest/thumbnail.ts enforces a tighter bound before it uploads;
         -- this is the backstop for the day someone writes a second uploader.
         8388608,
         -- Sniffed from the bytes as well, in lib/ingest/thumbnail.ts. A
         -- Content-Type header is a claim by the sender; this list is what the
         -- bucket will actually accept if that claim is all anyone checked.
         array['image/jpeg', 'image/png', 'image/webp']
       )
  on conflict (id) do nothing;
end $$;
