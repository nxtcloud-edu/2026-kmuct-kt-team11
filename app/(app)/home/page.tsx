import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, Content } from '@/components/surface';
import { requireSession } from '@/lib/require-session';
import { listPlacesNearby, listSavedPlacesForUser } from '@/lib/saved-places';
import type { SavedPlace } from '@/lib/api/types';

export const metadata: Metadata = { title: '홈' };

/**
 * Home.
 *
 * Every section is hidden entirely — heading included — when it has no data.
 * That is the adopted system's strongest content rule and it is load-bearing
 * here rather than decorative: there is no recommendation engine yet, so the
 * MBTI section does not render at all. Day one this screen is honestly the
 * saved places and whatever is near you, and that is the correct output of the
 * rule, not a gap.
 *
 * `requireSession()`, not `requireUser()`: this is a Server Component, and a
 * page's guard runs concurrently with the layout's. See lib/require-session.ts.
 */
export default async function HomePage() {
  const user = await requireSession();

  const [saved, nearby] = await Promise.all([
    listSavedPlacesForUser(user.id, 10),
    // No home area means no "near you" section to fill — do not ask the
    // database a question whose answer cannot be shown.
    user.home_area ? listPlacesNearby(user.home_area, user.id) : Promise.resolve([]),
  ]);

  const nothing = saved.length === 0 && nearby.length === 0;

  return (
    <Content>
      <header>
        <h1 style={{ font: 'var(--type-tab-header)', letterSpacing: 'var(--tab-header-ls)' }}>
          {user.display_name}님
        </h1>
        <p className="mt-1 text-secondary" style={{ font: 'var(--type-meta)' }}>
          오늘 어디 갈까요?
        </p>
      </header>

      {/* Nothing to show is one line, not a designed screen. An illustration or
          a CTA here would be treating the empty state as the fix; the fix is
          saving from Instagram, and that is slice 3. */}
      {nothing ? (
        <p className="mt-[var(--section-gap)] text-secondary" style={{ font: 'var(--type-body)' }}>
          아직 저장한 곳이 없어요
        </p>
      ) : null}

      <Section title="저장한 곳" href="/saved-places" empty={saved.length === 0}>
        <ul className="flex list-none gap-[var(--rail-gap)] overflow-x-auto p-0">
          {saved.map((s) => (
            <SavedRailItem key={s.id} saved={s} />
          ))}
        </ul>
      </Section>

      {/* Always empty, so this never renders — and that is the point. Matching a
          place to an MBTI type needs a recommendation source, and there is none:
          the pipeline that would supply one is slice 2's. Fabricating rows to
          fill the shelf would make the screen lie about what the product knows,
          so the section stays out of the document until the data exists. */}
      <Section title={`${user.mbti ?? ''}에게 어울리는 곳`} empty={true}>
        {null}
      </Section>

      <Section title={`${user.home_area ?? ''} 근처`} empty={nearby.length === 0}>
        <ul className="flex list-none flex-col gap-[var(--space-7)] p-0">
          {nearby.map((p) => (
            <Card as="li" key={p.id} className="p-4">
              <p style={{ font: 'var(--type-card-title)' }}>{p.name}</p>
              <p className="mt-0.5 text-secondary" style={{ font: 'var(--type-caption)' }}>
                {CATEGORY_KO[p.category] ?? p.area}
              </p>
            </Card>
          ))}
        </ul>
      </Section>
    </Content>
  );
}

/**
 * The content rule, in code. `empty` is the caller's answer to "is there data
 * behind this?", and a true answer removes the heading along with the body —
 * that guard IS the whole rule, and there is deliberately no empty-state branch
 * for it to fall through to.
 */
function Section({
  title,
  href,
  children,
  empty,
}: {
  title: string;
  href?: string;
  empty: boolean;
  children: ReactNode;
}) {
  if (empty) return null; // heading included — this is the whole rule

  return (
    <section className="mt-[var(--section-gap)]">
      <div className="flex items-baseline justify-between">
        <h2 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>{title}</h2>
        {/* `›` is a text node, not an icon: it is part of the label's typography
            and inherits its size and colour for free. */}
        {href ? (
          <Link href={href} className="text-secondary" style={{ font: 'var(--type-meta)' }}>
            더보기 ›
          </Link>
        ) : null}
      </div>
      <div className="mt-[var(--space-9)]">{children}</div>
    </section>
  );
}

/**
 * There is no photography in the product yet, so the thumbnail is an empty
 * tinted square and stays one. A placeholder image or a glyph would be
 * inventing content the row does not have.
 */
function SavedRailItem({ saved }: { saved: SavedPlace }) {
  const { place } = saved;

  return (
    <li className="w-[132px] shrink-0">
      <div aria-hidden className="aspect-square w-full rounded-[var(--radius-photo)] bg-surface-2" />
      {/* `place` is null while status is 'pending' — slice 3's extractor can
          produce a saved row before it has resolved to a real venue. */}
      <p className="mt-[var(--space-7)] truncate" style={{ font: 'var(--type-card-title)' }}>
        {place?.name ?? '장소를 확인하는 중이에요'}
      </p>
      {place?.area ? (
        <p className="mt-0.5 truncate text-secondary" style={{ font: 'var(--type-caption)' }}>
          {place.area}
        </p>
      ) : null}
    </li>
  );
}

/**
 * `places.category` is an English enum in the database (the CHECK constraint is
 * the authority) and every word a user reads is Korean, so the labels are
 * translated at the point of display. This lives here rather than in a shared
 * module because home is the only screen that renders a bare category today.
 */
const CATEGORY_KO: Record<string, string> = {
  cafe: '카페',
  restaurant: '음식점',
  exhibition: '전시',
  shop: '가게',
  activity: '체험',
};
