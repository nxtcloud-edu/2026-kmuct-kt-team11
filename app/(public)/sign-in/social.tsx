/**
 * Social sign-in entry points.
 *
 * Plain links, not buttons with onClick: starting OAuth is a navigation, and a
 * link works before hydration, survives a middle-click, and needs no JS. The
 * server route does the PKCE work.
 *
 * Kakao first. This is a Seoul product and Kakao is how most Korean users expect
 * to sign in; Google is the fallback for everyone else. The order is the
 * recommendation — the first item in a short list is the one people take.
 *
 * Neither gets a brand colour. `.agents/visual-language.md` allows no accent and
 * reserves the only saturated value for `danger`, so these read as the same
 * pill as every other control and are told apart by their label.
 */
import Link from 'next/link';

const PROVIDERS = [
  { id: 'kakao', label: '카카오로 계속하기' },
  { id: 'google', label: 'Google로 계속하기' },
] as const;

export function SocialSignIn({ next }: { next?: string | null }) {
  const qs = next ? `?next=${encodeURIComponent(next)}` : '';

  return (
    <div className="mt-6">
      <div className="flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-xs text-ink-muted">또는</span>
        <span className="h-px flex-1 bg-hairline" />
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {PROVIDERS.map((p) => (
          <Link
            key={p.id}
            href={`/api/auth/oauth/${p.id}${qs}`}
            prefetch={false}
            className="inline-flex items-center justify-center rounded-pill bg-surface-1 px-5 py-2.5
                       text-base shadow-control transition-colors duration-200 ease-standard
                       hover:bg-fill"
          >
            {p.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
