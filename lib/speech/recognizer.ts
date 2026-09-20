/**
 * The speech-to-text boundary.
 *
 * This is the contract every STT backend implements. It exists because the two
 * backends we care about live in different places and cannot share one hook:
 *
 *   - Browser (Web Speech API): recognises on-device, no server, no key.
 *   - ElevenLabs (Scribe): records audio, POSTs it to OUR server route, which
 *     calls ElevenLabs with a secret key. A server round-trip a browser hook
 *     can never contain.
 *
 * So "swap the engine later" is only true if callers depend on THIS interface,
 * never on a concrete backend. The core (speech-core.ts) and the hook
 * (use-speech-to-text.ts) are written against `SpeechRecognizer` alone; adding
 * ElevenLabs later means writing a second implementation plus a server route,
 * with zero change to the core, the hook, or any consumer.
 */

/** Why recognition stopped, so a consumer can message the user correctly. */
export type SpeechErrorCode =
  | 'not-supported' // backend unavailable in this environment (e.g. no Web Speech API)
  | 'not-allowed' // microphone permission denied
  | 'no-speech' // nothing was heard
  | 'network' // transport failure (matters for server-backed backends)
  | 'aborted' // stopped by the caller
  | 'unknown';

export type SpeechError = {
  code: SpeechErrorCode;
  message: string;
};

/**
 * A single recognition update. `transcript` is the text so far; `isFinal` marks
 * it as settled (the backend will not revise it). Interim results let a UI show
 * live text, but a consumer that only wants the end can ignore everything until
 * `isFinal`.
 */
export type SpeechResult = {
  transcript: string;
  isFinal: boolean;
};

/** Options a caller may pass when starting recognition. */
export type SpeechRecognizerOptions = {
  /** BCP-47 tag, e.g. "ko-KR". Defaults to the backend's own default. */
  lang?: string;
  /** Emit interim (non-final) results. Default true. */
  interimResults?: boolean;
};

/**
 * Callbacks a backend drives during a session. All optional: a caller can
 * subscribe only to what it needs.
 */
export type SpeechRecognizerHandlers = {
  onResult?: (result: SpeechResult) => void;
  onError?: (error: SpeechError) => void;
  /** Fired once when a session ends, for any reason (stop, error, silence). */
  onEnd?: () => void;
};

/**
 * A start-able, stop-able recognition backend. Deliberately tiny: everything a
 * UI needs (state, latest transcript, React wiring) is built ON this in the
 * core and hook, not baked into the backend.
 */
export interface SpeechRecognizer {
  /** True if this backend can run in the current environment. Check before start. */
  isSupported(): boolean;
  /** Begin a session. Results and errors arrive via `handlers`. */
  start(handlers: SpeechRecognizerHandlers, options?: SpeechRecognizerOptions): void;
  /** End the current session. Safe to call when not running. Triggers `onEnd`. */
  stop(): void;
}
