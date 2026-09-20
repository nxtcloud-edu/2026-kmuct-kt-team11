'use client';

/**
 * The MBTI art, in the two shapes the product needs it: one tile on its own and
 * the sixteen-tile picker.
 *
 * Onboarding asked the question first and owned both. The account screen has to
 * show the answer back and has to let someone who skipped it answer late, so the
 * tile markup now lives here instead of being typed a second time — including
 * the two notes below, which are the kind that get lost in a copy.
 *
 * 1. Selection is an OUTLINE, not an inverted fill. Fifteen of the sixteen
 *    tiles carry their own saturated background, so an ink fill would fight the
 *    art rather than frame it. INTP is the exception and ships on transparency,
 *    which is why it reads as a figure on the card instead of a coloured tile.
 *
 * 2. These PNGs arrived with gAMA+sRGB chunks, which sharp mis-composites
 *    through `next/image`: every background came out pure black while the file
 *    on disk was correct. The chunks are stripped in `public/mbti/`. Re-exporting
 *    the art from a design tool will reintroduce them — strip again, and clear
 *    `.next/dev/cache/images`, or the old black copies survive.
 *
 * The art is the only colour either screen contributes; `.agents/visual-language.md`
 * deviation 5 is what allows it, and it is imagery, not an accent.
 */
import Image from 'next/image';
import { MBTI_TYPES, isMbtiType, mbtiImage, type MbtiType } from '@/lib/mbti';

/* ── Avatar ───────────────────────────────────────────────────────────────── */

/**
 * One tile, for a type that has already been chosen — or a deliberate blank for
 * one that has not.
 *
 * The blank is a `--surface-2` tile with a decorative glyph, never an initial or
 * a generated identicon: an avatar the product invented would be the one thing
 * on this screen that is not actually about the person looking at it. The glyph
 * sits in `--text-tertiary`, which is allowed precisely because it is decoration
 * and `aria-hidden` — that token measures 2.81:1 and may never carry read text.
 */
export function MbtiAvatar({ mbti, size = 96 }: { mbti: string | null; size?: number }) {
  const type = mbti && isMbtiType(mbti) ? mbti : null;

  return (
    <div
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-xl)] bg-surface-2"
      style={{ width: size, height: size }}
    >
      {type ? (
        <Image src={mbtiImage(type)} alt="" width={size} height={size} priority />
      ) : (
        <span aria-hidden className="text-tertiary" style={{ font: 'var(--type-display)' }}>
          ?
        </span>
      )}
    </div>
  );
}

/* ── Picker ───────────────────────────────────────────────────────────────── */

/**
 * The sixteen tiles plus 잘 모르겠어요.
 *
 * `onUnknown` is a separate callback rather than `onSelect(null)` because the two
 * callers mean different things by it and the picker has no business choosing.
 * In onboarding "I don't know" is an answer that moves the flow on; on the
 * account screen it is a value that clears the field and waits to be saved.
 * Forcing a guess would poison the recommendations the question exists to feed,
 * so it stays reachable in both.
 */
export function MbtiPicker({
  value,
  onSelect,
  onUnknown,
  unknownSelected = false,
  labelledBy,
}: {
  value: string | null;
  onSelect: (v: MbtiType) => void;
  onUnknown: () => void;
  /** Whether 잘 모르겠어요 is itself a settled state, not just a way out. */
  unknownSelected?: boolean;
  labelledBy?: string;
}) {
  return (
    <div role="group" aria-labelledby={labelledBy}>
      <div className="grid grid-cols-4 gap-[var(--space-8)]">
        {MBTI_TYPES.map((t) => {
          const selected = value === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => onSelect(t)}
              aria-pressed={selected}
              className={`flex flex-col items-center gap-[var(--space-4)] rounded-[var(--radius-xl)] bg-surface-1 p-[var(--space-5)] transition-opacity duration-200 active:opacity-[var(--press-opacity)] ${
                selected ? 'outline-2 -outline-offset-2 outline-ink' : ''
              }`}
            >
              <Image
                src={mbtiImage(t)}
                alt=""
                width={64}
                height={64}
                className="h-auto w-full rounded-[var(--radius-md)]"
              />
              <span
                className={selected ? 'text-ink' : 'text-secondary'}
                style={{ font: 'var(--type-tag)', letterSpacing: 'var(--tag-ls)' }}
              >
                {t}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onUnknown}
        aria-pressed={unknownSelected ? true : undefined}
        className={`mt-[var(--space-11)] h-[var(--tap-min)] w-full rounded-[var(--radius-lg)] bg-surface-1 transition-opacity duration-200 active:opacity-[var(--press-opacity)] ${
          unknownSelected ? 'text-ink outline-2 -outline-offset-2 outline-ink' : 'text-secondary'
        }`}
        style={{ font: 'var(--type-meta)' }}
      >
        잘 모르겠어요
      </button>
    </div>
  );
}
