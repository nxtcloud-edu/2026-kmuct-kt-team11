'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';

import { mbtiImage, isMbtiType } from '@/lib/mbti';
import { useSpeechToText, useTextToSpeech, preferredSynthesizer } from '@/lib/speech';
import type { SpeechError } from '@/lib/speech';
import type { AgentEvent, AgentMessage, Course, SourceLink } from '@/lib/agent/types';

/**
 * The assistant sheet.
 *
 * A bottom sheet rather than a route, and that is the whole reason this feature
 * is a floating button at all: the question "이 중에 뭐 가지?" is asked *about*
 * the screen you are on. Pushing a route would take the saved places away to
 * answer a question about them.
 *
 * It is 88dvh rather than full-screen for the same reason — the sheet leaves the
 * page it covers visible at the top edge, so it reads as a layer over your
 * places rather than as somewhere else you have gone.
 *
 * ELEVATION. The sheet spends `--shadow-float`, the same shadow the tab bar
 * spends, not a new one. `components/surface.tsx` is explicit that a fourth kind
 * of depth is a `visual-designer` decision; this is not a fourth, it is the same
 * floating-chrome tier the bar already occupies. The scrim behind it is
 * `--scrim`, which the system already defines for exactly this.
 *
 * MOTION. Opacity only, at `--dur-modal`. The system's budget has no transforms,
 * so the sheet cross-fades in rather than sliding up — which also means
 * `prefers-reduced-motion` is already honoured by the token, not by a branch here.
 *
 * VOICE. One button in the composer, to the left of the field. It is
 * tap-to-talk, not a hands-free call, and the argument is in `toggleVoice`.
 */

type Turn = {
  id: string;
  role: 'user' | 'model';
  text: string;
  course?: Course;
  sources?: SourceLink[];
  failed?: boolean;
};

/**
 * Where the composer's text is coming from. A switch for a derivation, not a
 * copy of anything.
 *
 * `'mic-edited'` is a third state rather than a flag because it answers two
 * questions at once, and they have different answers: the composer must show the
 * typed value again, AND the message still originated at the microphone, so its
 * answer is still spoken aloud. Someone who dictates a place name, fixes the one
 * syllable Korean STT always mangles, and sends it has not stopped using voice.
 */
type Draft = 'typed' | 'mic' | 'mic-edited';

/**
 * Starter prompts, and they are not decoration.
 *
 * Paradox of the Active User: nobody reads an explanation of what an assistant
 * can do, they type something and judge it by what comes back. These three are
 * chosen to each exercise a different tool — saved places, a course, blog
 * research — so the first thing a user tries is also the thing that shows what
 * this is for.
 */
const STARTERS = [
  '저장해 둔 곳 중에 오늘 갈 만한 데 있어?',
  '주말 오후 코스 하나 짜줘',
  '요즘 웨이팅 어떤지 알려줘',
];

