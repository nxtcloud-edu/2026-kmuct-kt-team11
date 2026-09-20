/**
 * The text-to-speech boundary — the mirror image of recognizer.ts.
 *
 * This is the contract every TTS backend implements. It exists for the same
 * reason the STT one does: the backends we care about live in different places
 * and play audio in fundamentally different ways.
 *
 *   - Browser (SpeechSynthesis API): speaks on-device, no server, no key, free.
 *     It owns its own playback — you cannot get an audio file out of it. (default)
 *   - ElevenLabs: text is POSTed to OUR server route (app/api/tts), which holds
 *     the secret key and returns audio the backend then plays. Needs a paid plan.
 *
 * Because one backend hands back a file and the other only ever plays, the
 * contract is "speak, and tell me when you start/finish/fail" — not "give me a
 * Blob". Each backend owns playback; the hook just reflects the state. This
 * mirrors how `SpeechRecognizer` drives the STT hook through handlers.
 *
 * "Swap the engine later" only holds if callers depend on THIS interface, never
 * on a concrete backend. The hook (use-text-to-speech.ts) is written against
 * `SpeechSynthesizer` alone.
 */

/** Why synthesis/playback failed, so a consumer can message the user correctly. */
export type SynthesisErrorCode =
  | 'not-supported' // backend unavailable in this environment
  | 'unavailable' // server has no provider configured (503 from the route)
  | 'network' // transport failure reaching the server
  | 'failed' // upstream synthesis or playback error
  | 'aborted' // cancelled by the caller
  | 'unknown';

export type SynthesisError = {
  code: SynthesisErrorCode;
  message: string;
};

/** Options a caller may pass when speaking. */
export type SpeechSynthesizerOptions = {
  /** BCP-47 tag, e.g. "ko-KR". Used by the browser backend to pick a voice. */
  lang?: string;
  /** Override the voice for this utterance (ElevenLabs voice id, or a browser voice name). */
  voiceId?: string;
  /** Override the model for this utterance (ElevenLabs only). */
  modelId?: string;
  /** Speaking rate, 0.1–10, 1 = normal (browser backend). */
  rate?: number;
  /** Pitch, 0–2, 1 = normal (browser backend). */
  pitch?: number;
};

/**
 * Callbacks a backend drives during one utterance. All optional.
 * `onStart` fires when audio actually begins; `onEnd` fires exactly once when it
 * finishes, is stopped, or errors (so the hook can always reset its state).
 */
export type SpeechSynthesizerHandlers = {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: SynthesisError) => void;
};

/**
 * A start-able, stop-able speech backend. Deliberately tiny: it turns text into
 * spoken audio and reports progress through handlers. State and React wiring are
 * built ON this in the hook, not baked into the backend.
 */
export interface SpeechSynthesizer {
  /** True if this backend can run in the current environment. Check before speak. */
  isSupported(): boolean;
  /**
   * Speak `text`. Progress and errors arrive via `handlers`. Implementations may
   * be async internally (e.g. fetch then play); `onStart` marks audible start.
   */
  speak(
    text: string,
    handlers: SpeechSynthesizerHandlers,
    options?: SpeechSynthesizerOptions,
  ): void;
  /** Stop the current utterance. Safe to call when idle. Triggers `onEnd`. */
  stop(): void;
}
