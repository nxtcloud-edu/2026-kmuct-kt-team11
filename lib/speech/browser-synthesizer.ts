/**
 * The default TTS backend: the browser's built-in SpeechSynthesis API
 * (window.speechSynthesis). Free, on-device, no server, no key — the mirror of
 * BrowserRecognizer on the STT side.
 *
 * It owns its own playback; there is no audio file to hand back. The hook only
 * learns start/end/error through the handlers.
 */

import type {
  SpeechSynthesizer,
  SpeechSynthesizerHandlers,
  SpeechSynthesizerOptions,
} from './synthesizer';

export class BrowserSynthesizer implements SpeechSynthesizer {
  private current: SpeechSynthesisUtterance | null = null;

  isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      'speechSynthesis' in window &&
      typeof SpeechSynthesisUtterance !== 'undefined'
    );
  }

  /**
   * Pick a voice matching the requested language, or a named one if given.
   * Voices load asynchronously in some browsers; if none are ready yet we let
   * the engine choose its default (still speaks, just not our preferred voice).
   */
  private pickVoice(
    lang: string,
    voiceName?: string,
  ): SpeechSynthesisVoice | null {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return null;
    if (voiceName) {
      const named = voices.find((v) => v.name === voiceName);
      if (named) return named;
    }
    const exact = voices.find((v) => v.lang === lang);
    if (exact) return exact;
    const prefix = lang.split('-')[0];
    return voices.find((v) => v.lang.startsWith(prefix)) ?? null;
  }

  speak(
    text: string,
    handlers: SpeechSynthesizerHandlers,
    options: SpeechSynthesizerOptions = {},
  ): void {
    if (!this.isSupported()) {
      handlers.onError?.({ code: 'not-supported', message: '이 브라우저는 음성 출력을 지원하지 않습니다.' });
      handlers.onEnd?.();
      return;
    }

    // Cancel anything already speaking so utterances do not queue up.
    window.speechSynthesis.cancel();

    const lang = options.lang ?? 'ko-KR';
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    if (options.rate != null) utterance.rate = options.rate;
    if (options.pitch != null) utterance.pitch = options.pitch;
    const voice = this.pickVoice(lang, options.voiceId);
    if (voice) utterance.voice = voice;

    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.current = null;
      handlers.onEnd?.();
    };

    utterance.onstart = () => handlers.onStart?.();
    utterance.onend = () => end();
    utterance.onerror = (e) => {
      // 'interrupted'/'canceled' happen on our own stop() — not real errors.
      const reason = (e as SpeechSynthesisErrorEvent).error;
      if (reason !== 'interrupted' && reason !== 'canceled') {
        handlers.onError?.({ code: 'failed', message: '음성을 재생하지 못했어요.' });
      }
      end();
    };

    this.current = utterance;
    window.speechSynthesis.speak(utterance);
  }

  stop(): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    this.current = null;
    window.speechSynthesis.cancel();
  }
}