export function AgentSheet({
  open,
  onClose,
  mbti,
  displayName,
  returnFocusTo,
}: {
  open: boolean;
  onClose: () => void;
  mbti: string | null;
  displayName: string;
  returnFocusTo: React.RefObject<HTMLButtonElement | null>;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<Draft>('typed');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* ── Voice ───────────────────────────────────────────────────────────────── */

  /**
   * Both halves of voice mode are existing parts, used as they were written.
   * `useSpeechToText` is the Web Speech API on-device; `useTextToSpeech` speaks
   * the answer. Neither touches the microphone or the speaker until something
   * below calls `start()` or `speak()` — mounting this sheet asks the user for
   * nothing.
   *
   * `preferredSynthesizer()` is the browser's own voice unless the hosted one
   * has been opted into AND is usable; see lib/speech/fallback-synthesizer.ts.
   * Created through a lazy initialiser so it is built once per mounted sheet
   * rather than on every render.
   */
  const mic = useSpeechToText({ lang: 'ko-KR' });
  const [synthesizer] = useState(preferredSynthesizer);
  const voice = useTextToSpeech({ synthesizer, lang: 'ko-KR' });

  /**
   * What the composer shows — DERIVED, every render, from whichever source owns
   * the draft. Nothing copies the transcript into `input`.
   *
   * That is the whole reason `draft` exists. `mic.transcript` lives in the
   * speech hook's external store and changes on its own schedule, including when
   * Chrome ends a session by itself after a pause — which, with the recogniser's
   * `continuous = false`, is the ORDINARY ending rather than an edge case.
   * Mirroring it into `input` would mean an effect that writes state it just
   * read, one render per interim word, and a frame of stale text every time a
   * session ended without a tap. Deriving costs nothing and cannot go stale.
   *
   * `|| input` keeps a half-typed draft visible until the first word is actually
   * recognised, so tapping the mic and changing your mind does not eat it.
   */
  const composed = draft === 'mic' ? mic.transcript || input : input;
  /** The message started at the microphone, so its answer is spoken back. */
  const byVoice = draft !== 'typed';

  /* ── Focus and dismissal ─────────────────────────────────────────────────── */

  /**
   * Every route out of the sheet goes through here — the close button, the
   * scrim, and Escape — so dismissal is one event handler rather than an effect
   * watching `open` go false.
   *
   * That ordering matters twice. An in-flight turn belongs to an open sheet, so
   * it is abandoned rather than left to finish into a component nobody is
   * looking at. And focus is returned to the button that opened this, because
   * otherwise dismissing drops it onto <body> and the next Tab starts from the
   * top of the document. Doing the focus here rather than in an effect on
   * `!open` is also what stops the button stealing focus on first paint, when
   * `open` has been false all along and nothing was dismissed.
   *
   * Plain function, no `useCallback`. The React Compiler memoises it, and a
   * hand-written one here reads refs and setters it cannot preserve — it says so
   * as a lint error rather than silently dropping the memo.
   */
  function close() {
    abortRef.current?.abort();
    abortRef.current = null;
    // Both of these are dismissal, not cleanup, and both have to be here rather
    // than in an unmount effect: the hooks live above the `!open` early return,
    // so closing the sheet does not unmount them. Left out, a closed sheet keeps
    // talking to a room that has moved on, and the microphone stays open behind
    // a screen the user believes they left. Escape reaches this too.
    voice.stop();
    mic.stop();
    setBusy(false);
    setStatus(null);
    returnFocusTo.current?.focus();
    onClose();
  }

  /**
   * The voice control. One button, three jobs, and only ever one of them live.
   *
   * TAP-TO-TALK, NOT A CALL. The ask was for a "voice call button", and a call
   * is the wrong shape here for three reasons that compound. (1) The recogniser
   * is `continuous = false` — it ends on a natural pause — so hands-free would
   * mean restarting a session on every `onend`, which is new session logic, and
   * the brief is to reuse these two hooks rather than write a third
   * implementation. (2) A real call needs barge-in: hearing the user start
   * talking over the answer, with echo cancellation between `speechSynthesis`
   * output and the microphone. The Web Speech API gives us none of that, and
   * faking it means the assistant's own voice dictating the next question. (3)
   * The sheet is 100dvh and people leave it open. A hands-free mode leaves a hot
   * microphone in it, and in Chrome that microphone is streaming to a remote
   * recogniser — a standing privacy cost for a feature whose turns are bursty
   * anyway, because the question being asked is about the screen behind the
   * sheet. So: one tap opens the microphone, one tap closes it.
   *
   * Toggle rather than press-and-hold. Hold needs pointer capture, breaks when a
   * thumb slides off a 44px target mid-sentence, and has no honest keyboard or
   * switch-control equivalent. A toggle behaves identically for touch, keyboard
   * and switch users, which press-and-hold never does.
   *
   * STOPPING MATTERS MORE THAN STARTING, so the same button is the stop button
   * and it is the largest, nearest control on screen while the answer plays —
   * no hunting, no second affordance to learn. The two stops never contend:
   * silencing the answer is checked first because you cannot talk over it, which
   * makes a tap during playback mean "quiet" and the next tap mean "my turn".
   * Closing the sheet and sending a new message stop the speech as well.
   */
  function toggleVoice() {
    if (voice.speaking) {
      voice.stop();
      return;
    }
    if (mic.listening) {
      mic.stop();
      return;
    }
    // A session starts from empty rather than from whatever the last one left
    // behind, so `composed` cannot briefly show the previous question.
    mic.reset();
    setDraft('mic');
    // FIRST contact with the microphone in this component, inside a click
    // handler, which is also the moment the browser raises its permission
    // prompt. Nothing on mount and nothing on open touches it — a sheet that
    // asked for the microphone just for being opened would be refused once and
    // then refused forever.
    mic.start();
  }

  useEffect(() => {
    if (!open) return;

    // Focus the input, not the sheet: the only thing to do here is type, and a
    // dialog that opens focused on its own container costs every keyboard and
    // screen-reader user one extra step to reach the single control.
    const t = setTimeout(() => inputRef.current?.focus(), 50);

    // The page behind must not scroll under the sheet. Restored on close rather
    // than assumed empty, so this composes with anything else that sets it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      clearTimeout(t);
      document.body.style.overflow = prev;
    };
  }, [open]);

  /* ── Scroll ──────────────────────────────────────────────────────────────── */

  const stickToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(stickToBottom, [turns, status, stickToBottom]);

  /* ── Sending ─────────────────────────────────────────────────────────────── */

  async function send(text: string, spoken = false) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    // Asking the next question ends the last answer and closes the microphone.
    // Both are no-ops when idle.
    voice.stop();
    mic.stop();

    const userTurn: Turn = { id: crypto.randomUUID(), role: 'user', text: trimmed };
    const modelTurn: Turn = { id: crypto.randomUUID(), role: 'model', text: '' };

    // The history the server sees is what was on screen BEFORE this turn, plus
    // this message. Read from the current state rather than from the array we
    // are about to set, because setState is not synchronous.
    const history: AgentMessage[] = [
      ...turns.filter((t) => !t.failed).map((t) => ({ role: t.role, text: t.text })),
      { role: 'user' as const, text: trimmed },
    ].filter((m) => m.text.trim() !== '');

    setTurns((prev) => [...prev, userTurn, modelTurn]);
    setInput('');
    // Back to the typed source, so the settled transcript cannot reappear behind
    // a field the user just watched empty.
    setDraft('typed');
    setBusy(true);
    // Doherty: the acknowledgement has to land immediately, not when the first
    // token does. A tool-calling turn's first model call alone is over a second.
    setStatus('생각하는 중');

    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => prev.map((t) => (t.id === modelTurn.id ? fn(t) : t)));

    /**
     * The answer, accumulated here rather than read back out of `turns`, so the
     * spoken text is whatever this turn produced and nothing else.
     */
    let answer = '';

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ messages: history }),
        signal: controller.signal,
      });

      // A non-2xx here is a failure that happened BEFORE the stream opened, so
      // it is still an RFC 9457 problem document — see the note in the route.
      if (!res.ok || !res.body) {
        const detail = await problemDetail(res);
        answer = detail;
        patch((t) => ({ ...t, text: detail, failed: true }));
        return;
      }

      for await (const event of readNdjson(res.body, controller.signal)) {
        switch (event.type) {
          case 'status':
            // `done` clears only if nothing newer has replaced it, so two tools
            // in a row do not blink through an empty state between them.
            setStatus((cur) => (event.done ? (cur === event.label ? null : cur) : event.label));
            break;
          case 'text':
            answer += event.delta;
            patch((t) => ({ ...t, text: t.text + event.delta }));
            break;
          case 'course':
            patch((t) => ({ ...t, course: event.course }));
            break;
          case 'sources':
            patch((t) => ({ ...t, sources: event.sources }));
            break;
          case 'error':
            // Spoken too. Someone who asked out loud and is not looking at the
            // screen has to be told the answer is not coming.
            answer = event.detail;
            patch((t) => ({ ...t, text: event.detail, failed: true }));
            break;
          case 'done':
            setStatus(null);
            break;
        }
      }
    } catch (e) {
      // An abort is the user closing the sheet, not a failure to report.
      if ((e as Error)?.name !== 'AbortError') {
        answer = '서버에 연결하지 못했어요.';
        patch((t) => ({ ...t, text: answer, failed: true }));
      }
    } finally {
      setBusy(false);
      setStatus(null);
      abortRef.current = null;

      /**
       * WHEN THE ANSWER IS SPOKEN: once, here, with the whole thing — never per
       * `text` delta.
       *
       * Per-delta is not merely choppy, it is silent: `BrowserSynthesizer.speak`
       * opens with `speechSynthesis.cancel()`, so every delta would kill the
       * syllable before it. Speaking sentence-by-sentence has the same problem
       * one level up — it would need a queue, which means changing the backend
       * contract PR #8 just established, in which a backend speaks one utterance
       * and reports start/end.
       *
       * Waiting for `done` costs less than it looks like. What makes a turn slow
       * is the tools — an Apify run is tens of seconds — and all of that has
       * already happened by the time the first token lands; the text itself
       * arrives in a burst. And a course arrives as a `course` event, not as
       * text, so an answer spoken early would be prose about a card that had not
       * been drawn yet.
       *
       * `spoken` gates it on the question having been ASKED aloud. A user who
       * typed is not expecting the room to hear the reply. `aborted` gates out a
       * closed sheet: `close()` aborts and stops the voice, and without this
       * check the answer would start talking a moment afterwards.
       */
      if (spoken && answer && !controller.signal.aborted) voice.speak(answer);
    }
  }

  if (!open) return null;

  const avatar = mbti && isMbtiType(mbti) ? mbtiImage(mbti) : null;
  const empty = turns.length === 0;

  return (
    <div className="fixed inset-0 z-40 flex justify-center" role="presentation">
      {/* The scrim is the dismissal target as well as the dimming. `aria-hidden`
          because Escape and the close button are the accessible routes out —
          a focusable backdrop would be a tab stop with no label. */}
      <button
        aria-hidden
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 animate-[fade_var(--dur-fade)_var(--ease-fade)]"
        style={{ background: 'var(--scrim)' }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="가자 어시스턴트"
        // Escape is handled here rather than on `document`. Opening focuses the
        // composer inside this element, so a keydown listener on the dialog sees
        // it — and it does not have to be re-subscribed every time `close`'s
        // identity changes, which a document-level listener would.
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
        // Full height, not a partial sheet. A conversation is the whole task
        // while it is happening — a 12dvh strip of the screen behind it is not
        // context you can act on, it is just a smaller conversation. On the
        // desktop canvas the width stays clamped so it still reads as the phone
        // it is designed for; only the height changes.
        //
        // dvh rather than vh because mobile browser chrome shrinks the viewport
        // as it hides, and vh would leave the composer under the URL bar.
        className="relative mt-auto flex h-[100dvh] w-full max-w-[var(--canvas-width)] flex-col
                   overflow-hidden bg-canvas shadow-float
                   animate-[fade_var(--dur-modal)_var(--ease-fade)]"
      >
        <Header avatar={avatar} mbti={mbti} onClose={close} />

        <div ref={scrollerRef} className="flex-1 overflow-y-auto px-[var(--gutter)] pb-[var(--space-11)]">
          {empty ? (
            <Intro displayName={displayName} onPick={(s) => void send(s, false)} />
          ) : (
            <ol className="flex flex-col gap-[var(--space-13)] pt-[var(--space-13)]">
              {turns.map((t) => (
                <Bubble key={t.id} turn={t} avatar={avatar} />
              ))}
            </ol>
          )}

          {/* Status is the only thing on screen during a tool call, so it is
              announced rather than just drawn. `polite`, not `assertive` — it
              updates several times a turn and must not interrupt. */}
          {status ? (
            <p
              aria-live="polite"
              className="mt-[var(--space-13)] flex items-center gap-[var(--space-7)] text-secondary"
              style={{ font: 'var(--type-meta)' }}
            >
              <Pulse />
              {status}
            </p>
          ) : null}
        </div>

        <Composer
          ref={inputRef}
          value={composed}
          onChange={(v) => {
            setInput(v);
            // Typing over a dictation keeps the turn a voice turn — the composer
            // just stops mirroring the transcript. See the `Draft` note.
            setDraft((d) => (d === 'typed' ? 'typed' : 'mic-edited'));
          }}
          onSend={() => void send(composed, byVoice)}
          busy={busy}
          voice={{
            // No button at all rather than a disabled one. Web Speech is
            // Chromium-strong and absent in Firefox, and a dead control there
            // would invite a tap and then explain nothing — this is a touch
            // design with no hover vocabulary to hang a reason on, and
            // "use a different browser" is not an action available inside the
            // app. The sheet is fully usable by typing, so the honest move is to
            // not advertise a capability this browser does not have.
            available: mic.supported,
            listening: mic.listening,
            speaking: voice.speaking,
            notice: micNotice(mic.error, mic.listening),
            onToggle: toggleVoice,
          }}
        />
      </div>
    </div>
  );
}

