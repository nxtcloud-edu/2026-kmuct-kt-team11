import type { Metadata } from 'next';

import { requireSession } from '@/lib/require-session';
import { countEventsByCategory, listFeedEvents } from '@/lib/events/store';
import { seoulToday } from '@/lib/events/today';
import { EventsScreen } from './screen';

export const metadata: Metadata = { title: '이벤트' };

/**
 * 이벤트 — the browse feed of popups and performances.
 *
 * THE ONLY GLOBAL SURFACE IN THE APP. Everything else under `(app)/` answers
 * "what is yours": your saved places, your groups, your account. This answers
 * "what is on", and the answer is the same for every signed-in account —
 * scraped once a week by app/api/internal/events/refresh, stored in `events`
 * with no `user_id` anywhere near it.
 *
 * It is still behind the auth gate, and that is a product decision rather than a
 * security one: the one action on the screen (저장) writes to the reader's own
 * saved places, and a feed you cannot act on is a brochure.
 *
 * SERVER RENDER, TALKING TO POSTGRES DIRECTLY, rather than fetching our own
 * `/api/…` — the same thing `listSavedPlacesForUser` does and for the same
 * reason: an extra HTTP hop and a second copy of the auth check, for nothing.
 */
export default async function EventsPage() {
  const user = await requireSession();

  const [events, counts] = await Promise.all([
    // `saved` is computed inside this query, per reader. The screen therefore
    // never has to reconcile "here are the events" against "here is what you
    // saved" after mounting — which is the shape that ends in a setState inside
    // an effect repairing state that was just read.
    listFeedEvents(user.id),
    countEventsByCategory(),
  ]);

  return (
    <EventsScreen
      events={events}
      // Serialised because a Map does not cross the server/client boundary.
      counts={Object.fromEntries(counts)}
      // ──────────────────────────────────────────────────────────────────────
      // TODAY IS COMPUTED HERE, ON THE SERVER, AND PASSED DOWN AS A STRING.
      //
      // The screen renders "D-3" and "오늘 종료" and greys nothing, all of which
      // are functions of the current date. A client component deriving that from
      // `new Date()` renders one thing on the server and possibly another in the
      // browser — a hydration mismatch that appears only around midnight and
      // only for readers whose clock or timezone differs from the server's.
      //
      // `seoulToday()` is shared with the home screen rather than defined here:
      // both render the same card, and two local definitions of "today" are two
      // chances for one screen to say `D-1` while the other says `오늘 종료`.
      // See lib/events/today.ts for the timezone argument.
      // ──────────────────────────────────────────────────────────────────────
      today={seoulToday()}
    />
  );
}
