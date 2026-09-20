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
  /** ISO date of the post. */
  posted_at: string;
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
  /** The turn failed. `detail` is already user-facing Korean; there is no code to branch on. */
  | { type: 'error'; detail: string }
  /** The turn is over. Always the last line, including after an error. */
  | { type: 'done' };

/** POST body of `/api/agent`. */
export type AgentRequest = {
  messages: AgentMessage[];
};
