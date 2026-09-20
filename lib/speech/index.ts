/**
 * Speech-to-text module. Import from here.
 *
 * Teammates usually need only `useSpeechToText`. The rest is exported for
 * advanced use (a non-React caller, or supplying a custom backend).
 */

export { useSpeechToText } from './use-speech-to-text';
export type { UseSpeechToTextOptions } from './use-speech-to-text';

export { SpeechCore } from './speech-core';
export type { SpeechState, SpeechStateListener } from './speech-core';

export { BrowserRecognizer } from './browser-recognizer';

export type {
  SpeechRecognizer,
  SpeechRecognizerHandlers,
  SpeechRecognizerOptions,
  SpeechResult,
  SpeechError,
  SpeechErrorCode,
} from './recognizer';
