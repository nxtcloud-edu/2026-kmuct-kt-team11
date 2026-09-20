import { tx } from './db';
import { ProblemError } from './problem';
import type { SessionUser } from './session';
import type { SocialProvider } from './supabase';

// Must stay in step with the SELECT in lib/session.ts. `c.query<SessionUser>` is
// an unchecked assertion, so a column missing here produces a SessionUser with
// undefined keys that tsc will not flag — and the onboarding gate reads
// onboarded_at off exactly this object.
const USER_COLUMNS = `id, display_name, avatar_url, email, email_verified_at, igsid, locale,
                      home_area, profile_visible_in_groups, plan,
                      gender, age_band, mbti, onboarded_at`;

export type VerifiedIdentity = {
  provider: SocialProvider;
  /** The provider's stable subject id. Never the email — emails change hands. */
  providerUid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
};

/**
 * Resolve a verified social identity to a Gaja user, creating one if needed.
 *
 * Three cases, in order:
 *
 *   1. The identity is already linked — sign that user in. This is the common
 *      path and it never consults the email, so a user who changes their Google
 *      address still lands on the same account.
 *
 *   2. The identity is new but the provider asserts a *verified* email matching
 *      an existing account — link it. Only a verified assertion earns the match:
 *      Google and Kakao assert an address only when they control it, and
 *      matching on an unverified one would be account takeover, which is why
 *      `emailVerified` is checked and not assumed.
 *
 *      Our own `users.email` proves nothing in return. `POST /auth/password`
 *      writes an address with `email_verified_at` left null, and nobody checked
 *      that whoever typed it owns it — so a match against an unverified row is a
 *      *claim* on an unowned row, not a link. See claimUnverifiedRow.
 *
 *   3. Otherwise create an account.
 *
 * All three run in one transaction: two browser tabs finishing the same OAuth
 * flow must not produce two users.
 */
export async function resolveSocialIdentity(id: VerifiedIdentity): Promise<SessionUser> {
  return tx(async (c) => {
    // 1 — already linked.
    const linked = await c.query<SessionUser>(
      `update users set last_active_at = now()
        where id = (select user_id from auth_identities
                     where provider = $1 and provider_uid = $2)
    returning ${USER_COLUMNS}`,
      [id.provider, id.providerUid],
    );
    if (linked.rows[0]) {
      await c.query(
        `update auth_identities set last_used_at = now(), email = coalesce($3, email)
          where provider = $1 and provider_uid = $2`,
        [id.provider, id.providerUid, id.email],
      );
      return linked.rows[0];
    }

    // 2 — new identity, verified email we already know.
    if (id.email && id.emailVerified) {
      const email = id.email.toLowerCase();
      await claimUnverifiedRow(c, email);

      const existing = await c.query<SessionUser>(
        `update users set last_active_at = now() where email = $1
      returning ${USER_COLUMNS}`,
        [email],
      );
      if (existing.rows[0]) {
        await link(c, id, existing.rows[0].id);
        return existing.rows[0];
      }
    }

    // 3 — new account. `users_recovery_channel_required` means an account needs
    // a way back in, and a social identity is not one: unlinking the provider or
    // losing that account would strand the user with nothing. Kakao can withhold
    // the email scope, so this is a real path, not a theoretical one.
    if (!id.email || !id.emailVerified) throw new ProblemError('oauth-email-required');

    const created = await c.query<SessionUser>(
      `insert into users (display_name, email, email_verified_at, avatar_url)
       values ($1, $2, now(), $3)
   returning ${USER_COLUMNS}`,
      [id.displayName?.trim() || id.email.split('@')[0], id.email.toLowerCase(), id.avatarUrl],
    );
    await link(c, id, created.rows[0].id);
    return created.rows[0];
  });
}

/**
 * Take over the row holding `email` if it has never proven it owns that address.
 *
 * A row with `email_verified_at` null has no proven owner: `POST /auth/password`
 * will insert one for any address at all, including yours, and the only thing
 * that happened is that somebody typed it. Presenting a provider-verified
 * identity for that address is the first actual proof, so the presenter claims
 * the row instead of walking into whatever the typist left in it.
 *
 * The claim empties the password and kills every live session on the row. That
 * will read as a bug to whoever finds it next — a user who signs up with a
 * password and then signs in with Google loses the password they just set and
 * has to set a new one. It is deliberate. While the address is unverified we
 * cannot tell that person apart from a squatter being evicted by the real
 * owner: both write the identical row, and the row is all we have. So we take
 * the reading that costs an honest user one password reset over the reading
 * that leaves an attacker a working password and a live cookie inside the
 * account its owner just claimed.
 *
 * The magic-link exchange in app/api/auth/session/route.ts runs these same two
 * statements against `users.id`. The two must stay in step.
 */
async function claimUnverifiedRow(c: import('pg').PoolClient, email: string): Promise<void> {
  const claimed = await c.query<{ id: string }>(
    `update users
        set email_verified_at = now(), password_hash = null, password_set_at = null
      where email = $1 and email_verified_at is null
  returning id`,
    [email],
  );
  if (!claimed.rows[0]) return;

  await c.query(
    `update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`,
    [claimed.rows[0].id],
  );
}

async function link(
  c: import('pg').PoolClient,
  id: VerifiedIdentity,
  userId: string,
): Promise<void> {
  await c.query(
    `insert into auth_identities (provider, provider_uid, user_id, email, last_used_at)
     values ($1, $2, $3, $4, now())
     on conflict (user_id, provider) do update
        set provider_uid = excluded.provider_uid,
            email        = excluded.email,
            last_used_at = now()`,
    [id.provider, id.providerUid, userId, id.email],
  );
}
