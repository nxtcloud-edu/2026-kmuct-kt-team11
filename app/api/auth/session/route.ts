import { z } from 'zod';
import { tx } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { currentUser, issueSession, revokeSession, toMe, type SessionUser } from '@/lib/session';
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
                home_area, profile_visible_in_groups, plan`,
        [link.email, signedIn.id],
      );
      return { user: updated.rows[0], outcome: 'linked' as const };
    }

    if (link.user_id) {
      const found = await c.query<SessionUser>(
        `update users set last_active_at = now() where id = $1
      returning id, display_name, avatar_url, email, email_verified_at, igsid, locale,
                home_area, profile_visible_in_groups, plan`,
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
             home_area, profile_visible_in_groups, plan`,
      [link.email.split('@')[0], link.email],
    );
    return { user: created.rows[0], outcome: 'signed_in' as const };
  });

  if (user.outcome === 'signed_in') await issueSession(user.user.id);
  return json({ user: toMe(user.user), outcome: user.outcome });
});

export const DELETE = withRoute(async () => {
  await revokeSession();
  return new Response(null, { status: 204 }) as never;
});
