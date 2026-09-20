'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import type { FeedEvent } from '@/lib/api/types';
import { EventCard } from '../events/card';

/**
 * What is on, on the home screen. A taste of the 이벤트 tab, never a copy of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A STACK, NOT A CAROUSEL — and the reason is the deck directly above it.
 *
 * `deck.tsx` is a horizontal drag surface: it captures the pointer on
 * `pointerdown` and reads `clientX`. Putting a horizontally-scrolling rail of
 * cards immediately underneath it would place two different horizontal gestures
 * within a thumb's width of each other, and a person cannot tell which one they
 * are in until they have already committed to the drag. The chip rails in this
 * app scroll sideways because nothing above them does.
 *
 * The carousel checklist also asks for a progress indicator, a focused-item
 * state and a transition behaviour. Three cards do not earn that apparatus, and
 * the record's motion budget has nowhere to put it — transforms are permitted in
 * `deck.tsx` and nowhere else. A stack needs none of it: every card is fully
 * visible, in its whole shape, with no affordance to discover.
 *
 * THREE, because the tab is the list and this is the taste. Three full-width
 * cards are roughly 380px — enough to read as substance on a cold-start screen
 * without out-massing the deck on a populated one.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE CARD IS `../events/card.tsx`, imported, not reimplemented. Same surface,
 * same poster box, same run line, same 예매 페이지 열기, same 저장. An event looks
 * like one thing in this product.
 *
 * WHY SAVING WORKS HERE AND IS NOT JUST A LINK OUT: the cold start this section
 * exists to fix is "a new user has nothing and nothing to do". Sending them to a
 * ticketing site in another tab does not fix it — saving does, because a saved
 * event writes a `places` row that turns up in the deck above. Paradox of the
 * Active User: a new user will not read an explanation of what the app is for;
 * they will tap the thing in front of them, so the thing in front of them has to
 * be the thing that makes the app work.
 *
 * NO EFFECTS. `savedPlaceIds` is seeded once from the server's answer and then
 * only ever written by a tap. Nothing here reads a prop and repairs state from
 * it afterwards.
 */
export function HomeEvents({
  events,
  today,
}: {
  /** Already picked and already filtered to live runs. See home/page.tsx. */
  events: FeedEvent[];
  /** `YYYY-MM-DD` in Asia/Seoul, computed on the server. See lib/events/today.ts. */
  today: string;
}) {
  const router = useRouter();

  // Keyed by place, not by event, for the reason in events/screen.tsx: a save
  // creates a `saved_places` row pointing at a `places` row, and two listings at
  // the same venue are both saved by one tap.
  const [savedPlaceIds, setSavedPlaceIds] = useState<ReadonlySet<string>>(
    () => new Set(events.filter((e) => e.saved && e.place_id).map((e) => e.place_id!)),
  );

  return (
    <ul className="m-0 flex list-none flex-col gap-[var(--space-8)] p-0">
      {events.map((event) => (
        <EventCard
          key={event.id}
          event={event}
          today={today}
          saved={event.place_id !== null && savedPlaceIds.has(event.place_id)}
          onSaved={(placeId) => {
            setSavedPlaceIds((prev) => new Set(prev).add(placeId));
            // The deck and the map above were rendered on the server before this
            // tap, so they are now stale by exactly the place that was just
            // saved. Asking the server for the page again is what makes the
            // cold-start promise — "저장하면 여기에 담겨요" — true while the user is
            // still looking at it, rather than on their next visit.
            //
            // In a handler, not an effect: this is a consequence of something
            // the user did, and re-reading props afterwards to notice it would
            // be the repair-in-an-effect shape this codebase keeps growing.
            router.refresh();
          }}
        />
      ))}
    </ul>
  );
}
