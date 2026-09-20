'use client';

/**
 * Thin React adapter over `SpeechCore`. This is the part teammates use.
 *
 *   const { listening, transcript, start, stop, reset, supported, error }
 *     = useSpeechToText();
 *
 * The hook owns no logic of its own — it wires `SpeechCore`'s state into React
 * via useSyncExternalStore and exposes stable callbacks. Swapping the STT
 * backend (browser → ElevenLabs) happens by passing a different recognizer;
 * this hook, and every component using it, is unaffected.
 *
 * No UI here on purpose: teammates build whatever button/mic affordance they
 * want and call start()/stop(). The hook only produces state and actions.
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { SpeechCore } from './speech-core';
import { BrowserRecognizer } from './browser-recognizer';
import type { SpeechRecognizer, SpeechRecognizerOptions } from './recognizer';

export type UseSpeechToTextOptions = SpeechRecognizerOptions & {
  /**
   * Backend to use. Defaults to the on-device browser recognizer. Pass a
   * different `SpeechRecognizer` (e.g. a future ElevenLabs one) to swap engines
   * without changing any consumer.
   */
  recognizer?: SpeechRecognizer;
};

export function useSpeechToText(options: UseSpeechToTextOptions = {}) {
  const { recognizer, lang, interimResults } = options;

  // One SpeechCore per hook instance, created once. A caller-supplied recognizer
  // is honoured on first render; changing it later is intentionally ignored to
  // keep the session stable (remount the consumer to change backends).
  const coreRef = useRef<SpeechCore | null>(null);
  if (coreRef.current === null) {
    coreRef.current = new SpeechCore(recognizer ?? new BrowserRecognizer());
  }
  const core = coreRef.current;

  // useSyncExternalStore keeps React in sync with the external SpeechCore store.
  const state = useSyncExternalStore(
    useCallback((onChange) => core.subscribe(onChange), [core]),
    () => core.getState(),
    () => core.getState(), // server snapshot: same shape, supported=false there
  );

  const startOptions = useMemo<SpeechRecognizerOptions>(
    () => ({ lang, interimResults }),
    [lang, interimResults],
  );

  const start = useCallback(() => core.start(startOptions), [core, startOptions]);
  const stop = useCallback(() => core.stop(), [core]);
  const reset = useCallback(() => core.reset(), [core]);

  return {
    /** A session is active. */
    listening: state.listening,
    /** Best-effort full text (final + interim). */
    transcript: state.transcript,
    /** Only the settled text. */
    finalTranscript: state.finalTranscript,
    /** Only the unsettled tail. */
    interimTranscript: state.interimTranscript,
    /** Backend usable in this environment. Gate your mic button on this. */
    supported: state.supported,
    /** Last error, or null. */
    error: state.error,
    start,
    stop,
    reset,
  };
}
