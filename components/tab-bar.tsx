'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from './icons';

/**
 * The signed-in chrome: four tabs in a floating pill, and nothing else.
 *
 * Tab switches are instant because the bar renders inside the animating
 * subtree, so giving tab routes a transition would slide the bar itself; the
 * source system sets --dur-tab to 0ms for exactly that reason.
 *
 * The bar is one of only three elevated things in this system, so it spends
 * `--shadow-float` and every other surface stays flat. Because it is fixed, the
 * bottom padding on `Content` already reserves its height plus its offset —
 * individual pages must not add a margin of their own.
 *
 * Being fixed, it is centred on the viewport — the same centring the phone
 * canvas uses — at the canvas width minus two gutters, so it sits inset by
 * exactly one gutter inside the frame. It mirrors the canvas's own 480px
 * breakpoint: below that the frame is dropped and fills the viewport, so the bar
 * has to widen with it or the gutters would stop matching the content's.
 *
 * There are no icons in this project, so the Korean labels stand alone. This is
 * a Client Component only because the active tab needs `usePathname`; no session
 * data crosses into client-side state.
 */

const TABS: { href: string; label: string; icon: IconName }[] = [
  { href: '/home', label: '홈', icon: 'home' },
  { href: '/saved-places', label: '저장한 곳', icon: 'saved' },
  { href: '/groups', label: '그룹', icon: 'groups' },
  { href: '/account', label: '계정', icon: 'account' },
];

export function TabBarShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      <main className="flex-1">{children}</main>

      <nav
        aria-label="주요 메뉴"
        className="fixed bottom-[var(--tab-bar-bottom)] left-1/2 z-20 flex
                   h-[var(--tab-bar-height)] w-[calc(var(--canvas-width)-var(--gutter)*2)]
                   -translate-x-1/2 items-stretch rounded-[var(--radius-3xl)]
                   bg-canvas shadow-float
                   max-[479px]:w-[calc(100vw-var(--gutter)*2)]"
      >
        {TABS.map(({ href, label, icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={
                'flex min-h-[var(--tap-min)] flex-1 flex-col items-center justify-center gap-[var(--space-2)] ' +
                'rounded-[var(--radius-3xl)] transition-opacity duration-200 ' +
                'active:opacity-[var(--press-opacity)] ' +
                (active ? 'text-ink' : 'text-inactive')
              }
              style={{ font: 'var(--type-tab)', letterSpacing: 'var(--tab-ls)' }}
            >
              {/* The filled silhouette is the whole selection signal — this bar
                  has no accent colour to spend on one. */}
              <Icon name={icon} filled={active} size={22} />
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
