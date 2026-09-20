'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';

import { mbtiImage, isMbtiType } from '@/lib/mbti';
import {
  BrowserRecognizer,
  preferredSynthesizer,
  tapRecognizer,
  tapSynthesizer,
  useSpeechToText,
  useTextToSpeech,
} from '@/lib/speech';
import type { RecognizerTap, SpeechError, SynthesizerTap } from '@/lib/speech';
import { Button } from '@/components/surface';
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
 * VOICE. One button in the composer opens a CALL: hands-free, Korean, the
 * assistant speaks and you speak. The turn-taking machine is `startCall` and the
 * three taps under it; the surface it draws is `CallPanel`.
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
 * The call, as four states and nothing else. `null` is "not on a call".
 *
 * They are named for what the USER is owed at that moment, because the one
 * question a call has to answer continuously is whose turn it is:
 *
 *   connecting — 연결 중.  The microphone has been asked for and has not opened.
 *   listening  — 듣는 중.  Your turn. The microphone is live.
 *   thinking   — 생각 중.  Our turn, silently. The microphone is SHUT.
 *   speaking   — 말하는 중. Our turn, aloud. The microphone is SHUT.
 *
 * Half-duplex, like a phone actually is: exactly one of the two of you holds the
 * line, and the shut microphone in the last two states is not a limitation to
 * apologise for — it is the entire echo-cancellation strategy. An open
 * microphone with no AEC hears the assistant and dictates its own next question.
 */
type CallPhase = 'connecting' | 'listening' | 'thinking' | 'speaking';

/**
 * Empty recognition sessions in a row before we say something, and before we
 * hang up. Chrome ends a session by itself after roughly five to eight seconds
 * of silence, so these are about twelve seconds and about forty.
 *
 * The hang-up is the important one. A call that outlives the user's attention is
 * a hot microphone in a sheet nobody is looking at, and no status line prevents
 * that — only ending the call does.
 */
const SILENT_HINT = 2;
const SILENT_HANGUP = 6;

/**
 * Consecutive sessions that never managed to open before we stop trying.
 * Distinct from silence: this is the engine refusing, and retrying it at full
 * speed is the tight loop that burns a tab.
 */
const FAILED_ARMS_LIMIT = 5;