/* ── Header ───────────────────────────────────────────────────────────────── */

function Header({
  avatar,
  mbti,
  onClose,
}: {
  avatar: string | null;
  mbti: string | null;
  onClose: () => void;
}) {
  return (
    <header className="flex items-center gap-[var(--space-9)] border-b border-divider px-[var(--gutter)] py-[var(--space-11)]">
      <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-circle)] bg-surface-2">
        {avatar ? (
          <Image src={avatar} alt="" width={36} height={36} className="h-full w-full object-cover" />
        ) : (
          <Spark size={18} />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <h2 style={{ font: 'var(--type-card-title)' }}>가자 어시스턴트</h2>
        {/* The MBTI is stated as the face it is wearing, not as a claim about
            the user. The agent is told the same thing in as many words. */}
        <p className="text-secondary" style={{ font: 'var(--type-byline)' }}>
          {mbti ? `${mbti} 얼굴을 하고 있어요` : '저장한 곳을 보고 답해요'}
        </p>
      </div>

      <button
        onClick={onClose}
        aria-label="닫기"
        className="grid h-[var(--tap-min)] w-[var(--tap-min)] -mr-[var(--space-8)] place-items-center
                   rounded-[var(--radius-circle)] text-secondary transition-opacity duration-200
                   active:opacity-[var(--press-opacity)]"
      >
        <Close />
      </button>
    </header>
  );
}

