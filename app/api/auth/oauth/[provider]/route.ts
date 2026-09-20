import { NextResponse } from 'next/server';
import { isSocialProvider, supabaseAuthClient } from '@/lib/supabase';

/**
 * Starts the OAuth flow. A browser navigation, so every outcome is a redirect
 * rather than a problem document — nobody reads JSON here.
 *
 * `skipBrowserRedirect` makes the SDK hand back the provider URL instead of
 * trying to navigate, which is what lets this run on the server. The PKCE
 * verifier is written to a cookie as a side effect; the callback needs it.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const url = new URL(req.url);
  const next = url.searchParams.get('next');
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? url.origin;

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/sign-in?error=${reason}`, origin));

  if (!isSocialProvider(provider)) return fail('unsupported_provider');

  // Only same-origin paths survive. An absolute URL here would make the
  // callback an open redirect that launders through a trusted domain.
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/saved-places';
  const callback = new URL('/api/auth/oauth/callback', origin);
  callback.searchParams.set('next', safeNext);

  try {
    const supabase = await supabaseAuthClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: callback.toString(),
        skipBrowserRedirect: true,
        // Kakao returns an email only when the scope is granted, and an account
        // with no email cannot satisfy users_recovery_channel_required.
        ...(provider === 'kakao' ? { scopes: 'account_email profile_nickname' } : {}),
      },
    });
    if (error || !data?.url) return fail('oauth_start_failed');
    return NextResponse.redirect(data.url);
  } catch {
    return fail('oauth_unavailable');
  }
}
