import { queryOne } from '../db';

/**
 * Which Gaja account a shared reel belongs to — and, when nobody has answered
 * that question yet, binding the sender so that it is answered from now on.
 *
 * ─── THE TRUST MODEL CHANGED ON 2026-09-20. READ THIS BEFORE WIDENING IT. ───
 *
 * This function used to match `users.igsid` and nothing else, on the rule in
 * docs/gaja/instagram-binding.md: `igsid` is proof, because it comes off a
 * webhook payload Meta signed, and `instagram_handle` is a hint, because it is a
 * string somebody typed.
 *
 * The rule was right and the system built on it did not work, for a reason the
 * doc did not anticipate: NOTHING IN THIS CODEBASE EVER WROTE `users.igsid`.
 * There is no Meta webhook route. Every other reference to the column is a read.
 * So the only igsid in the table was one put there by hand, one account could
 * receive reels, and every other sender's reel was dropped and counted — working
 * exactly as designed and useless in production.
 *
 * What replaces it is WEAKER THAN A SIGNED WEBHOOK AND STRONGER THAN A TYPED
 * STRING, and it is worth being precise about which:
 *
 *   1. The sender's @handle is not typed by the sender. It is
 *      `thread.users[].username` off an authenticated read of our own inbox —
 *      Instagram's answer to "whose account sent this". To put a handle there
 *      you must control that Instagram account.
 *   2. `users.instagram_handle` IS typed, by a signed-in Gaja user, through
 *      `PATCH /api/me`. It is a claim.
 *   3. `users_instagram_handle_lower_idx` is UNIQUE, so at most one Gaja account
 *      can be claiming any given handle.
 *
 * Together: the DM proves control of the Instagram account, the claim names the
 * Gaja account, and uniqueness means there is never a choice to make between two
 * candidates. What is missing versus the doc's ceremony is the one-time link —
 * the step where the owner of the Gaja account confirms the binding at the
 * moment it is made.
 *
 * WHAT THAT COSTS, PLAINLY. A person who types someone else's handle into
 * onboarding first will receive that person's shared reels, and the victim's own
 * claim is refused with a 409 because the squatter holds it. The webhook design
 * had the same squatting problem and no such payoff, because a held handle
 * routed nothing. Here it routes reels. That is a real, accepted regression in
 * the security posture, taken deliberately to make ingestion work for anybody
 * other than one hand-bound account. The mitigations are the ones the schema
 * already has — one claimant per handle, and `instagram_linked_at` left NULL
 * below so a handle-bound row stays in the evictable tier that a real
 * webhook-proven binding outranks.
 *
 * UNRECOGNISED SENDER: THE REEL IS STILL DROPPED. docs/gaja/instagram-binding.md
 * leaves the choice between drop-and-reply and park-the-payload open, and
 * requires whoever implements ingestion to pick one explicitly rather than let
 * the easier insert decide. This still picks DROP: holding the payload means
 * storing captions and media from a person with no Gaja account and no way to
 * ask them about it, which is a retention question we have not answered. The one
 * thing that changed is that a drop is now loud — `runIngestPass` logs the
 * handle it could not place, because "nobody claimed @someone" is the actionable
 * fact and it used to be invisible.
 */

export type ResolvedSender = {
  userId: string;
  /**
   * True when THIS call wrote `users.igsid`, matching on the claimed handle.
   * Counted in the pass summary, because a number that climbs every pass means
   * the binding is not sticking and the next reel from the same person will
   * cost another write.
   */
  boundByHandle: boolean;
};

/**
 * Instagram's own alphabet for a handle, and the same shape as both
 * `users_instagram_handle_shape` and the zod refinement in app/api/me/route.ts.
 *
 * A guard and not a validation: a username outside this shape simply cannot be
 * in the column, so matching it would find nothing anyway. It is here so that a
 * payload field that has gone strange — a display name, a URL, 4 KB of
 * something — never reaches the query at all.
 */
const HANDLE_SHAPE = /^[a-z0-9._]{1,30}$/;

