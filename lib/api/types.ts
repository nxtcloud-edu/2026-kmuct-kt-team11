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
  instagram_linked: boolean;
  locale: 'ko' | 'en';
  home_area: string | null;
  profile_visible_in_groups: boolean;
  plan: 'free';
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
