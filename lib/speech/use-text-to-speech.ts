'use client';

/**
 * Thin React hook over a `SpeechSynthesizer` — the part teammates use.
 *
 *   const { speak, stop, speaking, supported, error } = useTextToSpeech();
 *   ...
 *   speak(modelText); // reads it aloud
 *
 * No UI here on purpose. A teammate calls speak() with whatever text the model
 * produces and, if they want, renders a play/stop affordance off `speaking`.
 * The model output is not wired yet; this hook does not care — the day someone
 * has model text, they pass it to speak() and nothing here changes.
 *
 * Default backend is the browser's built-in voice (free, on-device, no key).
 * To use ElevenLabs instead (needs a paid plan + server key), pass a
 * `new ElevenLabsSynthesizer()` as `synthesizer`; the hook and every consumer
 * are unaffected.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserSynthesizer } from './browser-synthesizer';
import type { SpeechSynthesizer, SynthesisError } from './synthesizer';

export type UseTextToSpeechOptions = {
  /** Backend to use. Defaults to the free on-device browser voice. */
  synthesizer?: SpeechSynthesizer;
  /** BCP-47 language, default "ko-KR". */
  lang?: string;
  /** Voice override (browser voice name, or ElevenLabs voice id). */
  voiceId?: string;
  /** Model override (ElevenLabs only). */
  modelId?: string;
  /** Speaking rate for the browser backend (1 = normal). */
  rate?: number;
  /** Pitch for the browser backend (1 = normal). */
  pitch?: number;
};

export function useTextToSpeech(options: UseTextToSpeechOptions = {}) {
  const { synthesizer, lang = 'ko-KR', voiceId, modelId, rate, pitch } = options;

  // One synthesizer per hook instance, created once via lazy init. Kept in state
  // (not a ref) so `supported` can be derived here without reading a ref during
  // render — the instance is stable and never replaced while mounted.
  const [{ synth, supported }] = useState(() => {
    const instance = synthesizer ?? new BrowserSynthesizer();
    return { synth: instance, supported: instance.isSupported() };
  });

  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<SynthesisError | null>(null);

  // Latest option values, read at speak() time without re-creating the callback.
  const optsRef = useRef({ lang, voiceId, modelId, rate, pitch });
  useEffect(() => {
    optsRef.current = { lang, voiceId, modelId, rate, pitch };
  }, [lang, voiceId, modelId, rate, pitch]);

  const stop = useCallback(() => {
    synth.stop();
    setSpeaking(false);
  }, [synth]);

  const speak = useCallback(
    (text: string) => {
      if (!text?.trim()) return;
      setError(null);
      synth.speak(
        text,
        {
          onStart: () => setSpeaking(true),
          onEnd: () => setSpeaking(false),
          onError: (err) => setError(err),
        },
        optsRef.current,
      );
    },
    [synth],
  );

  // Stop any speech when the consumer unmounts.
  useEffect(() => {
    return () => synth.stop();
  }, [synth]);

  return {
    /** Read `text` aloud. Interrupts anything already speaking. */
    speak,
    /** Stop speaking. */
    stop,
    /** Audio is currently playing. */
    speaking,
    /** Backend usable in this environment. Gate your play button on this. */
    supported,
    /** Last error, or null. */
    error,
  };
}
