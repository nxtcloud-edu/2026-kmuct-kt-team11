import { cookies } from 'next/headers';
import { z } from 'zod';
import { query, tx } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import {
  SESSION_COOKIE,
  currentUser,
  issueSession,
  revokeSession,
  toMe,
  type SessionUser,
} from '@/lib/session';
import { hashToken } from '@/lib/tokens';

const Body = z.object({ token: z.string().min(1) });

type Link = { id: string; email: string; intent: string; user_id: string | null };

/**
 * The D3 dual semantics. One token type, two outcomes, and the outcome is decided by
 * whether a session is present at exchange time — not by anything in the token.
 *
 *   no session  → SIGN IN  (create the account if the email is new)
 *   session     → LINK     (attach the email to the signed-in account)
 */
export const POST = withRoute(async (req: Request) => {
  const { token } = Body.parse(await req.json());
  const signedIn = await currentUser();

  // Read before the exchange, because issueSession() below overwrites the
  // __Host- cookie in place: once it has, the row the old cookie pointed at is
  // still unexpired and still unrevoked, and nothing anywhere holds the token
  // that could revoke it. Retiring it here is the only moment it is reachable.
  const priorToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;

  const user = await tx(async (c) => {
    // Single-use is enforced by the update's WHERE clause, not by a read-then-write:
    // two concurrent exchanges of the same token must not both succeed.
    const claimed = await c.query<Link>(
      `update magic_links set used_at = now()
        where token_hash = $1 and used_at is null and expires_at > now()
        returning id, email, intent, user_id`,
      [hashToken(token)],
    );
    const link = claimed.rows[0];
    if (!link) throw new ProblemError('magic-link-invalid');

    if (signedIn) {
      const owner = await c.query<{ id: string }>(
        `select id from users where email = $1 and id <> $2`,
        [link.email, signedIn.id],
      );
      if (owner.rows.length) throw new ProblemError('email-already-linked');

      const updated = await c.query<SessionUser>(
        `update users set email = $1, email_verified_at = now(), last_active_at = now()
          where id = $2
      returning id, display_name, avatar_url, email, email_verified_at, igsid, locale,
                home_area, profile_visible_in_groups, plan, gender, age_band, mbti,
                onboarded_at`,
        [link.email, signedIn.id],
      );
      return { user: updated.rows[0], outcome: 'linked' as const };
    }

    if (link.user_id) {
      // The row this link points at was found by `select id from users where
      // email = $1` in POST /auth/magic-link, and an address in that column is
      // not evidence of anything: POST /auth/password inserts one for whatever
      // address is typed into it, with email_verified_at left null. So the row
      // may well have been parked there by someone who does not hold the
      // address, waiting for its owner to arrive by link and land inside it.
      //
      // Receiving this token proves the exchanger reads mail at that address,
      // which is the first real proof the row has ever seen — so they claim the
      // row rather than sign into it.
      await claimUnverifiedRow(c, link.user_id);

      const found = await c.query<SessionUser>(
        `update users set last_active_at = now() where id = $1
      returning id, display_name, avatar_url, email, email_verified_at, igsid, locale,
                home_area, profile_visible_in_groups, plan, gender, age_band, mbti,
                onboarded_at`,
        [link.user_id],
      );
      return { user: found.rows[0], outcome: 'signed_in' as const };
    }

    // New account. No signup form — the email in the link is the whole registration,
    // and it satisfies the CHECK constraint on its own.
    const created = await c.query<SessionUser>(
      `insert into users (display_name, email, email_verified_at)
       values ($1, $2, now())
   returning id, display_name, avatar_url, email, email_verified_at, igsid, locale,
             home_area, profile_visible_in_groups, plan, gender, age_band, mbti,
             onboarded_at`,
      [link.email.split('@')[0], link.email],
    );
    return { user: created.rows[0], outcome: 'signed_in' as const };
  });

  if (user.outcome === 'signed_in') {
    if (priorToken) {
      await query(
        `update sessions set revoked_at = now()
          where token_hash = $1 and revoked_at is null`,
        [hashToken(priorToken)],
      );
    }
    await issueSession(user.user.id);
  }
  return json({ user: toMe(user.user), outcome: user.outcome });
});

/**
 * Take the row over if it has never proven it owns its address.
 *
 * A `users` row with `email_verified_at` null has no proven owner — the address
 * got there because somebody typed it, not because anybody checked. Proving
 * ownership claims the row: verify it, and leave nothing behind that the
 * unproven party could still use.
 *
 * Which is why the password goes too, and why every live session on the row is
 * revoked. That will look like a bug to whoever reads it next: a user who signs
 * up with a password and then uses a magic link for the same address loses that
 * password and has to set a new one, having done nothing wrong. It is the
 * correct trade while the address is unverified. "The same person verifying
 * themselves" and "the real owner reclaiming a squatted row" write byte-identical
 * rows — there is nothing in the database that tells them apart — so we choose
 * the reading that costs an honest user a password reset over the one that
 * leaves an attacker a working password and an un-revoked cookie inside the
 * account its owner has just claimed.
 *
 * lib/social-identity.ts runs these same two statements when a provider-verified
 * email matches an existing row. The two must stay in step.
 */
async function claimUnverifiedRow(c: import('pg').PoolClient, userId: string): Promise<void> {
  const claimed = await c.query<{ id: string }>(
    `update users
        set email_verified_at = now(), password_hash = null, password_set_at = null
      where id = $1 and email_verified_at is null
  returning id`,
    [userId],
  );
  if (!claimed.rows[0]) return;

  await c.query(
    `update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`,
    [userId],
  );
}

export const DELETE = withRoute(async () => {
  await revokeSession();
  return new Response(null, { status: 204 }) as never;
});
