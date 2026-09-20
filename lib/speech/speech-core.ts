/**
 * Framework-agnostic speech-to-text core.
 *
 * Holds session state (listening flag, final + interim transcript, last error)
 * over ANY `SpeechRecognizer`, and notifies subscribers when that state changes.
 * No React here — the hook (use-speech-to-text.ts) is a thin adapter onto this,
 * and non-React callers (a plain script, a test) can use the core directly.
 *
 * Accumulation model: `finalTranscript` grows as the backend settles chunks;
 * `interimTranscript` is the not-yet-settled tail. `transcript` is the two
 * joined — the thing most consumers actually want.
 */

import type { SpeechError, SpeechRecognizer, SpeechRecognizerOptions } from './recognizer';

export type SpeechState = {
  /** A session is currently active. */
  listening: boolean;
  /** Settled text accumulated across the session. */
  finalTranscript: string;
  /** Current unsettled tail (may be revised or promoted to final). */
  interimTranscript: string;
  /** finalTranscript + interimTranscript, trimmed — the full best-effort text. */
  transcript: string;
  /** Last error this session, or null. */
  error: SpeechError | null;
  /** True if the underlying backend can run here. */
  supported: boolean;
};

export type SpeechStateListener = (state: SpeechState) => void;

function join(final: string, interim: string): string {
  return [final, interim].filter(Boolean).join(' ').trim();
}

export class SpeechCore {
  private recognizer: SpeechRecognizer;
  private listeners = new Set<SpeechStateListener>();
  private state: SpeechState;

  constructor(recognizer: SpeechRecognizer) {
    this.recognizer = recognizer;
    this.state = {
      listening: false,
      finalTranscript: '',
      interimTranscript: '',
      transcript: '',
      error: null,
      supported: recognizer.isSupported(),
    };
  }

  getState(): SpeechState {
    return this.state;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: SpeechStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<SpeechState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Begin listening. Clears the previous transcript and error. */
  start(options?: SpeechRecognizerOptions): void {
    if (this.state.listening) return;
    this.setState({
      listening: true,
      finalTranscript: '',
      interimTranscript: '',
      transcript: '',
      error: null,
    });

    this.recognizer.start(
      {
        onResult: ({ transcript, isFinal }) => {
          if (isFinal) {
            const final = join(this.state.finalTranscript, transcript);
            this.setState({
              finalTranscript: final,
              interimTranscript: '',
              transcript: final,
            });
          } else {
            this.setState({
              interimTranscript: transcript,
              transcript: join(this.state.finalTranscript, transcript),
            });
          }
        },
        onError: (error) => this.setState({ error }),
        onEnd: () => {
          // Fold any dangling interim text into final so nothing is lost.
          const final = join(this.state.finalTranscript, this.state.interimTranscript);
          this.setState({
            listening: false,
            finalTranscript: final,
            interimTranscript: '',
            transcript: final,
          });
        },
      },
      options,
    );
  }

  /** Stop listening. `onEnd` from the backend settles the final state. */
  stop(): void {
    if (!this.state.listening) return;
    this.recognizer.stop();
  }

  /** Clear transcript and error without touching a live session. */
  reset(): void {
    this.setState({
      finalTranscript: '',
      interimTranscript: '',
      transcript: '',
      error: null,
    });
  }
}
