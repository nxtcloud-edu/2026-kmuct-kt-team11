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
