import { tx } from './db';
import { ProblemError } from './problem';
import type { SessionUser } from './session';
import type { SocialProvider } from './supabase';

const USER_COLUMNS = `id, display_name, avatar_url, email, email_verified_at, igsid, locale,
                      home_area, profile_visible_in_groups, plan`;

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
 *      an existing account — link it. Matching on a verified address is safe in
 *      both directions: Google and Kakao only assert an address they control,
 *      and Gaja only stores `email` after its own magic-link round trip. Matching
 *      on an unverified address would be account takeover, which is why
 *      `emailVerified` is checked and not assumed.
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
      const existing = await c.query<SessionUser>(
        `update users set last_active_at = now() where email = $1
      returning ${USER_COLUMNS}`,
        [id.email.toLowerCase()],
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
