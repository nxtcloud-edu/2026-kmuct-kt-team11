import { cookies } from 'next/headers';
import { queryOne } from './db';
import { hashToken, newToken, SESSION_TTL_DAYS } from './tokens';
import { ProblemError } from './problem';

export const SESSION_COOKIE = '__Host-gaja_session';

/** Mirrors the CHECK constraint in 20260920000003. Both sides must move together. */
export type Gender = 'female' | 'male' | 'undisclosed';
export type AgeBand = '10s' | '20s' | '30s' | '40s' | '50plus';

export type SessionUser = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
  email_verified_at: Date | null;
  igsid: string | null;
  locale: 'ko' | 'en';
  home_area: string | null;
  profile_visible_in_groups: boolean;
  plan: string;
  // Every onboarding answer is optional, so all four are nullable. `mbti` stays a
  // plain string rather than a 16-member union: the CHECK constraint is the
  // authority on the shape, and a union here would only be a second place to
  // maintain the same 16 values.
  gender: Gender | null;
  age_band: AgeBand | null;
  mbti: string | null;
  onboarded_at: Date | null;
};

/** The signed-in user, or null. Never throws — callers decide whether absence is an error. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  return queryOne<SessionUser>(
    `select u.id, u.display_name, u.avatar_url, u.email, u.email_verified_at,
            u.igsid, u.locale, u.home_area, u.profile_visible_in_groups, u.plan,
            u.gender, u.age_band, u.mbti, u.onboarded_at
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()`,
    [hashToken(raw)],
  );
}

/** The signed-in user, or a 401. Use in every route that requires a session. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new ProblemError('unauthenticated');
  return user;
}

export async function issueSession(userId: string): Promise<void> {
  const { token, hash } = newToken('ses');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 864e5);
  await queryOne(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3) returning id`,
    [hash, userId, expires],
  );
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,       // __Host- prefix requires it; localhost is exempt in modern browsers
    sameSite: 'lax',
    path: '/',
    expires,
  });
}

/** Revokes server-side as well as clearing the cookie — a forgotten cookie is not a sign-out. */
export async function revokeSession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (raw) {
    await queryOne(`update sessions set revoked_at = now() where token_hash = $1 returning id`, [
      hashToken(raw),
    ]);
  }
  jar.delete(SESSION_COOKIE);
}

/** The `Me` schema from openapi.yaml. `igsid` is never exposed. */
export function toMe(u: SessionUser) {
  const channels: string[] = [];
  if (u.igsid) channels.push('instagram');
  if (u.email) channels.push('email');
  return {
    id: u.id,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    email: u.email,
    email_verified: u.email_verified_at !== null,
    instagram_linked: u.igsid !== null,
    locale: u.locale,
    home_area: u.home_area,
    profile_visible_in_groups: u.profile_visible_in_groups,
    plan: u.plan,
    gender: u.gender,
    age_band: u.age_band,
    mbti: u.mbti,
    // The wire field is a boolean and deliberately not the timestamp: the client
    // only ever asks "do I still owe this person the onboarding flow?", and
    // handing it a date invites a comparison that has no right answer.
    onboarded: u.onboarded_at !== null,
    recovery_channels: channels,
  };
}
