/**
 * The seam between "how a pasted reel reaches us" and "what we do with it" —
 * the sibling of lib/ingest/inbox/index.ts, and deliberately not the same seam.
 *
 * WHY A SECOND INTERFACE RATHER THAN A SECOND `InboxSource`. An `InboxSource`
 * answers "what has arrived since this time, and who sent each one" — it returns
 * clips carrying an `igsid`, and `resolveSenderToUser` turns that into an
 * account. A pasted URL answers neither question. There is no `since`, because
 * one link is one reel; and there is no sender, because the person asking is
 * already signed in and holding a session cookie.
 *
 * That difference is not a wrinkle to paper over, it is the reason this file
 * exists. Implementing `InboxSource` here would have meant inventing an `igsid`
 * for a request that has none, and `igsid` is the one identifier in this schema
 * that means *proof* — see docs/gaja/instagram-binding.md. A synthetic one would
 * be the unverified-claim defect the binding rule was written to prevent,
 * reintroduced through a type signature. The session IS the proof on this path,
 * and it never needs converting.
 *
 * What the two seams DO share is everything after the payload: a `ReelPayload`
 * from here and a `ReelPayload` from an `InboxClip` are the same five fields, and
 * both go into the same `ingestClip` (lib/ingest/ingest-clip.ts). There is one
 * pipeline in this repo and this is not a second one.
 *
 * Anything Instagram-web-specific — cookie headers, the `X-IG-App-ID` value, the
 * shape of `items[0]`, the circuit breaker — belongs behind this interface and
 * must not leak through `ReelPayload`. Same rule as the inbox seam, same reason.
 */

import type { ReelPayload } from '../ingest-clip';

/**
 * One reel, fetched by its shortcode.
 *
 * `since` has no analogue and is deliberately absent rather than accepted and
 * ignored: a parameter a source must ignore is a parameter the next reader will
 * assume does something.
 *
 * Implementations THROW rather than returning null when they cannot produce a
 * reel, and they throw one of the named classes in ./instagram-media.ts so the
 * caller can tell a private post apart from a dead session. A source that
 * returned a half-empty payload for a post it could not read would hand the
 * caller a reel with no caption, which is indistinguishable from a real reel
 * posted without one.
 */
export interface ReelUrlSource {
  fetchByShortcode(shortcode: string): Promise<ReelPayload>;
}
