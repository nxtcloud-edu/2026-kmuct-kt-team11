import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Supabase client for the OAuth handshake, and for nothing else.
 *
 * Gaja uses Supabase Auth purely as an identity provider: it proves the person
 * controls a Google or Kakao account, and then `lib/session.ts` issues the
 * session Gaja actually runs on. No Supabase session survives the callback, and
 * no table is ever read through this client — `lib/db.ts` remains the only way
 * to Postgres.
 *
 * The env vars are deliberately NOT `NEXT_PUBLIC_`. Nothing in the browser
 * talks to Supabase, so publishing them to the bundle would widen the surface
 * for no gain.
 *
 * `setAll` is required, not optional: the PKCE code verifier is written as a
 * cookie when the flow starts and read back when the code is exchanged. Without
 * it the exchange fails with an opaque error.
 */
export async function supabaseAuthClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_ANON_KEY are required for social sign-in. See .env.example.',
    );
  }

  const jar = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) jar.set(name, value, options);
        } catch {
          // Called from a Server Component rather than a route handler. Harmless
          // here: every Supabase cookie this app writes is written from a route.
        }
      },
    },
  });
}

/**
 * Only Google. The auth_identities CHECK still permits 'kakao' and 'apple', so
 * adding one later is a change here and in the sign-in UI — no migration.
 */
export const SOCIAL_PROVIDERS = ['google'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export function isSocialProvider(v: string): v is SocialProvider {
  return (SOCIAL_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Whether social sign-in is usable at all. The sign-in screen hides the buttons
 * when this is false, so an unconfigured deployment shows email only rather than
 * offering a route that dead-ends in an error.
 */
export function socialSignInConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}
