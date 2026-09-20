'use client';

import Image from 'next/image';
import { useRef, useState } from 'react';

import { isMbtiType, mbtiImage } from '@/lib/mbti';
import { AgentSheet, Spark } from './agent-sheet';

/**
 * The assistant button: a circle wearing the user's own MBTI character, pinned
 * above the tab bar on every signed-in screen.
 *
 * WHY THE FACE. The MBTI answer is the one thing onboarding collects that the
 * product has never used — `app/(app)/home/page.tsx` still refuses to render the
 * shelf it was collected for, because there is no recommendation source behind
 * it. Putting the character on the button spends that answer on something
 * honest: it is the user's own pick looking back at them, which is what makes
 * this read as *their* assistant rather than as a generic chat bubble. It is a
 * Mental Model shortcut, not a claim — the agent is told in as many words not to
 * assert that a type likes a kind of place.
 *
 * The answer was optional and skipping it was a real choice, so `mbti` is
 * nullable all the way down and the fallback is a neutral glyph rather than a
 * default type. Nothing in the UI asks again.
 *
 * ELEVATION. `--shadow-float`, the tab bar's shadow, not a fourth one.
 * `components/surface.tsx` reserves new depth for a `visual-designer` decision;
 * this is the same floating-chrome tier the bar already occupies, one gutter
 * above it, so it reads as part of the same layer rather than as a new one.
 *
 * POSITIONING. The wrapper repeats the tab bar's centring exactly — fixed,
 * `left-1/2`, the canvas width minus two gutters, and the same 480px breakpoint
 * where the phone frame is dropped. Anything else and the button's right edge
 * would stop lining up with the bar's beneath it at one width or the other.
 * `pointer-events-none` on the wrapper so the full-width strip does not eat taps
 * meant for the content behind it.
 */
export function AgentButton({ mbti, displayName }: { mbti: string | null; displayName: string }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const avatar = mbti && isMbtiType(mbti) ? mbtiImage(mbti) : null;

  return (
    <>
      <div
        aria-hidden={open}
        className="pointer-events-none fixed left-1/2 z-30 flex w-[calc(var(--canvas-width)-var(--gutter)*2)]
                   -translate-x-1/2 justify-end
                   bottom-[calc(var(--tab-bar-bottom)+var(--tab-bar-height)+var(--space-9))]
                   max-[479px]:w-[calc(100vw-var(--gutter)*2)]"
      >
        <button
          ref={buttonRef}
          onClick={() => setOpen(true)}
          aria-label="어시스턴트 열기"
          aria-haspopup="dialog"
          aria-expanded={open}
          className="pointer-events-auto grid h-14 w-14 place-items-center overflow-hidden
                     rounded-[var(--radius-circle)] bg-canvas shadow-float
                     transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
        >
          {avatar ? (
            // `priority` is deliberately NOT set. This sits below the fold of
            // every screen's first paint and must not compete with the place
            // thumbnails that are the actual content. 112 = 2× for retina.
            <Image
              src={avatar}
              alt=""
              width={112}
              height={112}
              sizes="56px"
              className="h-full w-full object-cover"
            />
          ) : (
            <Spark size={24} />
          )}
        </button>
      </div>

      <AgentSheet
        open={open}
        onClose={() => setOpen(false)}
        mbti={mbti}
        displayName={displayName}
        returnFocusTo={buttonRef}
      />
    </>
  );
}
