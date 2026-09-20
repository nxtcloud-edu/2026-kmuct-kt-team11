import { NextResponse } from 'next/server';
import { ProblemError } from '@/lib/problem';
import { issueSession } from '@/lib/session';
import { resolveSocialIdentity, type VerifiedIdentity } from '@/lib/social-identity';
import { isSocialProvider, supabaseAuthClient } from '@/lib/supabase';

/**
 * Where the provider sends the browser back. Exchanges the code for a Supabase
 * session, reads the verified identity out of it, resolves it to a Gaja user,
 * and then issues Gaja's own session.
 *
 * The Supabase session is signed out before returning on purpose. Two competing
 * sessions is the failure mode where signing out of one leaves the other live;
 * `__Host-gaja_session` stays the single source of truth, which is also what
 * keeps `requireSession()` and the 40-case suite meaningful.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? url.origin;
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/saved-places';

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/sign-in?error=${reason}`, origin));

  // The provider can decline before we ever see a code.
  if (url.searchParams.get('error') || !code) return fail('oauth_denied');

  try {
    const supabase = await supabaseAuthClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data?.user) return fail('oauth_failed');

    const u = data.user;
    const provider = u.app_metadata?.provider ?? '';
    if (!isSocialProvider(provider)) return fail('unsupported_provider');

    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : null);

    const identity: VerifiedIdentity = {
      provider,
      // The provider's own subject id where present, falling back to Supabase's
      // user id. Never the email: addresses get reassigned, subjects do not.
      providerUid: u.identities?.[0]?.id ?? u.id,
      email: u.email ?? null,
      // Supabase normalises this; Kakao omits the claim when the scope is denied.
      emailVerified: meta.email_verified === true || u.email_confirmed_at != null,
      displayName: str('full_name') ?? str('name') ?? str('nickname'),
      avatarUrl: str('avatar_url') ?? str('picture'),
    };

    const user = await resolveSocialIdentity(identity);

    // Drop the Supabase session before minting ours.
    await supabase.auth.signOut();
    await issueSession(user.id);

    return NextResponse.redirect(new URL(safeNext, origin));
  } catch (e) {
    if (e instanceof ProblemError && e.code === 'oauth-email-required') {
      return fail('email_required');
    }
    console.error('[oauth:callback]', e);
    return fail('oauth_failed');
  }
}
