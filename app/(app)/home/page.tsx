import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Content } from '@/components/surface';
import { PlaceDeck } from './deck';
import { HomeEvents } from './events';
import { IngestStatusCard } from './ingest-status';
import { NearbyMap } from './nearby-map';
import type { FeedEvent } from '@/lib/api/types';
import { listFeedEvents } from '@/lib/events/store';
import { seoulToday } from '@/lib/events/today';
import { EVENT_CATEGORY_ORDER } from '@/lib/events/types';
import { readIngestStatus } from '@/lib/ingest/status';
import { requireSession } from '@/lib/require-session';
import { listPlacesNearby, listSavedPlacesForUser } from '@/lib/saved-places';

export const metadata: Metadata = { title: '홈' };

/**
 * HOW MANY EVENTS HOME SHOWS BEFORE THE TAB TAKES OVER.
 *
 * Three. The 이벤트 tab is the list; this is the taste, and the section carries a
 * 더보기 link to say so. Three full-width cards run to roughly 380px — enough to
 * read as the substance of a cold-start screen, not enough to out-mass the deck
 * on a populated one.
 */
const HOME_EVENT_COUNT = 3;

/**
 * Home.
 *
 * Every section is hidden entirely — heading included — when it has no data.
 * That is the adopted system's strongest content rule and it is load-bearing
 * here rather than decorative: there is no recommendation engine yet, so the
 * MBTI section does not render at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDER, AND WHY THE EVENTS SECTION SITS WHERE IT DOES.
 *
 *   deck → 지금 하는 이벤트 → 근처
 *
 * The deck is FIRST because it is what the user saved. Home's question is
 * "오늘 어디 가볼까요" and the answer the product promised is the set of places
 * they already chose; an offer of things they have never seen must not be shown
 * before the things they kept.
 *
 * Events are SECOND, above 근처, and not below it. 근처 is a refinement of the
 * deck — the same saved set, sliced by distance — so it belongs with it at the
 * end. Events are the only content on this screen that changes without the user
 * doing anything, and burying the one weekly-changing section under a map is how
 * it becomes furniture nobody scrolls to. On a 430px canvas the heading lands
 * around 540px with the deck above it, which is on screen.
 *
 * Serial position effect: the middle of a list is the least-remembered slot, and
 * that is the correct price for a supplementary section on a repeat visit. On
 * the cold-start screen the deck renders nothing at all, so the same DOM
 * position makes events both first and last — the whole screen — without a
 * second layout to maintain.
 *
 * THE COLD START. With no saved places the screen used to end at one line,
 * `아직 저장한 곳이 없어요`, which is a true sentence and a dead end. The line now
 * says what to do with the cards underneath it, and the cards can be saved, so
 * the screen has an action that fills the deck it is apologising for.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `requireSession()`, not `requireUser()`: this is a Server Component, and a
 * page's guard runs concurrently with the layout's. See lib/require-session.ts.
 */
