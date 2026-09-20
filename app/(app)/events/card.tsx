'use client';

import Image from 'next/image';

import { Card } from '@/components/surface';
import type { FeedEvent } from '@/lib/api/types';
import { EVENT_CATEGORY_KO } from '@/lib/events/types';
import { formatRun, runStatus } from '@/lib/events/format';
import { SaveButton } from './save-button';

/**
 * One event, as a card. THE ONLY DEFINITION — the events tab and the home
 * screen both render this file.
 *
 * It lives here rather than inside `screen.tsx` because an event is now shown on
 * two surfaces, and a second copy of this markup is how the two drift: one of
 * them gains a badge, the other keeps the old padding, and six months later
 * nobody can say which is the card. Extracting it means the home rail is not a
 * smaller cousin of the feed's card; it is the feed's card, in a shorter list.
 *
 * WHAT EACH SCREEN STILL OWNS: the list around it, and `saved`. Save state is a
 * prop rather than local state for the reason spelled out in `save-button.tsx` —
 * the events tab's filter chips reconcile this subtree away on every tap, so a
 * card that remembered its own success would lose it. Both callers lift the set
 * of saved place ids to the screen and pass the answer down.
 *
 * NO EFFECTS. Everything rendered is derived from props during render.
 */
export function EventCard({
  event,
  today,
  saved,
  onSaved,
}: {
  event: FeedEvent;
  /** `YYYY-MM-DD` in Asia/Seoul, computed on the server. See lib/events/today.ts. */
  today: string;
  saved: boolean;
  onSaved: (placeId: string) => void;
}) {
  const run = formatRun(event.opens_on, event.closes_on, today);
  const status = runStatus(event.opens_on, event.closes_on, today);
  // `성수 · 더현대 서울 B1` when both exist; whichever exists when only one does.
  // Built by filtering rather than with a conditional separator so a null never
  // leaves a dangling middle dot.
  const where = [event.area, event.venue].filter(Boolean).join(' · ');

  return (
    <Card as="li" className="flex flex-col gap-[var(--space-9)] p-[var(--space-9)]">
      <div className="flex gap-[var(--space-9)]">
        <Poster src={event.poster_url} category={EVENT_CATEGORY_KO[event.category]} />

        <div className="flex min-w-0 flex-1 flex-col">
          <h3
            className="line-clamp-2"
            style={{ font: 'var(--type-post-title)', letterSpacing: 'var(--post-title-ls)' }}
          >
            {event.title}
          </h3>

          {where ? (
            <p
              className="mt-[var(--space-4)] line-clamp-1 text-secondary"
              style={{ font: 'var(--type-meta)' }}
            >
              {where}
            </p>
          ) : null}

          {run ? (
            <p className="mt-[var(--space-3)] text-secondary" style={{ font: 'var(--type-caption)' }}>
              {run}
              {status ? (
                <>
                  {' · '}
                  {/* THE ONE PLACE A SATURATED COLOUR APPEARS ON THIS CARD, and
                      only on `ending`. `--error` here is semantic — it marks a
                      deadline, not a brand — which is the exception the record
                      allows. 곧 시작 gets no colour: it is information, not a
                      deadline, and colouring both would make neither mean
                      anything. The words carry the meaning either way, so the
                      colour is never the only signal. */}
                  <span className={status.ending ? 'text-error' : undefined}>{status.label}</span>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>

      {/* Actions last, after the reader has the content they are deciding on.
          A hairline rather than a gap alone: this row is a different kind of
          thing from the three lines above it, and the system's way of saying so
          without elevation is a 1px rule. */}
      <div className="flex items-center justify-between gap-[var(--space-9)] border-t border-hairline pt-[var(--space-9)]">
        <a
          href={event.book_url}
          target="_blank"
          // `noopener` is the load-bearing half — without it the opened page gets
          // a handle on `window.opener` and can navigate this tab.
          rel="noopener noreferrer"
          className="flex min-h-[var(--tap-min)] items-center text-secondary
                     transition-opacity duration-200 active:opacity-[var(--press-opacity-strong)]"
          style={{ font: 'var(--type-meta)' }}
        >
          {/* Says where it goes. `예매하기` alone on a card would imply Gaja takes
              the booking, and it does not — this leaves the app. */}
          예매 페이지 열기
        </a>

        <SaveButton eventId={event.id} placeId={event.place_id} saved={saved} onSaved={onSaved} />
      </div>
    </Card>
  );
}

/**
 * The poster, or — for the four listings in thirty that have none — the box that
 * says what kind of thing this is instead.
 *
 * 3:4 at 72px wide. Posters arrive in every ratio a Korean ticketing site has
 * ever used, so the box is fixed and the image covers it — a card whose height
 * depends on its artwork makes the eye re-adjust between every row, which is the
 * first thing the feed checklist warns about.
 *
 * `--radius-photo` is 2px: photography is nearly square-cornered in this system
 * so it reads as a photograph rather than as another piece of chrome.
 *
 * WHEN THERE IS NO POSTER the box holds the category word — 팝업, 전시, 콘서트 —
 * on `--surface-2`. A bare tinted rectangle at this size is a hole, and the two
 * usual fixes are both worse: a grey mountain-and-sun glyph is exactly what a
 * failed image looks like in every browser, and stretching the artwork that IS
 * there across a wider box would make posterless cards a different shape from
 * the rest of the list. A word is the one filling that is true — it is not
 * pretending to be artwork, and it is information the card did not otherwise
 * carry.
 *
 * `secondary` on `surface-2` measures 4.76:1 in the record's contrast table —
 * AA for body. `tertiary` would have been the instinct and it fails.
 *
 * `aria-hidden`, like the `alt=""` on the image it replaces. It stands in for
 * artwork, and artwork on this card is announced by nothing: the title and venue
 * beside it already say what the event is. A screen reader working down thirty
 * cards does not need "팝업" read before four of them and not the other
 * twenty-six — that inconsistency is noise, not information.
 */
function Poster({ src, category }: { src: string | null; category: string }) {
  return (
    <span
      className="relative flex h-[96px] w-[72px] shrink-0 items-end overflow-hidden
                 rounded-[var(--radius-photo)] bg-surface-2"
    >
      {src ? (
        <Image
          src={src}
          // Empty, deliberately. The title is right beside it and reading the
          // poster's filename or repeating the title would make a screen reader
          // announce the same event twice.
          alt=""
          fill
          sizes="72px"
          className="object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="w-full p-[var(--space-6)] text-secondary"
          style={{ font: 'var(--type-tag)', letterSpacing: 'var(--tag-ls)' }}
        >
          {category}
        </span>
      )}
    </span>
  );
}
