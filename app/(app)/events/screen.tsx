'use client';

import { useState } from 'react';

import { ChoicePill, Content, PageHeader } from '@/components/surface';
import { EmptyState } from '@/components/states';
import type { EventCategory, FeedEvent } from '@/lib/api/types';
import { EVENT_CATEGORY_KO, EVENT_CATEGORY_ORDER } from '@/lib/events/types';
import { EventCard } from './card';

/**
 * The events feed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCREEN IS, IN ONE SENTENCE: a chunked list of what is on, filtered
 * by one rail of chips, where every card can be booked and most can be saved.
 *
 * CHUNKING. Six categories rather than one long stream, because "이번 주에 뭐
 *보지" is not a single question — a person looking for a popup and a person
 * looking for a musical are doing different things, and a mixed list makes each
 * of them read past the other. Unfiltered, the feed renders as six labelled
 * sections; filtered, as one.
 *
 * SERIAL POSITION EFFECT decides the chip order (lib/events/types.ts): 팝업 is
 * first because it is what Gaja's users are already hunting for, 스포츠 last
 * because it is the category most likely to be thin.
 *
 * HICK'S LAW keeps the rail to seven items and gives it no second axis — no
 * date filter, no area filter, no sort. Thirty cards do not need a query builder
 * in front of them, and each extra control is paid for on every visit by every
 * reader, including the ones who would have just scrolled.
 *
 * DOHERTY THRESHOLD is why the filter is client-side state and not a search
 * param: the whole feed is already in memory and a chip tap should be instant.
 * A round trip per chip would make the cheapest interaction on the screen the
 * slowest one.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE CARD ITSELF LIVES IN `./card.tsx`, not here, because the home screen shows
 * the same object. What this screen owns is the rail, the chunking and the set of
 * saved place ids; what a card looks like is not a property of this screen.
 *
 * NO EFFECTS IN THIS FILE. Both pieces of state are initialised from props once
 * and then only ever changed by something the user did. In particular `saved`
 * arrives already resolved per reader from the server query — there is nothing
 * to reconcile after mount, and so nothing that would tempt a setState inside an
 * effect to repair it.
 */

type Counts = Partial<Record<EventCategory, { live: number; total: number }>>;

