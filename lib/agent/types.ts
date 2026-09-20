/**
 * The wire between `app/api/agent` and the sheet that renders it.
 *
 * Types only — no imports, no runtime. This file is reached from a Client
 * Component, so anything that touched `lib/db`, `process.env` or the Gemini SDK
 * from here would drag a server module into the browser bundle. Keep it inert.
 *
 * The transport is NDJSON rather than JSON, and rather than the AI SDK's own
 * protocol. A tool-calling turn takes seconds — an Apify run alone is tens of
 * them — and Doherty's threshold is about acknowledgement, not completion: the
 * sheet has to be able to say "저장한 곳을 보는 중" the moment that starts, not
 * after the whole turn resolves. One JSON object per line is the smallest thing
 * that carries that, needs no dependency, and is readable with `curl`.
 */

/** What the user and the model have said so far. The client owns this list; the server is stateless. */
export type AgentMessage = {
  role: 'user' | 'model';
  text: string;
};

/** A single stop in a generated course. Times are local wall-clock strings, never instants. */
export type CourseStop = {
  /** 1-based, and the order the stops are visited in. */
  order: number;
  name: string;
  /** Null when the stop is a suggestion the agent could not tie to a row in `places`. */
  saved_place_id: string | null;
  area: string | null;
  category: string | null;
  /** "13:00" — 24h wall clock. Null when the agent declined to commit to a time. */
  start: string | null;
  /** How long to spend there, in minutes. */
  minutes: number | null;
  /** One line on why this stop, in this slot. The reason the course is not just a list. */
  why: string;
};

/**
 * A course lives in the conversation and nowhere else — there is no `courses`
 * table and this type is deliberately not a row shape. The real planner, with
 * validation and the repair loop, is slice 2's; a half-planner persisted now
 * would compete with it for the same schema.
 */
export type Course = {
  title: string;
  /** e.g. "토요일 오후" — what the agent understood the occasion to be. Null when unstated. */
  when: string | null;
  stops: CourseStop[];
  /** Caveats the agent wants attached to the course: closing days, walk times, waits. */
  notes: string[];
};

/** A blog post the agent read, surfaced so a claim can be followed back to its receipt. */
export type SourceLink = {
  title: string;
  url: string;
  /**
   * ISO date of the post. Null when the source published none.
   *
   * `research_place_reviews` always has one — `NaverBlogSource` drops undated
   * posts. `discover_places` reads Instagram too, where a reel can arrive without
   * a timestamp, and writing today's date into that gap would turn "we do not
   * know when this was written" into "this is current", which is the one thing a
   * receipt must never do.
   */
  posted_at: string | null;
};

/**
 * A venue somebody else wrote about, that Gaja has no row for.
 *
 * NOT a `Place` and not a `SavedPlace`, and the distance between this type and
 * those is the entire point. Every field below is COPIED OUT OF A STRANGER'S
 * POST: the name is how one writer spelled it, the address is what they typed,
 * the category is a model's guess at what they meant. Nothing here has been
 * geocoded, matched against `places`, or checked against anything. It is the same
 * class of claim as `hours_raw`, and it gets the same 미확인 framing on screen
 * that `app/(app)/saved-places/[saved_place_id]/nearby/nearby-screen.tsx`
 * already gives its own candidates.
 *
 * `source_url` IS THE JUSTIFICATION FOR SHOWING THE ROW AT ALL, which is why it
 * is a required non-null string rather than an optional nicety. A scraped venue
 * name with no link is indistinguishable from an invented one — the receipt is
 * the only thing separating this feature from the fabrication the system
 * instruction's first rule forbids. A suggestion that loses its URL must be
 * dropped, never rendered.
 *
 * THE CATEGORY UNION IS RESTATED rather than imported, on the same rule
 * `lib/extract/types.ts` gives for the same five strings: this file is reached
 * from a Client Component and its header says to keep it inert, imports
 * included. `lib/agent/tools.ts` holds the compile-time assertion that the two
 * lists still agree.
 */
export type PlaceSuggestion = {
  /** Stable within one turn. A React key and the save button's handle — not an id, not a row. */
  key: string;
  /** The venue name as the writer wrote it. Never romanised, never corrected. */
  name: string;
  /** The Latin alias, when the writer parenthesised one. */
  name_alt: string | null;
  /**
   * The address AS WRITTEN IN THE POST — not geocoded, not canonicalised, and
   * null far more often than not. When it is null the place cannot be pinned;
   * see the save route for what happens then.
   */
  address: string | null;
  /** The 동 the search was run for, not one read off this venue. */
  area: string | null;
  category: 'cafe' | 'restaurant' | 'exhibition' | 'shop' | 'activity' | null;
  /** The extractor's own hedge on `category`. Shown as a hedge, never hidden. */
  category_confidence: 'low' | 'medium' | 'high' | null;
  /** `naver_blog` or `instagram`. Which kind of stranger. */
  source: string;
  /** THE RECEIPT. Never null. */
  source_url: string;
  /** The post's title, or a reel's first line. */
  source_title: string;
  /** ISO date of the post. Null when the source published none. */
  posted_at: string | null;
};

/**
 * One line of the stream.
 *
 * `status` is not a log line — it is the only thing on screen during a tool call,
 * so it is written as Korean UI copy at the point it is emitted, not as an
 * internal event name the client would have to translate.
 */
export type AgentEvent =
  /** A tool started. `label` is display copy; `done` marks the same step finished. */
  | { type: 'status'; label: string; done?: boolean }
  /** Incremental answer text. Concatenate in arrival order. */
  | { type: 'text'; delta: string }
  /** A structured course to render as a card rather than as prose. */
  | { type: 'course'; course: Course }
  /** Receipts for whatever the turn asserted. Rendered under the answer. */
  | { type: 'sources'; sources: SourceLink[] }
  /**
   * Venues found by `discover_places` that Gaja holds no row for, each with the
   * post it was read from and a control to save it.
   *
   * SEPARATE FROM `course`, and separate from `sources`. A course is made of
   * places we have; these are places we do not, and the sheet has to be able to
   * say so — the card carries 미확인 and the writer's link, and the save it
   * offers is an ordinary `saved_places` row with no pin, not a promotion of a
   * scraped name into a fact.
   */
  | { type: 'suggestions'; suggestions: PlaceSuggestion[] }
  /** The turn failed. `detail` is already user-facing Korean; there is no code to branch on. */
  | { type: 'error'; detail: string }
  /** The turn is over. Always the last line, including after an error. */
  | { type: 'done' };

/** POST body of `/api/agent`. */
export type AgentRequest = {
  messages: AgentMessage[];
};
