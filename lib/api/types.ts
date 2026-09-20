/**
 * Wire types, mirrored by hand from `docs/gaja/openapi.yaml`.
 *
 * Hand-mirrored rather than generated because slice 1 has no codegen step and
 * one more build dependency is not worth 90 lines. The cost is that this file
 * can drift: when you change a response shape, change it here in the same
 * commit. `scripts/smoke.sh` asserts the shapes over the wire, so drift is
 * caught there rather than at runtime in a browser.
 */

export type PlaceCategory = 'cafe' | 'restaurant' | 'exhibition' | 'shop' | 'activity';

/**
 * The events feed's own six categories, which are NOT `PlaceCategory`.
 *
 * `PlaceCategory` says what kind of PREMISES a venue is — the axis a map legend
 * sorts by. This says what kind of OUTING a listing is, which is the axis a
 * person browsing on a Friday sorts by. They overlap on `exhibition` and agree
 * on nothing else. `lib/events/types.ts` holds the mapping between them, and it
 * is lossy; the comment there says exactly how.
 *
 * Declared here rather than in `lib/events/` because the value crosses the wire
 * — it is the filter the browse screen sends back — and everything the client
 * sees is mirrored in this file.
 */
export type EventCategory = 'popup' | 'exhibition' | 'play' | 'musical' | 'concert' | 'sports';
export type SavedPlaceStatus = 'pending' | 'resolved' | 'needs_review' | 'rejected';
export type GroupRole = 'owner' | 'member';

export type Me = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
  email_verified: boolean;
  /**
   * PROOF, derived from `users.igsid`: Meta signed a webhook payload saying this
   * Instagram account is this person. It is NOT a sign-in method — there is no
   * Instagram OAuth in this app — and a screen that presents it as one is a bug.
   * `instagram_handle` below is the opposite kind of thing: a claim somebody
   * typed. docs/gaja/instagram-binding.md is the rule both obey.
   */
  instagram_linked: boolean;
  instagram_handle: string | null;
  locale: 'ko' | 'en';
  home_area: string | null;
  profile_visible_in_groups: boolean;
  plan: 'free';
  /** Every onboarding answer is optional, so all three are nullable. `mbti` is a
   *  plain string for the same reason it is one in `SessionUser`: the CHECK
   *  constraint is the authority on the sixteen values. */
  gender: 'female' | 'male' | 'undisclosed' | null;
  age_band: '10s' | '20s' | '30s' | '40s' | '50plus' | null;
  mbti: string | null;
  onboarded: boolean;
  recovery_channels: string[];
};

export type Place = {
  id: string;
  name: string;
  name_alt: string[];
  category: PlaceCategory;
  lat: number;
  lng: number;
  address: string | null;
  area: string;
};

/**
 * `place` is null while `status` is 'pending'. Slice 1 never produces a pending
 * row — the extractor arrives in slice 3 — but the type admits null from the
 * start so that slice does not force a client rewrite. Render accordingly.
 */
export type SavedPlace = {
  id: string;
  place: Place | null;
  group_id: string | null;
  status: SavedPlaceStatus;
  confirmed: boolean;
  hook: string | null;
  source_url: string | null;
  /**
   * The reel's cover frame, copied into Gaja's own storage at ingest time and
   * served from there. Never an Instagram CDN link: those carry an `oe=` expiry
   * measured at ~4.5 days, so a URL passed straight through would 404 inside a
   * week (supabase/migrations/20260920000009_reel_thumbnails.sql).
   *
   * Null for a hand-entered place, for a reel whose cover failed to download, and
   * for every row that predates the capture. Clients fall back; a null here is
   * ordinary, not an error.
   */
  thumb_url: string | null;
  saved_at: string;
};

export type GroupSummary = {
  id: string;
  name: string;
  member_count: number;
  role: GroupRole;
};

export type GroupMember = {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  role: GroupRole;
  joined_at: string;
};

/**
 * A reusable group invite, as the API serialises it.
 *
 * Nothing here is derived from the stored `token_hash`, and nothing here can
 * reconstruct a token: the raw token exists only in the response that mints it
 * and in the URL its creator shares. A listing is for answering "is this link
 * still open and who has used it", never for recovering a link somebody lost —
 * that is a new invite, not a lookup.
 *
 * `status` is computed server-side (lib/invites.ts) rather than left to each
 * caller, because "still open" has three inputs and two screens deriving it
 * independently is how they come to disagree.
 */
export type GroupInvite = {
  id: string;
  /** `revoked` beats `expired`: a link turned off deliberately should say so. */
  status: 'live' | 'expired' | 'revoked';
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  created_by: { user_id: string; display_name: string };
  /** How many people have joined through this link. Reusable, so not 0-or-1. */
  use_count: number;
  last_used_at: string | null;
};

export type Group = {
  id: string;
  name: string;
  role: GroupRole;
  members: GroupMember[];
  created_at: string;
};

/** Keyset pagination. `next_cursor` is opaque — never parse it. */
export type Page<T> = {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
};

/** RFC 9457. Clients branch on `type`, never on `detail`. */
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  request_id?: string;
  errors?: { field: string; message: string }[];
};

/**
 * One listing in the global events feed.
 *
 * GLOBAL, and that is the shape's defining fact: there is no `user_id` anywhere
 * in it, because the same five popups are shown to every account. The only field
 * that varies per reader is `saved`, and it is derived at read time rather than
 * stored — see `lib/events/store.ts`.
 *
 * Dates are `YYYY-MM-DD` strings rather than ISO instants. The underlying columns
 * are `date`: a popup that closes on the 11th closes at the end of the 11th in
 * Seoul, and serialising that as a timestamp would invent a time of day and then
 * shift it by the reader's offset.
 */
export type FeedEvent = {
  id: string;
  category: EventCategory;
  title: string;
  /** The venue as the source names it. `NOL 유니플렉스 1관`, `더현대 서울 B1 와인웍스`. */
  venue: string | null;
  /** The neighbourhood. From the geocode when resolved, from the source when not. */
  area: string | null;
  /**
   * A remote poster on a host `next.config.ts` allowlists, or null. Never a
   * Gaja-hosted copy: these are third-party artwork and we store the link, not
   * the picture. Null is ordinary — the card has a placeholder.
   */
  poster_url: string | null;
  /** Where 예매하기 goes. Always present; a listing without one is never stored. */
  book_url: string;
  opens_on: string | null;
  closes_on: string | null;
  /**
   * The `places` row this event resolved to, or null.
   *
   * NULL MEANS THE EVENT CANNOT BE SAVED, and that is a designed-for state, not
   * an error: most yanolja listings publish a hall name (`NOL 유니플렉스 1관`) and
   * no street address, so there is nothing to geocode and nothing to pin. The
   * card still renders and still links out to book. The save control is disabled
   * and says why, rather than failing on tap.
   */
  place_id: string | null;
  /** Whether THIS reader already has the event's place in their saved places. */
  saved: boolean;
};
