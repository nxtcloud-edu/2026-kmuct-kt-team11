'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The signed-in chrome. Quiet by contract: a hairline, a wordmark and three
 * links. `.agents/visual-language.md` spends its whole depth budget on content
 * cards, so the header gets a 1px rule and no shadow.
 *
 * Order is deliberate. 저장한 곳 is first because it is where nearly every
 * session is going, and 계정 is last; the serial position effect makes the ends
 * of a short list the two positions people actually remember.
 *
 * This is a Client Component only because the active link needs `usePathname`.
 * The user's name is passed in as a prop from the server layout rather than
 * fetched here, so no session data crosses into client-side state.
 */

const NAV = [
  { href: '/saved-places', label: '저장한 곳' },
  { href: '/groups', label: '그룹' },
  { href: '/account', label: '계정' },
] as const;

export function AppShell({
  displayName,
  children,
}: {
  displayName: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-hairline bg-canvas/80 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[960px] items-center gap-6 px-4 py-3">
          <Link href="/saved-places" className="text-base font-medium tracking-tight">
            Gaja
          </Link>

          <nav aria-label="주요 메뉴" className="flex items-center gap-1">
            {NAV.map(({ href, label }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={
                    'rounded-pill px-3 py-1.5 text-sm transition-colors duration-200 ease-standard ' +
                    (active ? 'bg-fill text-ink' : 'text-ink-muted hover:text-ink')
                  }
                >
                  {label}
                </Link>
              );
            })}
          </nav>

          {/* Not a link: the account page is already in the nav, and a second
              route to it would be two affordances for one destination. */}
          <span className="ml-auto truncate text-sm text-ink-muted" title={displayName}>
            {displayName}
          </span>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
