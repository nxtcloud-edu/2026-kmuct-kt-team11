/**
 * Browser backend for `SpeechRecognizer`, using the Web Speech API
 * (`SpeechRecognition` / `webkitSpeechRecognition`). Runs entirely on-device:
 * no server, no API key, no cost. Best support is in Chromium browsers, and it
 * requires a secure context (https or localhost).
 *
 * The Web Speech API is not in TypeScript's standard DOM lib, so the minimal
 * surface we use is declared locally below rather than pulling in a dependency.
 */

import type {
  SpeechRecognizer,
  SpeechRecognizerHandlers,
  SpeechRecognizerOptions,
  SpeechErrorCode,
} from './recognizer';

// ── Minimal Web Speech API typings (only what we touch) ─────────────────────
interface WSRAlternative {
  transcript: string;
}
interface WSRResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: WSRAlternative;
}
interface WSRResultList {
  readonly length: number;
  [index: number]: WSRResult;
}
interface WSREvent extends Event {
  resultIndex: number;
  results: WSRResultList;
}
interface WSRErrorEvent extends Event {
  error: string;
}
interface WSRInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: WSREvent) => void) | null;
  onerror: ((e: WSRErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type WSRConstructor = new () => WSRInstance;

function getConstructor(): WSRConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: WSRConstructor;
    webkitSpeechRecognition?: WSRConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Map the Web Speech API's error strings onto our backend-neutral codes. */
function mapErrorCode(raw: string): SpeechErrorCode {
  switch (raw) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed';
    case 'no-speech':
      return 'no-speech';
    case 'network':
      return 'network';
    case 'aborted':
      return 'aborted';
    default:
      return 'unknown';
  }
}

export class BrowserRecognizer implements SpeechRecognizer {
  private instance: WSRInstance | null = null;

  isSupported(): boolean {
    return getConstructor() !== null;
  }

  start(handlers: SpeechRecognizerHandlers, options: SpeechRecognizerOptions = {}): void {
    const Ctor = getConstructor();
    if (!Ctor) {
      handlers.onError?.({
        code: 'not-supported',
        message: '이 브라우저는 음성 인식을 지원하지 않습니다. Chrome을 권장합니다.',
      });
      handlers.onEnd?.();
      return;
    }

    // A previous session must be torn down before a new one starts.
    this.stop();

    const rec = new Ctor();
    rec.lang = options.lang ?? 'ko-KR';
    rec.interimResults = options.interimResults ?? true;
    // continuous=false: stop after a natural utterance. The core layer can
    // restart if a consumer wants long-form dictation; the backend stays simple.
    rec.continuous = false;

    rec.onresult = (e: WSREvent) => {
      // Concatenate everything from resultIndex onward into one transcript, and
      // mark final only when the last result chunk is final.
      let transcript = '';
      let isFinal = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        transcript += result[0]?.transcript ?? '';
        isFinal = result.isFinal;
      }
      handlers.onResult?.({ transcript: transcript.trim(), isFinal });
    };

    rec.onerror = (e: WSRErrorEvent) => {
      handlers.onError?.({ code: mapErrorCode(e.error), message: `음성 인식 오류: ${e.error}` });
    };

    rec.onend = () => {
      this.instance = null;
      handlers.onEnd?.();
    };

    this.instance = rec;
    try {
      rec.start();
    } catch (err) {
      // start() throws if called while already started; surface it cleanly.
      handlers.onError?.({
        code: 'unknown',
        message: err instanceof Error ? err.message : '음성 인식을 시작할 수 없습니다.',
      });
      this.instance = null;
      handlers.onEnd?.();
    }
  }

  stop(): void {
    if (!this.instance) return;
    const rec = this.instance;
    this.instance = null;
    // abort() ends immediately without emitting a final result; onend still fires.
    rec.abort();
  }
}