/** Re-open the microphone this long after the assistant stops. */
const REARM_MS = 180;
/** Back off this far when a session failed to open at all. */
const REARM_AFTER_FAILURE_MS = 1200;

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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* ── Voice ───────────────────────────────────────────────────────────────── */

  /**
   * Both halves are the existing parts, used as they were written.
   * `useSpeechToText` is the Web Speech API on-device; `useTextToSpeech` speaks
   * the answer, through the browser voice unless the hosted one is both opted
   * into and usable (lib/speech/fallback-synthesizer.ts). Neither touches the
   * microphone or the speaker until something below calls `start()` or
   * `speak()` — mounting this sheet asks the user for nothing.
   *
   * Each is wrapped in a TAP, which is not a third engine: it forwards every
   * call to the real backend and additionally hands us the three events a call
   * is made of — the microphone opened, a turn ended, the answer finished
   * playing. Built once through a lazy initialiser, because these hooks keep
   * their backend for their whole lifetime and rebuilding one mid-call would
   * drop the session.
   */
  const tapsRef = useRef<RecognizerTap & SynthesizerTap>({});
  const [engine] = useState(() => {
    const taps = () => tapsRef.current;
    return {
      recognizer: tapRecognizer(new BrowserRecognizer(), taps),
      synthesizer: tapSynthesizer(preferredSynthesizer(), taps),
    };
  });
  const mic = useSpeechToText({ lang: 'ko-KR', recognizer: engine.recognizer });
  const voice = useTextToSpeech({ synthesizer: engine.synthesizer, lang: 'ko-KR' });

  /** What the call is doing. `null` when there is no call. */
  const [phase, setPhase] = useState<CallPhase | null>(null);
  /** Recognition sessions in a row that heard nothing. Drives the hint and the hang-up. */
  const [silence, setSilence] = useState(0);
  /** Why the last call ended, when it ended on its own. Shown once, under the composer. */
  const [callNotice, setCallNotice] = useState<string | null>(null);

  /**
   * The machine's own copies, and they are refs on purpose.
   *
   * Speech events arrive from outside React — from the recogniser's `onend`, an
   * utterance's `onend` — and each one has to act on the phase as it is AT THAT
   * INSTANT, not the one captured when its closure was made. A ref is the only
   * thing that is current in both places. They are written beside the setState
   * that renders them, never in an effect that reads state back and repairs it.
   */
  const phaseRef = useRef<CallPhase | null>(null);
  /** We want the microphone open. False while muted for the answer, and after a hang-up. */
  const wantMicRef = useRef(false);
  /** This session actually opened. False means the engine refused, which is a different problem. */
  const micOpenedRef = useRef(false);
  const micErrorRef = useRef<SpeechError | null>(null);
  const failedArmsRef = useRef(0);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** An answer of OURS is playing or about to. Stops a stale onEnd re-opening the mic. */
  const voiceTurnRef = useRef(false);
  /** The two controls that hand focus to each other as the call starts and ends. */
  const hangUpRef = useRef<HTMLButtonElement>(null);
  const callButtonRef = useRef<HTMLButtonElement>(null);

  function go(next: CallPhase | null) {
    phaseRef.current = next;
    setPhase(next);
  }

  /**
   * Your turn: open the microphone after `delay`.
   *
   * CONTINUOUS LISTENING IS THIS FUNCTION, not a flag. `continuous = true` is
   * the obvious-looking answer and it is not the one available: the Web Speech
   * recogniser ends a session on a pause regardless, so a call is a chain of
   * short sessions and the chain is what has to be maintained.
   *
   * The delay is not politeness. Calling `start()` from inside the `onend` that
   * just fired makes Chrome throw "already started", which our recogniser
   * reports as an error AND an end — and an end is what brought us here, so that
   * is the tight loop. A tick of separation removes it. It also gives the
   * speaker a moment to fall silent before the microphone opens, which is the
   * cheap half of echo suppression.
   */
  function arm(delay: number) {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    armTimerRef.current = null;
    if (phaseRef.current === null) return;

    go('listening');
    wantMicRef.current = true;
    armTimerRef.current = setTimeout(() => {
      armTimerRef.current = null;
      // Hung up, or the assistant took the turn back, while this was pending.
      if (!wantMicRef.current || phaseRef.current !== 'listening') return;
      micOpenedRef.current = false;
      micErrorRef.current = null;
      mic.start();
    }, delay);
  }

  /** Our turn: shut the microphone and cancel any pending re-open. */
  function disarm() {
    wantMicRef.current = false;
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    armTimerRef.current = null;
    mic.stop();
  }

  /**
   * End the call. Every route out of it lands here — the 통화 종료 button, the
   * close button, the scrim, Escape, the sheet closing underneath us, unmount,
   * and the two ways the call gives up on itself.
   *
   * `go(null)` comes FIRST and is the reason this is safe to call from anywhere:
   * the stops below make the backends fire their end events, and every tap
   * checks the phase before doing anything. A dead phase makes them all no-ops,
   * so hanging up cannot restart the microphone it is closing.
   */
  function hangUp(notice: string | null = null) {
    go(null);
    voiceTurnRef.current = false;
    disarm();
    voice.stop();
    setSilence(0);
    setCallNotice(notice);
    // 통화 종료 is unmounting under the user's thumb; without this, focus is left
    // on a button that no longer exists and the next Tab starts from the top of
    // the document. It lands on the call button rather than the composer for two
    // reasons: it is the same control in the same place, only inverted, and
    // focusing a textarea instead would raise the on-screen keyboard — which a
    // hang-up the call decided on its own has no business doing. Runs a frame
    // late because the composer has not been drawn yet, and no-ops if the sheet
    // is on its way out too.
    requestAnimationFrame(() => callButtonRef.current?.focus());
  }

  /**
   * Start the call. `mic.start()` is called straight from the click, not out of
   * a timer, because this is the moment the browser may raise its permission
   * prompt and that prompt belongs to the user's own gesture.
   */
  function startCall() {
    if (!mic.supported || phaseRef.current !== null) return;
    voice.stop();
    setCallNotice(null);
    setSilence(0);
    failedArmsRef.current = 0;
    micOpenedRef.current = false;
    micErrorRef.current = null;
    voiceTurnRef.current = false;
    go('connecting');
    wantMicRef.current = true;
    mic.start();
  }

  /**
   * Barge-in. A tap on the call surface while the assistant is talking stops it
   * and hands the turn back immediately.
   *
   * This is what replaces acoustic echo cancellation, which the Web Speech API
   * does not give us. Without an interrupt, half-duplex would mean sitting
   * through an answer you have already heard enough of; with it, the microphone
   * is still never open while the speaker is, and the user decides when the
   * assistant's turn is over. `arm` re-opens the line here rather than waiting
   * for the utterance's own end event, because a stopped ElevenLabs clip does
   * not always report one.
   */
  function bargeIn() {
    if (phaseRef.current !== 'speaking') return;
    voiceTurnRef.current = false;
    voice.stop();
    setSilence(0);
    arm(0);
    // The barge-in control unmounts with this tap. Park focus somewhere real.
    hangUpRef.current?.focus();
  }

  /**
   * The three recogniser taps and the two synthesizer taps, republished every
   * render so they close over current state. This is a latest-callback ref, the
   * same device `use-text-to-speech.ts` uses for its options — it stores
   * functions, it does not read state and write it back.
   */
  useEffect(() => {
    tapsRef.current = {
      /** The microphone is genuinely open now. */
      onOpen: () => {
        if (phaseRef.current === null) return;
        micOpenedRef.current = true;
        failedArmsRef.current = 0;
        if (phaseRef.current === 'connecting') go('listening');
      },

      /** A session ended. This is the turn boundary, and the restart point. */
      onSettled: (text) => {
        // Our own stop(): muting for the answer, or hanging up. Not a turn.
        if (!wantMicRef.current || phaseRef.current === null) return;

        const said = text.trim();
        if (said) {
          setSilence(0);
          void send(said);
          return;
        }

        // Nothing heard. Either the engine never woke up, or it did and the room
        // was quiet — and those two want opposite responses.
        const code = micErrorRef.current?.code;
        const refused =
          !micOpenedRef.current || (code !== undefined && code !== 'no-speech' && code !== 'aborted');

        if (refused) {
          failedArmsRef.current += 1;
          if (failedArmsRef.current >= FAILED_ARMS_LIMIT) {
            hangUp('마이크를 계속 열지 못해서 통화를 끊었어요.');
            return;
          }
          arm(REARM_AFTER_FAILURE_MS);
          return;
        }

        const rounds = silence + 1;
        setSilence(rounds);
        if (rounds >= SILENT_HANGUP) {
          hangUp('한참 아무 말이 없어서 통화를 끊었어요. 다시 걸면 돼요.');
          return;
        }
        arm(REARM_MS);
      },

      /**
       * Only the two failures a restart cannot fix end the call here. Everything
       * else is left to `onSettled`, which fires immediately after and already
       * knows how to back off.
       */
      onFail: (error) => {
        micErrorRef.current = error;
        if (phaseRef.current === null) return;
        if (error.code === 'not-allowed') {
          hangUp('마이크가 차단되어 있어요. 주소창의 자물쇠에서 허용해 주세요.');
        } else if (error.code === 'not-supported') {
          hangUp('이 브라우저는 음성 인식을 지원하지 않아요.');
        }
      },

      /** The answer is audible. Only now does the sheet claim to be talking. */
      onAudioStart: () => {
        if (!voiceTurnRef.current || phaseRef.current === null) return;
        go('speaking');
      },

      /**
       * The answer finished — or never started, which is the same thing for
       * turn-taking and is how a call survives a browser with no voice at all.
       */
      onAudioEnd: () => {
        if (!voiceTurnRef.current) return;
        voiceTurnRef.current = false;
        if (phaseRef.current === null) return;
        arm(REARM_MS);
      },
    };
  });

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
    // Dismissal, not cleanup, and it has to be here rather than only in an
    // unmount effect: the hooks live above the `!open` early return, so closing
    // the sheet does not unmount them. Left out, a closed sheet keeps talking to
    // a room that has moved on, and the microphone stays open behind a screen
    // the user believes they left. Escape and the scrim reach this too.
    hangUp();
    setBusy(false);
    setStatus(null);
    returnFocusTo.current?.focus();
    onClose();
  }

  const micStop = mic.stop;
  const voiceStop = voice.stop;

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

      // THE BACKSTOP, and the one teardown path the buttons cannot cover. Every
      // dismissal the user performs goes through `close()`, but `open` is a
      // prop: a parent can flip it, a route can change, this component can
      // unmount. None of those call anything of ours, and all of them would
      // otherwise leave a live microphone behind a sheet that is gone.
      //
      // Written out rather than calling `hangUp()` so this cleanup depends only
      // on stable things and cannot itself become a reason the effect re-runs.
      phaseRef.current = null;
      wantMicRef.current = false;
      voiceTurnRef.current = false;
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
      micStop();
      voiceStop();
      setPhase(null);
    };
  }, [open, micStop, voiceStop]);

  /* ── Scroll ──────────────────────────────────────────────────────────────── */

  const stickToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(stickToBottom, [turns, status, stickToBottom]);

  /* ── Sending ─────────────────────────────────────────────────────────────── */

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    // Asking the next question ends the last answer and closes the microphone.
    // On a call `disarm` is also what makes the next half of the turn silent:
    // the microphone stays shut from here until the answer has finished being
    // read, which is why the assistant never hears itself.
    // Disowned BEFORE the stop, not after: stopping makes the synthesizer fire
    // its end event, and an end event that still belongs to us would re-open the
    // microphone for a turn we are in the middle of replacing.
    voiceTurnRef.current = false;
    voice.stop();
    if (phaseRef.current !== null) {
      disarm();
      go('thinking');
    } else {
      mic.stop();
    }

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
       * `text` delta, and only on a call.
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
       * A live phase gates it on the question having been ASKED aloud. A user
       * who typed is not expecting the room to hear the reply, and someone who
       * hung up mid-turn still gets their answer in writing. `aborted` gates out
       * a closed sheet: `close()` aborts and stops the voice, and without this
       * check the answer would start talking a moment afterwards.
       *
       * The phase stays `thinking` from here until audio is actually audible —
       * `onAudioStart` moves it — so the sheet never claims to be talking during
       * the gap where a hosted voice is still being fetched. If speech fails
       * outright, `onAudioEnd` fires anyway and the call carries on listening.
       */
      if (phaseRef.current !== null && !controller.signal.aborted) {
        if (answer) {
          voiceTurnRef.current = true;
          voice.speak(answer);
        } else {
          arm(REARM_MS);
        }
      }
    }
  }

  if (!open) return null;

  const avatar = mbti && isMbtiType(mbti) ? mbtiImage(mbti) : null;
  const empty = turns.length === 0;
  const calling = phase !== null;

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
        <Header avatar={avatar} mbti={mbti} calling={calling} onClose={close} />

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollerRef}
            className="flex-1 overflow-y-auto px-[var(--gutter)] pb-[var(--space-11)]"
          >
            {empty ? (
              <Intro displayName={displayName} onPick={(s) => void send(s)} />
            ) : (
              <ol className="flex flex-col gap-[var(--space-13)] pt-[var(--space-13)]">
                {turns.map((t) => (
                  <Bubble key={t.id} turn={t} avatar={avatar} />
                ))}
              </ol>
            )}

            {/* Status is the only thing on screen during a tool call, so it is
                announced rather than just drawn. `polite`, not `assertive` — it
                updates several times a turn and must not interrupt.

                Suppressed on a call: the call panel is already saying this, and
                two live regions announcing the same sentence is worse than one. */}
            {status && !calling ? (
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

          {/* BARGE-IN, as a tap anywhere on the conversation while the assistant
              is talking. The scrim's device: a full-size button that is
              `aria-hidden` and not a tab stop, because the labelled, keyboard-
              reachable version of this exact action is in the panel below and a
              second tab stop with no name would only be in the way.

              It does cover the source links for as long as the answer plays.
              That is the right trade — while it is talking your two options are
              listen or interrupt, and this is the interrupt. */}
          {phase === 'speaking' ? (
            <button aria-hidden tabIndex={-1} onClick={bargeIn} className="absolute inset-0" />
          ) : null}
        </div>

        {/* One or the other, never both. A call takes the composer's place
            rather than sitting above it: you cannot type and hold a call at the
            same time, and a text field down there would raise the keyboard over
            the only two controls that matter while the line is open. */}
        {phase !== null ? (
          <CallPanel
            phase={phase}
            heard={mic.transcript}
            status={status}
            silence={silence}
            hangUpRef={hangUpRef}
            onBargeIn={bargeIn}
            onHangUp={() => hangUp()}
          />
        ) : (
          <Composer
            ref={inputRef}
            callRef={callButtonRef}
            value={input}
            onChange={setInput}
            onSend={() => void send(input)}
            busy={busy}
            call={{
              // No button at all rather than a disabled one. Web Speech is
              // Chromium-strong and absent in Firefox, and a dead control there
              // would invite a tap and then explain nothing — this is a touch
              // design with no hover vocabulary to hang a reason on, and
              // "use a different browser" is not an action available inside the
              // app. The sheet is fully usable by typing, so the honest move is
              // to not advertise a capability this browser does not have.
              available: mic.supported,
              notice: callNotice,
              onStart: startCall,
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ── Header ───────────────────────────────────────────────────────────────── */

function Header({
  avatar,
  mbti,
  calling,
  onClose,
}: {
  avatar: string | null;
  mbti: string | null;
  calling: boolean;
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
            the user. The agent is told the same thing in as many words.

            On a call this line says so instead. The panel at the bottom carries
            the turn, but the header is what someone glancing at the top of the
            sheet reads, and "통화 중" is the one word that explains why the
            composer has gone. */}
        <p className="text-secondary" style={{ font: 'var(--type-byline)' }}>
          {calling ? '통화 중' : mbti ? `${mbti} 얼굴을 하고 있어요` : '저장한 곳을 보고 답해요'}
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

type CallControl = {
  /** The browser can hear at all. False hides the call button entirely. */
  available: boolean;
  /** Why the last call ended, when it ended by itself. One line, or null. */
  notice: string | null;
  onStart: () => void;
};

function Composer({
  ref,
  callRef,
  value,
  onChange,
  onSend,
  busy,
  call,
}: {
  ref: React.RefObject<HTMLTextAreaElement | null>;
  /** Handed straight to the call button. Where focus lands when a call ends. */
  callRef: React.RefObject<HTMLButtonElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  call: CallControl;
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
      {/* Why the last call ended, when it ended on its own. Announced rather
          than just drawn, because the person it is for is the one who was not
          looking at the screen.

          Always mounted, never conditional. A live region that appears at the
          same moment as its first content is usually announced by nothing —
          screen readers watch regions that were already there. Empty it is a
          flex box with no children, so it is also zero pixels tall. */}
      <p
        aria-live="polite"
        className={`flex items-center gap-[var(--space-7)] text-secondary ${
          call.notice ? 'mb-[var(--space-8)]' : ''
        }`}
        style={{ font: 'var(--type-meta)' }}
      >
        {call.notice}
      </p>

      <div className="flex items-end gap-[var(--space-7)]">
        {call.available ? <CallButton ref={callRef} onStart={call.onStart} busy={busy} /> : null}

        <textarea
          ref={ref}
          rows={1}
          value={value}
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
 * The one voice affordance, and it starts a CALL rather than a dictation.
 *
 * Quiet chrome, not a second send button: transparent on `secondary`, the same
 * treatment the close button uses. Starting a call is not the primary action of
 * this screen — typing is — and the ink fill is already spoken for by send.
 * Disabled only while a turn is in flight, matching the send button.
 */
function CallButton({
  ref,
  onStart,
  busy,
}: {
  ref: React.RefObject<HTMLButtonElement | null>;
  onStart: () => void;
  busy: boolean;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onStart}
      disabled={busy}
      aria-label="음성으로 통화하기"
      className="grid h-[var(--tap-min)] w-[var(--tap-min)] shrink-0 place-items-center
                 rounded-[var(--radius-circle)] text-secondary transition-opacity duration-200
                 active:opacity-[var(--press-opacity)] disabled:opacity-40"
    >
      <Phone />
    </button>
  );
}

/* ── Call surface ─────────────────────────────────────────────────────────── */

/**
 * What a call looks like. It replaces the composer, and it answers exactly one
 * question at a time: whose turn is it.
 *
 * THE INDICATOR IS THE TRANSCRIPT. There is no waveform here, and that is a
 * decision rather than an omission — the Web Speech API hands us recognised
 * text, not audio levels, so any bar that bounced would be an animation
 * pretending to be a measurement. What we DO have is the words as they are
 * recognised, which is a truthful, high-resolution signal of exactly the thing
 * the user is anxious about: is this hearing me. So the detail line under
 * "듣는 중" is the live transcript, and the only moving part in the whole panel
 * is a dot that pulses while the line is ours to wait on.
 *
 * ONE TINTED SURFACE, no border and no shadow, per the depth budget. The panel
 * separates from the conversation by the same hairline the composer used.
 */
function CallPanel({
  phase,
  heard,
  status,
  silence,
  hangUpRef,
  onBargeIn,
  onHangUp,
}: {
  phase: CallPhase;
  /** The live transcript. Derived from the recogniser, never copied into state. */
  heard: string;
  /** The turn's tool status, when there is one: "블로그 찾는 중" beats "생각 중". */
  status: string | null;
  silence: number;
  hangUpRef: React.RefObject<HTMLButtonElement | null>;
  onBargeIn: () => void;
  onHangUp: () => void;
}) {
  const label =
    phase === 'connecting'
      ? '연결 중'
      : phase === 'listening'
        ? '듣는 중'
        : phase === 'thinking'
          ? (status ?? '생각 중')
          : '말하는 중';

  // Each of these says what is true AND what happens next, because a call has no
  // affordances to read: the only way to know the microphone shuts while the
  // assistant talks is to be told, and being told once is enough.
  const detail =
    phase === 'connecting'
      ? '마이크를 여는 중이에요'
      : phase === 'listening'
        ? heard ||
          (silence >= SILENT_HINT
            ? '아직 듣고 있어요. 편하게 말씀하세요'
            : '말씀하세요. 다 듣고 대답할게요')
        : phase === 'thinking'
          ? '마이크는 잠깐 꺼 뒀어요'
          : '끝나면 다시 들을게요';

  return (
    <div
      className="border-t border-divider bg-canvas px-[var(--gutter)] pt-[var(--space-11)]
                 pb-[calc(var(--space-11)+env(safe-area-inset-bottom))]"
    >
      <div className="rounded-[var(--radius-2xl)] bg-surface-1 p-[var(--space-11)]">
        {/* `role="status"` as well as `aria-live`: this is the one line that
            tells a screen-reader user whose turn it is, and it is the only
            polite region on screen during a call. */}
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-[var(--space-7)]"
          style={{ font: 'var(--type-card-title)' }}
        >
          {phase === 'speaking' ? <Dot /> : <Pulse />}
          {label}
        </p>

        {/* Reserves its own line so the panel does not jump as words arrive. */}
        <p
          className="mt-[var(--space-4)] min-h-[var(--meta-lh)] text-secondary"
          style={{ font: 'var(--type-meta)' }}
        >
          {detail}
        </p>
      </div>

      {/* Only while it is talking, because it is only true then. This is the
          keyboard and screen-reader route to the interrupt; the tap-anywhere
          version of the same action is the overlay on the conversation. */}
      {phase === 'speaking' ? (
        <Button
          variant="secondary"
          className="mt-[var(--space-8)] w-full"
          onClick={onBargeIn}
        >
          말 끊고 말하기
        </Button>
      ) : null}

      {/* THE CALL MUST VISIBLY END, and this is that control: always present,
          always in the same place, ink-filled because ending the call is the
          only decision the user still owns while it runs. `autoFocus` because
          the composer it replaced held the focus a moment ago, and a sheet with
          focus on nothing sends the next Tab to the top of the document. */}
      <Button
        ref={hangUpRef}
        autoFocus
        variant="primary"
        className="mt-[var(--space-8)] w-full"
        onClick={onHangUp}
      >
        통화 종료
      </Button>
    </div>
  );
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

/**
 * A handset, not a microphone. The distinction is the whole feature: a
 * microphone glyph promises dictation — press, talk, watch your words appear —
 * and what this button actually does is place a call you then have to end.
 */
function Phone() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
      <path
        d="M5.4 3.8h2.9l1.5 3.6-1.9 1.4a11.2 11.2 0 0 0 5.3 5.3l1.4-1.9 3.6 1.5v2.9a2 2 0 0 1-2.2 2A14.6 14.6 0 0 1 3.4 6a2 2 0 0 1 2-2.2Z"
        {...stroke}
      />
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

/**
 * The same dot, still. It marks the assistant's own turn, where the sound IS the
 * feedback and a pulsing light beside it would only be decoration competing with
 * it. Pulse means we are waiting on something; this means we are not.
 */
function Dot() {
  return <span aria-hidden className="h-[6px] w-[6px] rounded-[var(--radius-circle)] bg-ink" />;
}
