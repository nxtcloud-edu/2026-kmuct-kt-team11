/**
 * Speech module. Import from here.
 *
 *   useSpeechToText  — voice → text (browser, on-device)
 *   useTextToSpeech  — text → voice (ElevenLabs, via our server route)
 *
 * Teammates usually need only the two hooks. The rest is exported for
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

/* ---- Text-to-speech (text → voice). The mirror of the above. ---- */

export { useTextToSpeech } from './use-text-to-speech';
export type { UseTextToSpeechOptions } from './use-text-to-speech';

export { BrowserSynthesizer } from './browser-synthesizer';
export { ElevenLabsSynthesizer } from './elevenlabs-synthesizer';

/**
 * `preferredSynthesizer()` is what a product surface should pass to
 * `useTextToSpeech`: the on-device voice, plus the hosted one when it is both
 * opted into and actually usable. Reach for a concrete backend only in a demo.
 */
export { preferredSynthesizer, FallbackSynthesizer } from './fallback-synthesizer';

export type {
  SpeechSynthesizer,
  SpeechSynthesizerHandlers,
  SpeechSynthesizerOptions,
  SynthesisError,
  SynthesisErrorCode,
} from './synthesizer';