/**
 * Postgres' unique_violation. `users.igsid` is `text unique`, so two passes that
 * bind the same sender to two different accounts at the same instant end with
 * one of them raising this rather than both succeeding.
 */
const UNIQUE_VIOLATION = '23505';

export async function resolveSenderToUser(
  igsid: string,
  senderUsername?: string | null,
): Promise<ResolvedSender | null> {
  // ── 1. The binding, if one exists ────────────────────────────────────────
  // `queryOne<T>` is an unchecked assertion, not a validated cast: a column named
  // in the type and missing from this select list is `undefined` at runtime with
  // nothing from tsc. That is the bug lib/social-identity.ts shipped once. One
  // column, selected, spelled the same.
  const bound = await queryOne<{ id: string }>(`select id from users where igsid = $1`, [igsid]);
  if (bound) return { userId: bound.id, boundByHandle: false };

  // ── 2. The claim, if the payload named one ───────────────────────────────
  const handle = senderUsername?.trim().toLowerCase() ?? '';
  if (!HANDLE_SHAPE.test(handle)) return null;

  // ── 3. Bind, in ONE STATEMENT ────────────────────────────────────────────
  //
  // NOT A SELECT FOLLOWED BY AN UPDATE, and that is the whole reason this is
  // written as one query. Two reels from the same new sender arrive in the same
  // pass, or two passes overlap: a read-then-write lets both see `igsid is null`,
  // both decide to bind, and the second one overwrite a binding it never checked
  // again. Every condition is in the `where`, so the second statement matches
  // nothing and the second caller falls through to the re-read below.
  //
  // THE THREE CONDITIONS, each of which is load-bearing:
  //   - the handle matches, case-insensitively, through
  //     `users_instagram_handle_lower_idx`;
  //   - that account has NO igsid yet, so a real binding — one from a webhook, or
  //     an earlier DM — can never be overwritten by a later handle claim;
  //   - no OTHER account already holds this igsid, so one Instagram account
  //     cannot end up bound to two Gaja users. `users.igsid` is `unique`, which
  //     enforces this at the index whatever this clause does; the clause is here
  //     so the ordinary case is a no-op rather than an exception.
  //
  // `instagram_linked_at` IS DELIBERATELY NOT SET. The column means "proof was
  // obtained" and what happened here is a handle claim corroborated by a DM, not
  // the confirmation ceremony docs/gaja/instagram-binding.md describes. Leaving
  // it NULL keeps this row in the tier that migration 20260920000006 calls
  // disposable — the one a genuine, webhook-proven binding is allowed to evict.
  // A timestamp written here would quietly promote a weaker fact to a stronger
  // one, which is the exact failure this whole file is careful about.
  let claimed: { id: string } | null = null;
  try {
    claimed = await queryOne<{ id: string }>(
      `update users u
          set igsid = $1
        where lower(u.instagram_handle) = lower($2)
          and u.igsid is null
          and not exists (select 1 from users o where o.igsid = $1)
      returning u.id`,
      [igsid, handle],
    );
  } catch (e) {
    // Lost the race at the index. Not an error worth failing a clip over: the
    // winner bound the same sender to the same account a millisecond ago, and
    // the re-read below finds it.
    if (!isUniqueViolation(e)) throw e;
  }

  if (claimed) {
    // The handle is public — it is an @name, and it is the one thing an operator
    // needs in order to check that a binding is the one they expected. The
    // caption, the reel and the thread id are not logged anywhere near it.
    console.log(`[ingest] bound @${handle} to a Gaja account by claimed handle`);
    return { userId: claimed.id, boundByHandle: true };
  }

  // ── 4. Re-read, for the racer that lost ──────────────────────────────────
  // The update matched nothing. Either nobody claims this handle — the ordinary
  // unknown sender, dropped by the caller — or a concurrent pass bound it
  // between step 1 and step 3. One more read separates the two, and it is the
  // difference between dropping a reel and filing it correctly.
  const now = await queryOne<{ id: string }>(`select id from users where igsid = $1`, [igsid]);
  return now ? { userId: now.id, boundByHandle: false } : null;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === UNIQUE_VIOLATION;
}
