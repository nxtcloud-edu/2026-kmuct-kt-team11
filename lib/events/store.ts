/**
 * `events` — the writes the scraper makes, and the one read the feed makes.
 *
 * The only module in lib/events/ that talks to Postgres about listings. Both
 * scrapers are pure-ish (fetch in, objects out), `resolve.ts` returns ids, and
 * everything lands here — so "what does a listing look like in the database" has
 * one answer and one place to change it.
 */

import { query, queryOne } from '../db';
import type { EventCategory, FeedEvent } from '../api/types';
import type { EventResolution, ResolvedEvent } from './resolve';
import type { ScrapedEvent } from './types';

/* ── Write ────────────────────────────────────────────────────────────────── */

/**
 * Write one pass's listings for one category.
 *
 * `seenAt` is passed in rather than taken as `now()` per statement, and the
 * pruner below is the reason: it deletes rows this pass did not touch, so
 * "touched by this pass" has to be a single value every row in the pass shares.
 * Thirty `now()`s spread over a few seconds of geocoding would make that
 * comparison a race against itself.
 *
 * UPSERT, NOT REPLACE. `unique (source, source_id)` is the identity, so a
 * listing seen again next week updates the row it already has and keeps its
 * `id`, its `first_seen_at` and — critically — its `place_id`. Deleting and
 * re-inserting would mint a new `events.id` every week and re-geocode a popup
 * fifty-two times over its run.
 *
 * `place_id` and `place_status` are written only from a resolution that has an
 * opinion — see the `case` in the SQL. A pass where the geocoder was down must
 * not blank out a `place_id` a previous pass worked out; a transient outage
 * would otherwise make every popup in the feed unsaveable for a week.
 *
 * A NULL in `resolutions` means "resolution was not attempted", which is a real
 * state: when the NCP credentials are missing the pass still stores the
 * listings, because a browsable feed nobody can save is a great deal better than
 * no feed. Those rows land as `place_status = 'unresolved'`, which the `case`
 * below treats as no opinion, so the next pass with working credentials fills
 * them in without anyone writing a backfill.
 */
export async function upsertEvents(
  events: readonly ScrapedEvent[],
  resolutions: readonly (ResolvedEvent | null)[],
  seenAt: Date,
): Promise<void> {
  for (const [i, e] of events.entries()) {
    const r = resolutions[i];
    await query(
      `insert into events (source, source_id, category, title, venue, address, area,
                           poster_url, book_url, opens_on, closes_on, rank,
                           place_id, place_status, first_seen_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12, $13, $14, $15, $15)
       on conflict (source, source_id) do update set
         category     = excluded.category,
         title        = excluded.title,
         venue        = excluded.venue,
         address      = excluded.address,
         area         = excluded.area,
         poster_url   = excluded.poster_url,
         book_url     = excluded.book_url,
         opens_on     = excluded.opens_on,
         closes_on    = excluded.closes_on,
         rank         = excluded.rank,
         -- A resolution that failed does not erase one that worked. 'resolved'
         -- and 'no-address' are both settled answers and overwrite; the three
         -- transient ones (not-found, geocode-failed, no-area) leave whatever
         -- the row already had, because "we could not ask today" is not news
         -- about the venue.
         place_id     = case when excluded.place_status in ('resolved', 'no-address')
                             then excluded.place_id else events.place_id end,
         place_status = case when excluded.place_status in ('resolved', 'no-address')
                             then excluded.place_status else events.place_status end,
         last_seen_at = excluded.last_seen_at`,
      [
        e.source,
        e.sourceId,
        e.category,
        e.title,
        e.venue,
        e.address,
        // The geocode's 동/구 beats the source's label when there is one; see
        // `ScrapedEvent.area`, which is explicit that the source's is a hint.
        r?.area ?? e.area,
        e.posterUrl,
        e.bookUrl,
        e.opensOn,
        e.closesOn,
        e.rank,
        r?.placeId ?? null,
        (r?.status ?? 'unresolved') satisfies EventResolution | 'unresolved',
        seenAt,
      ],
    );
  }
}

/**
 * Drop this category's listings that the pass did not see.
 *
 * ONLY EVER CALLED AFTER A PASS THAT PRODUCED ROWS. That guard lives at the call
 * site (`run.ts`) and it is the whole safety property: design §8 says a failed or
 * empty crawl degrades the browse surface to whatever is already stored, and a
 * pruner that ran on an empty pass would do the opposite — the week yanolja
 * changes its payload shape, the feed would go from stale to blank.
 *
 * Returns the number deleted so the pass can report it. A listing that vanished
 * from the source is usually one that sold out or ended, and a week where the
 * number is five is a week where the source rearranged itself.
 */
