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
 * reserves the only saturated values for the semantic ones, so this takes the
 * `secondary` Button treatment — a tinted fill, told apart from the primary
 * action by its surface step and its label, never by a hue.
 */
import Link from 'next/link';
import { socialSignInConfigured } from '@/lib/supabase';

export function SocialSignIn({ next }: { next?: string | null }) {
  if (!socialSignInConfigured()) return null;

  const qs = next ? `?next=${encodeURIComponent(next)}` : '';

  return (
    <div className="mt-[var(--space-15)]">
      <div className="flex items-center gap-[var(--space-9)]" aria-hidden>
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-secondary" style={{ font: 'var(--type-caption)' }}>
          또는
        </span>
        <span className="h-px flex-1 bg-hairline" />
      </div>

      <Link
        href={`/api/auth/oauth/google${qs}`}
        prefetch={false}
        className="mt-[var(--space-11)] flex h-[var(--field-height)] w-full items-center
                   justify-center rounded-[var(--radius-lg)] bg-surface-2 text-ink
                   transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
        style={{ font: 'var(--type-button)' }}
      >
        Google로 계속하기
      </Link>
    </div>
  );
}
