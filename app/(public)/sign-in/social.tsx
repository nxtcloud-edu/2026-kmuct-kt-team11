/**
 * Social sign-in entry points.
 *
 * Renders nothing unless a Supabase project is configured. Until then the
 * sign-in screen is email only, which is the honest state: a button that always
 * lands on an error page is worse than no button.
 *
 * Plain links, not buttons with onClick: starting OAuth is a navigation, so a
 * link works before hydration and survives a middle-click. The server route does
 * the PKCE work.
 *
 * No brand colour or logo. `.agents/visual-language.md` allows no accent and
 * reserves the only saturated value for `danger`, so this is the same pill as
 * every other control, told apart by its label.
 */
import Link from 'next/link';
import { socialSignInConfigured } from '@/lib/supabase';

export function SocialSignIn({ next }: { next?: string | null }) {
  if (!socialSignInConfigured()) return null;

  const qs = next ? `?next=${encodeURIComponent(next)}` : '';

  return (
    <div className="mt-6">
      <div className="flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-xs text-ink-muted">또는</span>
        <span className="h-px flex-1 bg-hairline" />
      </div>

      <Link
        href={`/api/auth/oauth/google${qs}`}
        prefetch={false}
        className="mt-4 inline-flex w-full items-center justify-center rounded-pill bg-surface-1
                   px-5 py-2.5 text-base shadow-control transition-colors duration-200
                   ease-standard hover:bg-fill"
      >
        Google로 계속하기
      </Link>
    </div>
  );
}
