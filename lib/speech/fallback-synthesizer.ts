/**
 * Not a third TTS engine — a composition of the two that already exist.
 *
 * `FallbackSynthesizer` implements `SpeechSynthesizer` by delegating to a
 * primary backend and, when that backend fails BEFORE any audio was heard,
 * re-speaking the same text through a fallback. To the hook and to every
 * consumer it is one backend; nothing above it can tell which voice answered.
 *
 * WHY THIS EXISTS. The hosted voice is an upgrade, and an upgrade must never be
 * able to cost a user their answer. In this deployment it would: the ElevenLabs
 * key authenticates and is then refused (`missing the permission
 * text_to_speech`), because it is a scoped key with its scopes switched off, and
 * the free tier returns 402 for API synthesis anyway. Both arrive as
 * `tts-unavailable` from app/api/tts and both are fixed by a person visiting a
 * dashboard — never by this code retrying. So the answer is spoken by the
 * browser instead and the user is told nothing, because nothing happened to
 * them.
 *
 * "BEFORE any audio was heard" is the whole rule. Once `onStart` has fired the
 * clip is playing; a failure after that is a playback problem, and re-speaking
 * from the top would make the user hear the first half twice. Those errors are
 * passed through untouched.
 */

import { BrowserSynthesizer } from './browser-synthesizer';
import { ElevenLabsSynthesizer } from './elevenlabs-synthesizer';
import type {
  SpeechSynthesizer,
  SpeechSynthesizerHandlers,
  SpeechSynthesizerOptions,
} from './synthesizer';

export class FallbackSynthesizer implements SpeechSynthesizer {
  /**
   * Latched for the lifetime of this instance once the primary has refused.
   * A scope or a plan does not change between two sentences, so asking again
   * every turn would only spend a doomed round-trip before every answer — and
   * that round-trip is silence the user sits through.
   */
  private demoted = false;
  /** Set by stop(), cleared by speak(). Guards the gap described in speak(). */
  private stopped = false;

  constructor(
    private readonly primary: SpeechSynthesizer,
    private readonly fallback: SpeechSynthesizer,
  ) {}

  /** Usable if EITHER half is. The fallback is the one that needs no configuration. */
  isSupported(): boolean {
    return this.primary.isSupported() || this.fallback.isSupported();
  }

  speak(
    text: string,
    handlers: SpeechSynthesizerHandlers,
    options: SpeechSynthesizerOptions = {},
  ): void {
    this.stopped = false;

    if (this.demoted || !this.primary.isSupported()) {
      this.fallback.speak(text, handlers, options);
      return;
    }

    let started = false;
    let refused = false;
    // Exactly one onEnd reaches the caller however this turns out, because the
    // hook clears `speaking` on it and a second one would clear a state the
    // fallback had just set.
    let settled = false;

    this.primary.speak(
      text,
      {
        onStart: () => {
          started = true;
          handlers.onStart?.();
        },
        onError: (error) => {
          // Audible already: a real playback error, and the caller's to show.
          if (started) {
            handlers.onError?.(error);
            return;
          }
          // Silent so far: swallow it. The user is about to be spoken to by the
          // other backend, so there is nothing here worth interrupting them with.
          refused = true;
          this.demoted = true;
        },
        onEnd: () => {
          if (settled) return;
          settled = true;

          // The primary's error and this onEnd are separate callbacks, so a
          // stop() can land between them. Without this the sheet would start
          // talking again right after the user silenced it.
          if (refused && !this.stopped && this.fallback.isSupported()) {
            this.fallback.speak(text, handlers, options);
            return;
          }

          handlers.onEnd?.();
        },
      },
      options,
    );
  }

  stop(): void {
    this.stopped = true;
    this.primary.stop();
    this.fallback.stop();
  }
}

/**
 * The backend the assistant answers with.
 *
 * The browser's on-device voice is the default and the only thing that is
 * guaranteed to work: free, offline, no key, no account, nothing to configure.
 * Voice mode ships usable on a clean checkout because of this line.
 *
 * The hosted voice is opt-in through `NEXT_PUBLIC_TTS_PROVIDER=elevenlabs`,
 * which is the only pre-flight signal available — a scoped key cannot be probed
 * for its own scopes (the same key is missing `user_read`, so even asking who it
 * belongs to fails). Without the flag nothing is sent to /api/tts at all, so no
 * user pays a round-trip for a provider nobody has set up. With it, the refusal
 * is caught once and the browser finishes the sentence.
 */
export function preferredSynthesizer(): SpeechSynthesizer {
  const browser = new BrowserSynthesizer();
  if (process.env.NEXT_PUBLIC_TTS_PROVIDER !== 'elevenlabs') return browser;
  return new FallbackSynthesizer(new ElevenLabsSynthesizer(), browser);
}