/* ── Empty state ──────────────────────────────────────────────────────────── */

function Intro({ displayName, onPick }: { displayName: string; onPick: (s: string) => void }) {
  return (
    <div className="pt-[var(--space-17)]">
      <h3 style={{ font: 'var(--type-tab-header)', letterSpacing: 'var(--tab-header-ls)' }}>
        {displayName}님,
        <br />
        저장만 해둔 곳 꺼내볼까요?
      </h3>
      <p className="mt-[var(--space-8)] text-secondary" style={{ font: 'var(--type-body)' }}>
        저장한 장소를 보고 답해요. 코스도 짜고, 네이버 블로그 후기도 찾아볼게요.
      </p>

      <ul className="mt-[var(--space-15)] flex flex-col gap-[var(--space-7)]">
        {STARTERS.map((s) => (
          <li key={s}>
            <button
              onClick={() => onPick(s)}
              className="w-full rounded-[var(--radius-lg)] bg-surface-1 px-[var(--space-11)] py-[var(--space-10)]
                         text-left transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
              style={{ font: 'var(--type-body)' }}
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Bubbles ──────────────────────────────────────────────────────────────── */

function Bubble({ turn, avatar }: { turn: Turn; avatar: string | null }) {
  // The one convention the Chat checklist says not to break for a design
  // reason: sent right, received left.
  if (turn.role === 'user') {
    return (
      <li className="flex justify-end">
        <p
          className="max-w-[80%] rounded-[var(--radius-2xl)] rounded-br-[var(--radius-xs)]
                     bg-ink px-[var(--space-11)] py-[var(--space-8)] text-on-ink whitespace-pre-wrap"
          style={{ font: 'var(--type-body)' }}
        >
          {turn.text}
        </p>
      </li>
    );
  }

  // Nothing to draw yet — the status line above is carrying this turn.
  if (!turn.text && !turn.course && !turn.sources?.length) return null;

  return (
    <li className="flex gap-[var(--space-8)]">
      <span className="mt-[2px] grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-circle)] bg-surface-2">
        {avatar ? (
          <Image src={avatar} alt="" width={28} height={28} className="h-full w-full object-cover" />
        ) : (
          <Spark size={14} />
        )}
      </span>

      <div className="min-w-0 flex-1">
        {turn.text ? (
          <p
            className={`whitespace-pre-wrap ${turn.failed ? 'text-secondary' : ''}`}
            style={{ font: 'var(--type-body)' }}
          >
            {turn.text}
          </p>
        ) : null}

        {turn.course ? <CourseCard course={turn.course} /> : null}
        {turn.sources?.length ? <Sources sources={turn.sources} /> : null}
      </div>
    </li>
  );
}

/* ── Course card ──────────────────────────────────────────────────────────── */

/**
 * Goal-Gradient: the numbered rail down the left is the point. A day out is a
 * sequence with an end, and showing stop 3 of 4 is what makes it feel finishable
 * rather than like four separate errands.
 *
 * Flat, per the depth budget — a `Card` surface step and hairlines between
 * stops, no elevation.
 */
function CourseCard({ course }: { course: Course }) {
  return (
    <section className="mt-[var(--space-10)] rounded-[var(--radius-2xl)] bg-surface-1 p-[var(--space-11)]">
      <h4 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>
        {course.title}
      </h4>
      {course.when ? (
        <p className="mt-[var(--space-2)] text-secondary" style={{ font: 'var(--type-meta)' }}>
          {course.when}
        </p>
      ) : null}

      <ol className="mt-[var(--space-11)] flex flex-col">
        {course.stops.map((stop, i) => (
          <li
            key={`${stop.order}-${stop.name}`}
            className={`flex gap-[var(--space-9)] py-[var(--space-9)] ${
              i > 0 ? 'border-t border-hairline' : ''
            }`}
          >
            <span
              aria-hidden
              className="grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-circle)] bg-ink text-on-ink"
              style={{ font: 'var(--type-tag)' }}
            >
              {stop.order}
            </span>

            <div className="min-w-0 flex-1">
              <p style={{ font: 'var(--type-card-title)' }}>{stop.name}</p>
              <p className="mt-[var(--space-1)] text-secondary" style={{ font: 'var(--type-meta)' }}>
                {[stop.start, stop.minutes ? `${stop.minutes}분` : null, stop.area]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {stop.why ? (
                <p className="mt-[var(--space-4)] text-secondary" style={{ font: 'var(--type-meta)' }}>
                  {stop.why}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {course.notes.length ? (
        <ul className="mt-[var(--space-8)] border-t border-hairline pt-[var(--space-9)]">
          {course.notes.map((n) => (
            <li key={n} className="text-secondary" style={{ font: 'var(--type-meta)' }}>
              {n}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ── Sources ──────────────────────────────────────────────────────────────── */

/**
 * The receipts. A wait time read off a blog post is only worth stating if the
 * reader can go and check it, so the post travels with the claim — dated,
 * because a six-month-old "웨이팅 없어요" is a different statement from last
 * week's.
 */
function Sources({ sources }: { sources: SourceLink[] }) {
  return (
    <details className="mt-[var(--space-9)]">
      <summary className="cursor-pointer text-secondary" style={{ font: 'var(--type-meta)' }}>
        참고한 블로그 {sources.length}건
      </summary>
      <ul className="mt-[var(--space-7)] flex flex-col gap-[var(--space-5)]">
        {sources.map((s) => (
          <li key={s.url}>
            <a
              href={s.url}
              target="_blank"
              // noreferrer as well as noopener: an outbound link to a blog post
              // should not carry which screen of this app the reader came from.
              rel="noopener noreferrer"
              className="text-secondary underline"
              style={{ font: 'var(--type-meta)' }}
            >
              {s.title || s.url}
            </a>
            <span className="ml-[var(--space-5)] text-tertiary" style={{ font: 'var(--type-byline)' }}>
              {s.posted_at}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/* ── Composer ─────────────────────────────────────────────────────────────── */

type VoiceControl = {
  /** The browser can hear at all. False hides the button entirely. */
  available: boolean;
  listening: boolean;
  speaking: boolean;
  /** One line to show under the field, or null. */
  notice: string | null;
  onToggle: () => void;
};

function Composer({
  ref,
  value,
  onChange,
  onSend,
  busy,
  voice,
}: {
  ref: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  voice: VoiceControl;
}) {
  // A textarea, not an input, because a question about a day out runs to two
  // lines and a single-line field hides the start of what you typed. It grows to
  // four lines and then scrolls.
  function resize(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }

  return (
    <div
      className="border-t border-divider bg-canvas px-[var(--gutter)] pt-[var(--space-9)]
                 pb-[calc(var(--space-9)+env(safe-area-inset-bottom))]"
    >
      {/* Announced, not just drawn: while the microphone is open the words land
          in the field, and a field's value changing is not something a screen
          reader says. `polite` — it must not cut across the answer being read.

          Always mounted, never conditional. A live region that appears at the
          same moment as its first content is usually announced by nothing —
          screen readers watch regions that were already there. Empty it is a
          flex box with no children, so it is also zero pixels tall. */}
      <p
        aria-live="polite"
        className={`flex items-center gap-[var(--space-7)] text-secondary ${
          voice.listening || voice.notice ? 'mb-[var(--space-8)]' : ''
        }`}
        style={{ font: 'var(--type-meta)' }}
      >
        {voice.listening ? <Pulse /> : null}
        {voice.listening ? '듣고 있어요' : voice.notice}
      </p>

      <div className="flex items-end gap-[var(--space-7)]">
        {voice.available ? <VoiceButton {...voice} busy={busy} /> : null}

        <textarea
          ref={ref}
          rows={1}
          value={value}
          // Read-only rather than disabled while the microphone is open: you
          // cannot type and dictate into the same field at once, but a disabled
          // field drops out of the tab order and stops being readable to a
          // screen reader — which is the one moment its contents are changing.
          readOnly={voice.listening}
          onChange={(e) => {
            onChange(e.target.value);
            resize(e.target);
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks a line — but only on a keyboard.
            // `isComposing` is why this is not a one-liner: mid-Hangul, Enter is
            // the IME committing a syllable, and sending there would cut the word
            // in half. Every Korean text field that gets this wrong is hated.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="오늘 어디 갈까요?"
          aria-label="어시스턴트에게 보낼 메시지"
          className="max-h-24 min-h-[var(--tap-min)] flex-1 resize-none rounded-[var(--radius-lg)]
                     bg-surface-2 px-[var(--space-11)] py-[var(--space-9)] outline-none"
          style={{ font: 'var(--type-body)' }}
        />

        <button
          onClick={onSend}
          disabled={busy || value.trim() === ''}
          aria-label="보내기"
          className="grid h-[var(--tap-min)] w-[var(--tap-min)] shrink-0 place-items-center
                     rounded-[var(--radius-circle)] bg-ink text-on-ink transition-opacity duration-200
                     active:opacity-[var(--press-opacity)] disabled:opacity-40"
        >
          <Send />
        </button>
      </div>
    </div>
  );
}

/**
 * Three states, no new tokens.
 *
 * Idle is the transparent `secondary` treatment the close button already uses,
 * so it reads as chrome next to the field rather than as a second send button.
 * Listening inverts to `ink`/`on-ink` — the same device the send button uses to
 * say "this one is the action", and the one way to make a control obviously
 * live without a colour the system does not have and without a fourth shadow.
 * Speaking is a tinted `surface-2` fill with a stop glyph: present, clearly
 * pressable, clearly not the same thing as listening.
 *
 * Only the label tells a screen reader which job the button currently has, and
 * there is deliberately no `aria-pressed`: across these three states the control
 * is not one toggle with an on and an off, and announcing it as one would be a
 * worse description than the label it already changes to.
 */
function VoiceButton({
  listening,
  speaking,
  busy,
  onToggle,
}: VoiceControl & { busy: boolean }) {
  const label = speaking ? '읽어주기 멈추기' : listening ? '말하기 끝내기' : '음성으로 말하기';
  const fill = listening
    ? 'bg-ink text-on-ink'
    : speaking
      ? 'bg-surface-2 text-ink'
      : 'text-secondary';

  return (
    <button
      type="button"
      onClick={onToggle}
      // Only while a turn is in flight, matching the send button — a message
      // dictated now could not be sent anyway. Stopping the answer being read is
      // never blocked by this, because reading only starts once the turn is done.
      disabled={busy}
      aria-label={label}
      className={`grid h-[var(--tap-min)] w-[var(--tap-min)] shrink-0 place-items-center
                  rounded-[var(--radius-circle)] transition-opacity duration-200
                  active:opacity-[var(--press-opacity)] disabled:opacity-40 ${fill}`}
    >
      {speaking ? <StopSquare /> : <Mic />}
    </button>
  );
}

/**
 * What to say about a recognition error, derived rather than stored.
 *
 * Only two of these are worth a user's attention, and the filtering is the
 * point. `aborted` is our own `stop()` and is not news. A live session's earlier
 * error is not news either — the words are arriving. `not-allowed` is the one
 * that is genuinely actionable, and it is the only one that gets told where to
 * go, because a permission the user denied is the only failure here they can
 * actually undo.
 */
function micNotice(error: SpeechError | null, listening: boolean): string | null {
  if (!error || listening) return null;
  switch (error.code) {
    case 'aborted':
      return null;
    case 'not-allowed':
      return '마이크가 차단되어 있어요. 주소창의 자물쇠에서 허용해 주세요.';
    case 'no-speech':
      return '아무 말도 못 들었어요.';
    case 'network':
      return '음성 인식에 연결하지 못했어요.';
    default:
      return '음성 인식이 안 됐어요. 직접 입력해 주세요.';
  }
}

/* ── NDJSON ───────────────────────────────────────────────────────────────── */

/**
 * One JSON object per line. A chunk from the network can split a line anywhere,
 * including inside a multi-byte Hangul character — which is why the decoder is
 * created once with `{ stream: true }` rather than `JSON.parse`ing each chunk.
 *
 * A line that will not parse is skipped rather than thrown: losing one status
 * update is a worse-than-nothing reason to abandon a turn that is still
 * producing text.
 */
async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as AgentEvent;
        } catch {
          // Malformed line; the stream is still good.
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** The pre-stream failure path. Problem documents are the contract until the first byte ships. */
async function problemDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string };
    if (typeof body.detail === 'string' && body.detail) return body.detail;
  } catch {
    // Non-JSON body — something upstream answered instead of the route.
  }
  return res.status === 401 ? '다시 로그인해 주세요.' : '대답하는 중에 문제가 생겼어요.';
}

/* ── Glyphs ───────────────────────────────────────────────────────────────── */

/**
 * Drawn here rather than added to `components/icons.tsx`: that set is a
 * normalised export from one Iconsax directory, documented as such, and three
 * hand-drawn paths do not belong in it. Same 1.5px linear weight so they sit
 * beside it without reading as a second family.
 */
const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none',
};

function Close() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" {...stroke} />
    </svg>
  );
}

function Send() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 19V5M5 12l7-7 7 7" {...stroke} />
    </svg>
  );
}

function Mic() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" {...stroke} />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" {...stroke} />
    </svg>
  );
}

/** Stop, not pause: the answer is not resumable, and a pause glyph would promise it is. */
function StopSquare() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
      <rect x="7" y="7" width="10" height="10" rx="2.5" {...stroke} />
    </svg>
  );
}

/** The fallback face, for an account that skipped the MBTI question. */
export function Spark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3.5c.7 3.9 1.9 5.1 5.8 5.8-3.9.7-5.1 1.9-5.8 5.8-.7-3.9-1.9-5.1-5.8-5.8 3.9-.7 5.1-1.9 5.8-5.8Z" {...stroke} />
      <path d="M17.8 15.2c.3 1.7.8 2.2 2.5 2.5-1.7.3-2.2.8-2.5 2.5-.3-1.7-.8-2.2-2.5-2.5 1.7-.3 2.2-.8 2.5-2.5Z" {...stroke} />
    </svg>
  );
}

/**
 * The working indicator. Opacity only — the motion budget has no transforms, so
 * this pulses rather than spinning, and `prefers-reduced-motion` already flattens
 * it through the global rule in globals.css.
 */
function Pulse() {
  return (
    <span
      aria-hidden
      className="h-[6px] w-[6px] rounded-[var(--radius-circle)] bg-ink"
      style={{ animation: 'fade 900ms var(--ease-fade) infinite alternate' }}
    />
  );
}