export function EventsScreen({
  events,
  counts,
  today,
}: {
  events: FeedEvent[];
  counts: Counts;
  /** `YYYY-MM-DD` in Asia/Seoul, computed on the server. See page.tsx. */
  today: string;
}) {
  const [selected, setSelected] = useState<EventCategory | null>(null);

  /**
   * Which places this reader holds, as a set of `places.id`.
   *
   * KEYED BY PLACE, NOT BY EVENT, because that is what a save actually creates:
   * a `saved_places` row pointing at a `places` row. Two listings that resolved
   * to the same venue are both saved by one tap, and keying by event id would
   * leave the second one still offering 저장 for a row that already exists.
   *
   * OWNED HERE rather than inside each button so it survives the filter: tapping
   * a chip re-renders the list, and state living in an unmounted card is state
   * that silently reverts. The lazy initialiser reads the server's answer once
   * — it deliberately does NOT track later prop changes, because the only writer
   * after mount is this screen itself.
   */
  const [savedPlaceIds, setSavedPlaceIds] = useState<ReadonlySet<string>>(
    () => new Set(events.filter((e) => e.saved && e.place_id).map((e) => e.place_id!)),
  );

  // Derived during render. Nothing here is stored, so nothing here can go stale.
  const sections = EVENT_CATEGORY_ORDER.filter((c) => selected === null || c === selected).map(
    (category) => ({ category, items: events.filter((e) => e.category === category) }),
  );
  const visible = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <Content>
      <PageHeader
        title="이벤트"
        meta="일주일에 한 번 새로 가져와요. 저장하면 내 지도에 올라가요."
      />

      {/* The rail is horizontally scrollable rather than wrapped: at 430px seven
          pills do not fit on one line, and wrapping to two rows makes a filter
          look like a section of content. `-mx-[var(--gutter)]` plus matching
          padding lets it bleed to the canvas edge so the last chip is visibly
          cut off — which is the only affordance saying there is more to the
          right. */}
      <div
        role="group"
        aria-label="분류"
        className="-mx-[var(--gutter)] mb-[var(--space-15)] flex gap-[var(--space-7)]
                   overflow-x-auto px-[var(--gutter)] [scrollbar-width:none]
                   [&::-webkit-scrollbar]:hidden"
      >
        <ChoicePill
          selected={selected === null}
          onClick={() => setSelected(null)}
          className="shrink-0"
        >
          전체
        </ChoicePill>
        {EVENT_CATEGORY_ORDER.map((category) => (
          <ChoicePill
            key={category}
            selected={selected === category}
            // Tapping the active chip clears the filter. Without it the only way
            // back to 전체 is to find that one chip again at the far left of a
            // rail that may be scrolled away.
            onClick={() => setSelected((c) => (c === category ? null : category))}
            className="shrink-0"
          >
            {EVENT_CATEGORY_KO[category]}
          </ChoicePill>
        ))}
      </div>

      {visible === 0 ? (
        <Empty selected={selected} counts={counts} onClear={() => setSelected(null)} />
      ) : (
        <div className="flex flex-col gap-[var(--section-gap)]">
          {sections
            // The record's rule: if there is no data behind a line, delete the
            // line. An unfiltered feed shows no heading for a category that has
            // nothing in it, rather than a heading over an apology.
            .filter((s) => s.items.length > 0)
            .map(({ category, items }) => (
              <section key={category}>
                {/* The heading is redundant when the rail already names the one
                    category on screen, and a redundant heading is a line of
                    chrome between the reader and the first card. */}
                {selected === null ? (
                  <h2
                    className="mb-[var(--space-9)]"
                    style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}
                  >
                    {EVENT_CATEGORY_KO[category]}
                  </h2>
                ) : null}

                <ul className="m-0 flex list-none flex-col gap-[var(--space-8)] p-0">
                  {items.map((event) => (
                    <EventCard
                      key={event.id}
                      event={event}
                      today={today}
                      saved={event.place_id !== null && savedPlaceIds.has(event.place_id)}
                      onSaved={(placeId) =>
                        setSavedPlaceIds((prev) => new Set(prev).add(placeId))
                      }
                    />
                  ))}
                </ul>
              </section>
            ))}
        </div>
      )}
    </Content>
  );
}

/* ── Empty ────────────────────────────────────────────────────────────────── */

/**
 * THREE EMPTY STATES, NOT ONE, and the distinction is the point.
 *
 * The checklist is explicit that a screen which is empty because nothing exists
 * yet and a screen which is empty because a filter matched nothing are different
 * screens — and that showing the "nothing here" copy when the real cause is
 * something else makes people think they have lost data.
 *
 *   nothing scraped at all   the weekly job has not run, or it ran and every
 *                            category came back empty. Says when it refreshes,
 *                            because the honest next step is to wait.
 *   filtered, all ended      this category HAS listings and every one of them
 *                            has closed. That is a stale feed, not an empty one,
 *                            and saying so distinguishes "quiet week" from "the
 *                            scraper died three weeks ago".
 *   filtered, none at all    nothing here this week.
 *
 * Every filtered case carries 전체 보기. A no-results state with no way out is a
 * dead end, and the way out has to be an actual control rather than the
 * expectation that a reader finds the chip rail again.
 */
function Empty({
  selected,
  counts,
  onClear,
}: {
  selected: EventCategory | null;
  counts: Counts;
  onClear: () => void;
}) {
  if (selected === null) {
    return (
      <EmptyState
        title="아직 가져온 행사가 없어요"
        body="팝업과 공연은 일주일에 한 번 새로 가져와요. 조금 뒤에 다시 들러 주세요."
      />
    );
  }

  const label = EVENT_CATEGORY_KO[selected];
  const held = counts[selected]?.total ?? 0;
  const clear = (
    <ChoicePill selected={false} onClick={onClear}>
      전체 보기
    </ChoicePill>
  );

  return held > 0 ? (
    <EmptyState
      title={`지금 볼 수 있는 ${label}이 없어요`}
      body={`가져온 ${label}이 모두 끝났어요. 다음에 새로 가져올 때 채워질 거예요.`}
      action={clear}
    />
  ) : (
    <EmptyState
      title={`${label}은 아직 없어요`}
      body="다른 분류를 둘러보시거나, 다음에 새로 가져올 때 다시 확인해 주세요."
      action={clear}
    />
  );
}