export async function pruneCategory(category: EventCategory, seenAt: Date): Promise<number> {
  const rows = await query<{ id: string }>(
    `delete from events where category = $1 and last_seen_at < $2 returning id`,
    [category, seenAt],
  );
  return rows.length;
}

/* ── Read ─────────────────────────────────────────────────────────────────── */

type FeedRow = {
  id: string;
  category: string;
  title: string;
  venue: string | null;
  area: string | null;
  poster_url: string | null;
  book_url: string;
  opens_on: string | null;
  closes_on: string | null;
  place_id: string | null;
  saved: boolean;
};

function serialise(r: FeedRow): FeedEvent {
  return {
    id: r.id,
    category: r.category as EventCategory,
    title: r.title,
    venue: r.venue,
    area: r.area,
    poster_url: r.poster_url,
    book_url: r.book_url,
    opens_on: r.opens_on,
    closes_on: r.closes_on,
    place_id: r.place_id,
    saved: r.saved,
  };
}

/**
 * Every live listing, in category then source order, with this reader's save
 * state already attached.
 *
 * ONE QUERY, AND `saved` IS PART OF IT. The alternative — render the cards, then
 * fetch which ones are saved and reconcile — is how a screen ends up calling
 * setState inside an effect to repair state it just read. There is nothing to
 * repair if the server never sent an unrepaired version.
 *
 * `exists` rather than a left join: a user can hold the same place both
 * personally and in a group, and a join would emit that event twice. `exists` is
 * a boolean about the reader and cannot change the row count.
 *
 * Dates come back as TEXT, not as `date`. `pg` parses a `date` column into a JS
 * `Date` at local midnight, and a server in UTC rendering `2026-10-11` for a
 * reader in Seoul is a date that can be off by one in either direction depending
 * on which side does the formatting. `to_char` in the query means the string the
 * client renders is the string the column holds.
 *
 * Ended listings are filtered here rather than deleted by the scraper: the row
 * is still the record of what was scraped, `place_id` on it is still the join a
 * previously saved place came through, and "ended" is a function of today, not
 * of the row.
 */
export async function listFeedEvents(userId: string): Promise<FeedEvent[]> {
  const rows = await query<FeedRow>(
    `select e.id,
            e.category,
            e.title,
            e.venue,
            e.area,
            e.poster_url,
            e.book_url,
            to_char(e.opens_on,  'YYYY-MM-DD') as opens_on,
            to_char(e.closes_on, 'YYYY-MM-DD') as closes_on,
            e.place_id,
            exists (
              select 1 from saved_places sp
               where sp.user_id = $1
                 and sp.place_id = e.place_id
                 and sp.status <> 'rejected'
            ) as saved
       from events e
      -- A null close date is "no known end", never "ended". A permanent venue's
      -- listing has one and must not drop out of the feed the day it is scraped.
      where e.closes_on is null or e.closes_on >= current_date
   order by e.category, e.rank, e.first_seen_at`,
    [userId],
  );
  return rows.map(serialise);
}

/**
 * How many listings each category holds, live and in total.
 *
 * The two numbers are what let the empty state tell the checklist's two cases
 * apart: a category with `total = 0` has never been scraped or came back empty
 * ("아직 없어요"), and a category with `live = 0, total > 0` is holding listings
 * that have all ended ("지난 행사만 남아 있어요"). Showing the same message for both
 * would tell a user their feed is broken when it is merely out of date — and
 * would hide the fact that the scrape has stopped running.
 */
export async function countEventsByCategory(): Promise<
  Map<EventCategory, { live: number; total: number }>
> {
  const rows = await query<{ category: string; live: string; total: string }>(
    `select category,
            count(*) filter (where closes_on is null or closes_on >= current_date) as live,
            count(*) as total
       from events
   group by category`,
  );
  return new Map(
    rows.map((r) => [
      r.category as EventCategory,
      // `count(*)` is bigint, which `pg` hands back as a string so 2^53 cannot
      // silently round. These are counts of at most five.
      { live: Number(r.live), total: Number(r.total) },
    ]),
  );
}

/**
 * One event, for the save path. Returns only what the save needs to decide.
 *
 * `place_id` null here is the 409 the route raises, and it is the reason this
 * returns the row rather than just the id: "no such event" and "this event has
 * no location" are different answers with different messages, and collapsing
 * them into a null would show a user 404 for a card they are looking at.
 */
export async function getEventForSave(
  eventId: string,
): Promise<{ id: string; title: string; place_id: string | null } | null> {
  return queryOne<{ id: string; title: string; place_id: string | null }>(
    `select id, title, place_id from events where id = $1`,
    [eventId],
  );
}
