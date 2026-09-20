/**
 * Turning a run — two `YYYY-MM-DD` strings — into the line under an event's title.
 *
 * PURE, AND IT TAKES `today` AS AN ARGUMENT. Nothing in here reads the clock.
 * The feed renders "D-3" and "오늘 종료", which are functions of the current date,
 * and a client component deriving that from `new Date()` would render one answer
 * on the server and possibly another in the browser — a hydration mismatch that
 * shows up only around midnight and only for readers whose clock or timezone
 * differs from the server's. `app/(app)/events/page.tsx` computes today once, in
 * Asia/Seoul, and passes it down.
 *
 * STRING ARITHMETIC, NOT `Date` ARITHMETIC, everywhere below. `new Date('2026-10-11')`
 * parses as UTC midnight and `new Date(2026, 9, 11)` as local midnight, and the
 * two disagree by a day for anyone east of Greenwich — which is every reader this
 * product has. Comparing `YYYY-MM-DD` strings lexicographically is exact,
 * timezone-free, and correct for every date these columns can hold.
 *
 * No imports, so scripts/test-events.sh can compile this file alone.
 */

/** `2026-10-11` → `10.11`, or `2027.1.27` when the year differs from `today`'s. */
function shortDay(iso: string, today: string): string {
  const [y, m, d] = iso.split('-');
  const dayMonth = `${Number(m)}.${Number(d)}`;
  return y === today.slice(0, 4) ? dayMonth : `${y}.${dayMonth}`;
}

/**
 * The run, as one line. `9.12 – 10.11`, `10.3` for a single day, `10.3부터` when
 * the end is unknown, `10.11까지` when the start is.
 *
 * A missing close date reads as "no known end" and NEVER as "ended" — some
 * listings are permanent venues and some simply have not announced a closing
 * date, and a card that said 종료 about either would be wrong in the one way that
 * costs a user a trip.
 */
export function formatRun(
  opensOn: string | null,
  closesOn: string | null,
  today: string,
): string | null {
  if (opensOn && closesOn) {
    // An en dash with hair spaces would be prettier and does not survive being
    // read aloud by a screen reader as reliably as a plain one.
    return opensOn === closesOn
      ? shortDay(opensOn, today)
      : `${shortDay(opensOn, today)} – ${shortDay(closesOn, today)}`;
  }
  if (opensOn) return `${shortDay(opensOn, today)}부터`;
  if (closesOn) return `${shortDay(closesOn, today)}까지`;
  // Rule from the visual record: if there is no data behind a line, delete the
  // line. A dash where a date belongs is a placeholder pretending to be content.
  return null;
}

/**
 * The short status a card wears, or null when it is simply running.
 *
 * Three states and no more, because a badge on every card is not a badge:
 *
 *   `곧 시작`   announced, not open yet. The reason it is worth marking is that
 *              everything else on the screen can be visited today and this
 *              cannot.
 *   `오늘 종료`  the last day. A person who sees this at lunch can still go.
 *   `D-n`      inside the last week. Below that threshold the count is noise —
 *              `D-40` tells a reader nothing the date range did not.
 *
 * Returns null for a listing with no close date, which is the "no known end"
 * case above: there is no countdown to a day nobody has announced.
 */
export function runStatus(
  opensOn: string | null,
  closesOn: string | null,
  today: string,
): { label: string; ending: boolean } | null {
  if (opensOn && opensOn > today) return { label: '곧 시작', ending: false };
  if (!closesOn) return null;
  if (closesOn === today) return { label: '오늘 종료', ending: true };
  // Ended listings are filtered out by the query (lib/events/store.ts), so this
  // is unreachable through the feed. It is here because this function is also the
  // honest answer for anything else that asks, and silently returning `D--3`
  // would not be.
  if (closesOn < today) return { label: '종료', ending: true };

  const days = daysBetween(today, closesOn);
  return days !== null && days <= 7 ? { label: `D-${days}`, ending: true } : null;
}

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD`, or null if either will not
 * parse.
 *
 * `Date.UTC` for both ends and nothing else: the inputs are calendar dates with
 * no time of day, so anchoring both at UTC midnight makes the difference an
 * exact multiple of a day. Using local time would make the answer depend on
 * whether a daylight-saving boundary fell in between, which for a "D-3" badge
 * means occasionally showing D-2.
 */
export function daysBetween(from: string, to: string): number | null {
  const a = utcMidnight(from);
  const b = utcMidnight(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000);
}

function utcMidnight(iso: string): number | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