export default async function HomePage() {
  const user = await requireSession();

  // Computed once, on the server, and passed down as a string — a client
  // component deriving it from `new Date()` renders one thing on the server and
  // possibly another in the browser. Shared with the events tab so the two
  // cannot disagree about whether a run has ended. See lib/events/today.ts.
  const today = seoulToday();

  const [saved, nearby, ingest, events] = await Promise.all([
    // The deck is the whole set, not a preview — it is the screen's main act.
    listSavedPlacesForUser(user.id, 30),
    // No home area means no "near you" section to fill — do not ask the
    // database a question whose answer cannot be shown.
    user.home_area ? listPlacesNearby(user.home_area, user.id) : Promise.resolve([]),
    // Read on the SERVER so the card is right in the first paint. The client
    // component polls from there; without this seed a reel that was already
    // being analysed would go unmentioned until the first poll came back, which
    // is the one moment the acknowledgement actually matters.
    readIngestStatus(user.id),
    // THE SAME READ THE TAB MAKES, not a second query written for this screen.
    // It already returns every live listing with this reader's `saved` resolved
    // per row, and thirty rows is not worth a bespoke `limit 3` that would have
    // to re-derive the category spread below anyway.
    listFeedEvents(user.id),
  ]);

  // Picked on the SERVER, so three events cross the wire instead of thirty.
  const homeEvents = pickHomeEvents(events, today, HOME_EVENT_COUNT);

  return (
    <Content>
      <header>
        <span
          className="inline-flex items-center rounded-[var(--radius-sm)] bg-surface-1 px-[var(--space-7)] py-[var(--space-3)] text-secondary"
          style={{ font: 'var(--type-tag)', letterSpacing: 'var(--tag-ls)' }}
        >
          내 장소
        </span>

        {/* A question, not a greeting. A saved place is a decision the user
            deferred, and the screen's job is to put one back in front of them. */}
        <h1
          className="mt-[var(--space-11)]"
          style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}
        >
          {user.display_name}님 오늘 어디 가볼까요?
        </h1>
      </header>

      {/* A shared reel, acknowledged. Renders NOTHING unless something is in
          flight or has just landed — see ingest-status.tsx. It sits above the
          deck because it is about a place that is not in the deck yet, and
          because the thing the user is looking for after sharing a reel is
          confirmation that it arrived. */}
      <IngestStatusCard initial={ingest} />

      {/* Still one line rather than a designed empty screen — but no longer a
          dead end, because the events section below it is now the thing to do.
          The second half is written only when there is actually something down
          there: pointing a new user at an empty feed is worse than saying
          nothing, and the weekly scrape can legitimately have nothing to show. */}
      {saved.length === 0 ? (
        <p className="mt-[var(--section-gap)] text-secondary" style={{ font: 'var(--type-body)' }}>
          {homeEvents.length > 0
            ? '아직 저장한 곳이 없어요. 마음에 드는 이벤트를 저장하면 여기에 담겨요.'
            : '아직 저장한 곳이 없어요'}
        </p>
      ) : null}

      <PlaceDeck places={saved} />

      {/* `지금 하는` is a claim the pick below actually enforces — anything whose
          run has closed is dropped, so nothing here is a finished show dressed
          up as somewhere to go. `더보기` carries the other twenty-seven; home
          does not try to be the feed. */}
      <Section title="지금 하는 이벤트" href="/events" empty={homeEvents.length === 0}>
        <HomeEvents events={homeEvents} today={today} />
      </Section>

      {/* Always empty, so this never renders — and that is the point. Matching a
          place to an MBTI type needs a recommendation source, and there is none:
          the pipeline that would supply one is slice 2's. Fabricating rows to
          fill the shelf would make the screen lie about what the product knows,
          so the section stays out of the document until the data exists. */}
      <Section title={`${user.mbti ?? ''}에게 어울리는 곳`} empty={true}>
        {null}
      </Section>

      {/* A map, not a list: "near you" is a question about distance, and the
          names alone cannot answer it. `NearbyMap` falls back to the list when
          no Maps key is configured, so a fresh clone still gets this section. */}
      <Section title={`${user.home_area ?? ''} 근처`} empty={nearby.length === 0}>
        <NearbyMap places={nearby} />
      </Section>
    </Content>
  );
}

/**
 * Which three of the thirty home shows.
 *
 * ONE PER CATEGORY, ROUND-ROBIN, NOT THE FIRST THREE ROWS. `listFeedEvents`
 * returns `order by category, rank, first_seen_at` and each category holds five,
 * so `slice(0, 3)` would hand home three 팝업 — and a reader would learn that the
 * 이벤트 tab is a popup feed. Taking rank 0 from 팝업, then 전시, then 뮤지컬 spends
 * the same three slots saying what the tab actually contains. The order is
 * `EVENT_CATEGORY_ORDER`, which is already sequenced by familiarity for exactly
 * this reason, so the strongest category still leads.
 *
 * The round-robin continues past the first pass rather than stopping, so a week
 * where four categories came back empty still fills three slots from the two
 * that did not.
 *
 * THE LIVE FILTER IS APPLIED AGAIN HERE, against the same `today` the cards
 * render with. `listFeedEvents` already excludes ended runs, but it does so with
 * Postgres's `current_date` — which is the database session's date, not Seoul's.
 * Where those two disagree (a UTC database, any time before 09:00 KST) a run
 * that closed yesterday is still selected by the query, and `runStatus` would
 * then put `종료` on a card home is presenting as somewhere to go. Filtering with
 * the string the card is about to be formatted against makes the section's
 * heading — `지금 하는 이벤트` — true by construction rather than by trusting two
 * clocks to agree.
 */
function pickHomeEvents(events: FeedEvent[], today: string, limit: number): FeedEvent[] {
  // A null close date is "no known end", never "ended" — some listings are
  // permanent venues and some have simply not announced a closing date.
  const live = events.filter((e) => e.closes_on === null || e.closes_on >= today);

  const byCategory = new Map<string, FeedEvent[]>();
  for (const event of live) {
    const held = byCategory.get(event.category);
    if (held) held.push(event);
    else byCategory.set(event.category, [event]);
  }

  const picked: FeedEvent[] = [];
  for (let rank = 0; picked.length < limit; rank++) {
    let found = false;
    for (const category of EVENT_CATEGORY_ORDER) {
      const event = byCategory.get(category)?.[rank];
      if (!event) continue;
      found = true;
      picked.push(event);
      if (picked.length === limit) return picked;
    }
    // Every category is exhausted. Without this the loop would spin forever on
    // a feed holding fewer listings than `limit`.
    if (!found) break;
  }
  return picked;
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
