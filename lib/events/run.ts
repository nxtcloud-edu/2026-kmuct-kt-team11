/**
 * One pass of the events scrape: six categories, two sources, at most one
 * network request each.
 *
 * THE PASS LIVES HERE AND NOT IN THE ROUTE, for the reason
 * lib/ingest/run-pass.ts gives for the reel pipeline: the cron and any
 * hand-driven invocation must run the same stages in the same order, and the
 * only way to guarantee that is for neither of them to own the code. What stays
 * in app/api/internal/events/refresh/route.ts is authentication and the mapping
 * onto RFC 9457 — two jobs that are about HTTP and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FOUR OUTCOMES, AND WHY "FOUND NOTHING" IS TWO OF THEM.
 *
 * design §8: a crawl that returns zero for a source that previously returned
 * many is the signature of rot, not of a quiet week, and it must record a
 * DISTINCT outcome rather than a success with no rows — because "succeeded,
 * found nothing" is exactly what a dead scraper looks like from outside.
 *
 *   ok                listings came back. Resolve, upsert, prune.
 *   empty             zero, and `peak_count` is zero — this category has never
 *                     produced anything. Not an alarm.
 *   empty_after_rows  zero, and `peak_count` is not. THE ALARM. Something that
 *                     worked has stopped working, and given what yanolja.ts is
 *                     parsing, the most likely cause is that they deployed.
 *   failed            the request did not complete.
 *
 * AND NOTHING IS PRUNED ON THE LAST THREE. §8 again: a crawl failure degrades
 * the browse surface to whatever is already stored. A pruner that ran on an
 * empty pass would turn the week yanolja changed its payload from "the feed is
 * a week stale" into "the feed is blank", which is the same outage with none of
 * the evidence left behind.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { GeocoderNotConfiguredError } from '../research/geocode';
import { fetchPopgaPopups } from './popga';
import { resolveEventPlaces, type ResolvedEvent } from './resolve';
import { claimCategory, recordOutcome, tripBreaker, type ScrapeOutcome } from './state';
import { pruneCategory, upsertEvents } from './store';
import {
  EVENT_CATEGORIES,
  EventSourceRefusedError,
  SOURCE_FOR_CATEGORY,
  type EventCategory,
  type EventSourceName,
  type ScrapedEvent,
} from './types';
import { fetchYanoljaGenre, type YanoljaCategory } from './yanolja';

export type CategoryResult = {
  category: EventCategory;
  source: EventSourceName;
  /** Why this category did nothing. Null when it ran. */
  skipped: 'cooldown' | 'breaker' | null;
  /** Null when skipped. */
  outcome: ScrapeOutcome | null;
  found: number;
  /** How many of `found` got a `places` row. The rest are browse-only. */
  resolved: number;
  /** Listings the source no longer lists. Only ever non-zero after an `ok`. */
  pruned: number;
  /** A short tag. Never a response body, never a URL with a credential in it. */
  error: string | null;
};

export type EventsPassSummary = {
  /** ISO instant the pass started. Also the `last_seen_at` every row it writes carries. */
  ran_at: string;
  /**
   * True when the pass could not geocode at all because the NCP credentials are
   * absent. Reported rather than thrown: the listings are still worth storing
   * and the feed still works without them — nothing is saveable, which is a
   * different and lesser failure than nothing being browsable.
   */
  geocoder_unavailable: boolean;
  categories: CategoryResult[];
};

/** Six categories, two scrapers. The only place the dispatch exists. */
async function scrape(category: EventCategory): Promise<ScrapedEvent[]> {
  return category === 'popup'
    ? fetchPopgaPopups()
    : fetchYanoljaGenre(category as YanoljaCategory);
}

export async function runEventsPass(): Promise<EventsPassSummary> {
  // ONE timestamp for the whole pass. Every row written carries it as
  // `last_seen_at` and the pruner deletes rows older than it, so "seen by this
  // pass" has to be a single value — thirty `now()`s spread across a minute of
  // geocoding would make that comparison a race against itself.
  const seenAt = new Date();

  // Latched once. The credential is missing for the whole pass or for none of
  // it, and re-discovering that six times would mean six identical log lines
  // and, worse, six chances for a later category to look like it failed for its
  // own reason.
  let geocoderUnavailable = false;

  const categories: CategoryResult[] = [];

  for (const category of EVENT_CATEGORIES) {
    const source = SOURCE_FOR_CATEGORY[category];
    const base: CategoryResult = {
      category,
      source,
      skipped: null,
      outcome: null,
      found: 0,
      resolved: 0,
      pruned: 0,
      error: null,
    };

    const claim = await claimCategory(category);
    if (!claim.run) {
      categories.push({ ...base, skipped: claim.reason });
      continue;
    }

    let found: ScrapedEvent[];
    try {
      found = await scrape(category);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof EventSourceRefusedError) {
        // The source declined on purpose. Nothing retries out of this; see
        // state.ts for why there is no automatic reset.
        await tripBreaker(category, message);
      } else {
        await recordOutcome(category, 'failed', 0, message);
      }
      categories.push({ ...base, outcome: 'failed', error: message });
      continue;
    }

    if (found.length === 0) {
      // ─────────────────────────────────────────────────────────────────────
      // THE ROT ALARM. `peak_count` is read from the state as it was BEFORE
      // this pass claimed the category, which is the only reason this is
      // decidable: the events themselves get pruned and replaced, so counting
      // rows would answer zero on exactly the pass where zero is the thing
      // under suspicion.
      // ─────────────────────────────────────────────────────────────────────
      const outcome: ScrapeOutcome = claim.state.peakCount > 0 ? 'empty_after_rows' : 'empty';
      const error =
        outcome === 'empty_after_rows'
          ? `returned 0 listings; this category has previously returned ${claim.state.peakCount}. ` +
            `The parser is likely broken — see lib/events/yanolja.ts.`
          : null;
      await recordOutcome(category, outcome, 0, error);
      categories.push({ ...base, outcome, error });
      continue;
    }

    // `null` means "resolution was not attempted" — see upsertEvents. The
    // listings are stored either way; only the save button is lost.
    let resolutions: (ResolvedEvent | null)[] = found.map(() => null);
    if (!geocoderUnavailable) {
      try {
        resolutions = await resolveEventPlaces(found);
      } catch (e) {
        if (!(e instanceof GeocoderNotConfiguredError)) throw e;
        console.error('[events] geocoder not configured; storing listings unresolved.', e.message);
        geocoderUnavailable = true;
      }
    }

    await upsertEvents(found, resolutions, seenAt);
    const pruned = await pruneCategory(category, seenAt);
    await recordOutcome(category, 'ok', found.length, null);

    categories.push({
      ...base,
      outcome: 'ok',
      found: found.length,
      resolved: resolutions.filter((r) => r?.placeId != null).length,
      pruned,
    });
  }

  return {
    ran_at: seenAt.toISOString(),
    geocoder_unavailable: geocoderUnavailable,
    categories,
  };
}
