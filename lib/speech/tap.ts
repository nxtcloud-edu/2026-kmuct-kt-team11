/**
 * Taps — listening in on a speech backend without becoming one.
 *
 * Both hooks in this module expose STATE (`listening`, `speaking`, `transcript`)
 * and state is the wrong shape for a call. A call is a sequence of EVENTS —
 * "the microphone opened", "that was a whole turn", "the answer finished
 * playing" — and each one is the cue for the next thing to happen. Reading them
 * back out of React state means an effect that watches a boolean flip, guesses
 * which flip it is, and fires an action; with a restart loop on the other end
 * that is the exact shape that turns into a tight loop.
 *
 * So these two decorators sit between the hook and the real backend and hand the
 * events straight to the caller. They recognise nothing and synthesise nothing —
 * every call is forwarded to `inner` untouched, which is why the ElevenLabs →
 * browser fallback keeps working underneath one unchanged.
 *
 * The tap is passed as a GETTER, not an object. The hooks build their backend
 * once and keep it for their whole lifetime, while the component's handlers are
 * new closures every render; a getter lets the component swap them freely
 * without rebuilding the engine (and losing the session with it).
 */

import type {
  SpeechError,
  SpeechRecognizer,
  SpeechRecognizerHandlers,
  SpeechRecognizerOptions,
} from './recognizer';
import type {
  SpeechSynthesizer,
  SpeechSynthesizerHandlers,
  SpeechSynthesizerOptions,
} from './synthesizer';

export type RecognizerTap = {
  /** The engine actually opened the microphone. Not the same as `start()`. */
  onOpen?: () => void;
  /**
   * A session ended, for any reason, with everything it heard. Empty is the
   * ordinary case, not an error: `continuous = false` means the engine ends a
   * session on a pause whether or not anyone spoke.
   */
  onSettled?: (text: string) => void;
  onFail?: (error: SpeechError) => void;
};

export type SynthesizerTap = {
  /** Audio actually began. */
  onAudioStart?: () => void;
  /** Audio finished, was stopped, or never managed to start. Fires once. */
  onAudioEnd?: () => void;
};

/** `final` + a dangling `interim`, joined the way SpeechCore joins them. */
function join(final: string, interim: string): string {
  return [final, interim].filter(Boolean).join(' ').trim();
}

class TappedRecognizer implements SpeechRecognizer {
  constructor(
    private readonly inner: SpeechRecognizer,
    private readonly tap: () => RecognizerTap,
  ) {}

  isSupported(): boolean {
    return this.inner.isSupported();
  }

  start(handlers: SpeechRecognizerHandlers, options?: SpeechRecognizerOptions): void {
    // This session's own text, accumulated here rather than read back off the
    // hook: at the instant a session ends the hook's transcript is one render
    // away from being right, and the turn boundary is exactly that instant.
    let final = '';
    let interim = '';

    this.inner.start(
      {
        onStart: () => {
          handlers.onStart?.();
          this.tap().onOpen?.();
        },
        onResult: (result) => {
          if (result.isFinal) {
            final = join(final, result.transcript);
            interim = '';
          } else {
            interim = result.transcript;
          }
          handlers.onResult?.(result);
        },
        onError: (error) => {
          handlers.onError?.(error);
          this.tap().onFail?.(error);
        },
        // Inner handler FIRST, always. `SpeechCore.onEnd` is what clears its
        // `listening` flag, and `SpeechCore.start()` refuses to open a session
        // while that flag is set — so a tap that restarted before it ran would
        // be silently ignored and the call would go deaf.
        onEnd: () => {
          handlers.onEnd?.();
          this.tap().onSettled?.(join(final, interim));
        },
      },
      options,
    );
  }

  stop(): void {
    this.inner.stop();
  }
}

class TappedSynthesizer implements SpeechSynthesizer {
  constructor(
    private readonly inner: SpeechSynthesizer,
    private readonly tap: () => SynthesizerTap,
  ) {}

  isSupported(): boolean {
    return this.inner.isSupported();
  }

  speak(
    text: string,
    handlers: SpeechSynthesizerHandlers,
    options?: SpeechSynthesizerOptions,
  ): void {
    this.inner.speak(
      text,
      {
        onStart: () => {
          handlers.onStart?.();
          this.tap().onAudioStart?.();
        },
        onError: handlers.onError,
        onEnd: () => {
          handlers.onEnd?.();
          this.tap().onAudioEnd?.();
        },
      },
      options,
    );
  }

  stop(): void {
    this.inner.stop();
  }
}

export function tapRecognizer(inner: SpeechRecognizer, tap: () => RecognizerTap): SpeechRecognizer {
  return new TappedRecognizer(inner, tap);
}

export function tapSynthesizer(
  inner: SpeechSynthesizer,
  tap: () => SynthesizerTap,
): SpeechSynthesizer {
  return new TappedSynthesizer(inner, tap);
}
