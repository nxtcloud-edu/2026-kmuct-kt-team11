import { query, queryOne } from '../db';

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
 *   3. The claim is NOT exclusive. Migration 20260920000013 dropped the unique
 *      index, so any number of Gaja accounts may claim one handle.
 *
 * Together: the DM proves control of the Instagram account and the claims name
 * the Gaja accounts. What is missing versus the doc's ceremony is the one-time
 * link — the step where the owner of the Gaja account confirms the binding at
 * the moment it is made.
 *
 * WHAT THAT COSTS, PLAINLY. Uniqueness used to mean routing never had a choice
 * to make. It now has one, and it declines to choose: a reel goes to EVERY
 * account claiming the sender's handle. So a person who types a stranger's id
 * receives that stranger's shared reels — captions, links and all — and neither
 * of them is told. Under the old index a squatter at least had to get there
 * first and the real owner got a 409; now both succeed and both get the reels.
 *
 * That is a real, accepted regression in the security posture, taken
 * deliberately: the index was refusing people who had never signed up, and a
 * group of testers sharing one Instagram account is a world uniqueness cannot
 * model. The mitigation left is `instagram_linked_at`, still NULL below, which
 * keeps a handle-bound row in the tier a genuine webhook-proven binding evicts.
 * If this product ever has users who are strangers to each other, the fix is
 * the confirmation step, not a return to uniqueness — uniqueness never proved
 * ownership, it only rationed the claim.
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

/**
 * EVERY account the reel belongs to — plural, since 2026-09-20.
 *
 * `instagram_handle` is no longer unique (migration 20260920000013). Several
 * Gaja accounts may claim one Instagram id, because several testers share one,
 * and one person signs in from more than one account. So routing no longer picks
 * a winner: a shared reel is delivered to every account claiming the sender's
 * handle, plus the account bound to the sender's igsid if there is one.
 *
 * Returns `[]` for an unrecognised sender — the caller drops, as before.
 */
export async function resolveSenderToUsers(
  igsid: string,
  senderUsername?: string | null,
): Promise<ResolvedSender[]> {
  const handle = senderUsername?.trim().toLowerCase() ?? '';
  const usable = HANDLE_SHAPE.test(handle) ? handle : '';

  // ── 1. Bind, opportunistically ───────────────────────────────────────────
  //
  // Still ONE STATEMENT, for the reason it always was: two reels from the same
  // new sender in one pass must not both decide to bind. It matters less than it
  // did — the handle lookup below finds the account whether or not this lands —
  // but it keeps the igsid fast path warm for a sender whose username Instagram
  // stops giving us, and it is what `bound_by_handle` counts.
  //
  // `limit 1` inside the subselect is the ONE thing that changed here. With the
  // unique index gone, `lower(instagram_handle) = $2` can match several rows;
  // `users.igsid` is still `text unique`, so exactly one of them may hold it.
  // Picking the oldest unbound claimant is arbitrary but stable — it does not
  // change who receives the reel, only who owns the shortcut.
  let boundId: string | null = null;
  if (usable !== '') {
    try {
      const claimed = await queryOne<{ id: string }>(
        `update users u
            set igsid = $1
          where u.id = (
                  select c.id from users c
                   where lower(c.instagram_handle) = $2
                     and c.igsid is null
                   order by c.created_at
                   limit 1
                )
            and not exists (select 1 from users o where o.igsid = $1)
        returning u.id`,
        [igsid, usable],
      );
      boundId = claimed?.id ?? null;
    } catch (e) {
      // Lost the race at the igsid index. The read below finds the winner.
      if (!isUniqueViolation(e)) throw e;
    }
  }

  // ── 2. Everyone ──────────────────────────────────────────────────────────
  //
  // The igsid holder AND every handle claimant, in one read, deduped by the
  // primary key. Ordered so the result is stable across passes rather than
  // whatever order the planner felt like.
  const rows = await query<{ id: string }>(
    `select id from users
      where igsid = $1
         or ($2 <> '' and lower(instagram_handle) = $2)
      order by created_at`,
    [igsid, usable],
  );

  if (rows.length === 0) return [];

  if (boundId) {
    console.log(
      `[ingest] bound @${usable} to a Gaja account by claimed handle` +
        (rows.length > 1 ? `; ${rows.length} accounts claim it and all will receive the reel` : ''),
    );
  }

  return rows.map((r) => ({ userId: r.id, boundByHandle: r.id === boundId }));
}

/**
 * The first recipient, or null. Kept because the one-off scripts and the
 * verification suite are written against it, and because "did this sender
 * resolve at all" is still a fair question to ask.
 *
 * DO NOT use it in the poller. It answers with one account, and answering with
 * one account is exactly what stopped being correct.
 */
export async function resolveSenderToUser(
  igsid: string,
  senderUsername?: string | null,
): Promise<ResolvedSender | null> {
  const all = await resolveSenderToUsers(igsid, senderUsername);
  return all[0] ?? null;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === UNIQUE_VIOLATION;
}
