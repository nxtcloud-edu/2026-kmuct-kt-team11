import { queryOne } from '../db';

/**
 * Which Gaja account a shared reel belongs to.
 *
 * `igsid` is the Instagram-Scoped User ID off a webhook payload Meta signed, and
 * it is the only column here that proves anything. `users.instagram_handle` is a
 * string somebody typed into onboarding — see 20260920000006 and
 * docs/gaja/instagram-binding.md — so it is deliberately absent from this query.
 * Routing a DM by handle would be the `users.email` defect again with a worse
 * payoff: the attacker would not be parking a row and waiting for a victim, they
 * would be receiving the victim's shared reels. A handle may narrow a lookup when
 * a human is later asked to confirm a binding; it may never answer this question.
 *
 * UNRECOGNISED SENDER: THE REEL IS DROPPED. docs/gaja/instagram-binding.md leaves
 * the choice between drop-and-reply and park-the-payload open, and requires
 * whoever implements ingestion to pick one explicitly rather than let the easier
 * insert decide. This picks DROP: holding the payload means storing captions and
 * media from a person with no Gaja account and no way to ask them about it, which
 * is a retention question we have not answered. Returning null is how that choice
 * is enforced — there is no branch in this module that writes anything, so a
 * caller cannot accidentally save an unrouted reel; the worst it can do is fail
 * to drop one.
 */
export async function resolveSenderToUser(igsid: string): Promise<{ userId: string } | null> {
  // `queryOne<T>` is an unchecked assertion, not a validated cast: a column named
  // in the type and missing from this select list is `undefined` at runtime with
  // nothing from tsc. That is the bug lib/social-identity.ts shipped once. One
  // column, selected, spelled the same.
  const row = await queryOne<{ id: string }>(`select id from users where igsid = $1`, [igsid]);
  return row ? { userId: row.id } : null;
}
