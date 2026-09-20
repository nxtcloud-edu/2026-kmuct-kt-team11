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

/**
 * How long to wait for the voice list before giving up and letting the engine
 * pick. Chrome populates within a few dozen milliseconds; this is the ceiling on
 * how much silence a broken `voiceschanged` can cost the first answer.
 */
const VOICE_LIST_TIMEOUT_MS = 1500;

/** `ko_KR`, `ko-kr` and `ko-KR` are the same language to us, and to nobody else. */
function normalizeLang(tag: string): string {
  return tag.replace(/_/g, '-').toLowerCase();
}

export class BrowserSynthesizer implements SpeechSynthesizer {
  private current: SpeechSynthesisUtterance | null = null;
  /**
   * Bumped by every `speak()` and every `stop()`. The voice list may not exist
   * yet when `speak()` is called, so speaking can be a two-step affair with a
   * wait in the middle — and a caller who hangs up during that wait must not be
   * spoken to afterwards. The token is how the second step knows it is stale.
   */
  private generation = 0;

  isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      'speechSynthesis' in window &&
      typeof SpeechSynthesisUtterance !== 'undefined'
    );
  }

  /**
   * Pick the voice for `lang`, or a named one if the caller asked for it.
   *
   * WHY THE ORDER IS WHAT IT IS. A Korean sentence read by an English voice is
   * not a worse voice, it is unusable — the engine spells Hangul out rather than
   * reading it. So an exact `ko-KR` match wins, then anything in the `ko`
   * family, and only then do we hand the choice back to the engine.
   *
   * Among equally good matches a LOCAL voice wins. macOS/Chrome usually offers
   * both Yuna (on-device) and a Google network voice; in a call the on-device
   * one starts speaking immediately and keeps working on a bad connection, and
   * latency between turns is most of what a call feels like.
   */
  private pickVoice(lang: string, voiceName?: string): SpeechSynthesisVoice | null {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return null;

    if (voiceName) {
      const named = voices.find((v) => v.name === voiceName);
      if (named) return named;
    }

    const want = normalizeLang(lang);
    const base = want.split('-')[0];
    const exact = voices.filter((v) => normalizeLang(v.lang) === want);
    const family = voices.filter((v) => normalizeLang(v.lang).split('-')[0] === base);
    const pool = exact.length > 0 ? exact : family;
    if (pool.length === 0) return null;

    return pool.find((v) => v.localService) ?? pool[0];
  }

  /**
   * Run `then` once the voice list is usable.
   *
   * THE CLASSIC BUG THIS EXISTS FOR: `getVoices()` is empty on the first call in
   * Chrome and fills in asynchronously, announced by `voiceschanged`. Code that
   * speaks immediately therefore picks no voice at all on the very first
   * utterance — which is the one that matters, because it is the one where the
   * user finds out whether this thing speaks Korean.
   *
   * Reading `getVoices()` is also what kicks the load off, so the check is the
   * warm-up. The timeout is a floor under a browser that never fires the event:
   * speaking in the wrong voice beats not speaking.
   */
  private whenVoicesReady(then: () => void): void {
    const synth = window.speechSynthesis;
    if (synth.getVoices().length > 0) {
      then();
      return;
    }

    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      synth.removeEventListener('voiceschanged', run);
      clearTimeout(timer);
      then();
    };
    const timer = setTimeout(run, VOICE_LIST_TIMEOUT_MS);
    synth.addEventListener('voiceschanged', run);
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
    const generation = ++this.generation;
    const lang = options.lang ?? 'ko-KR';

    this.whenVoicesReady(() => {
      // Stopped, or superseded by a newer utterance, while we waited. Report the
      // end anyway: the caller is owed exactly one onEnd per speak(), and the
      // utterance that would have fired it was never created.
      if (generation !== this.generation) {
        handlers.onEnd?.();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      if (options.rate != null) utterance.rate = options.rate;
      if (options.pitch != null) utterance.pitch = options.pitch;
      // No Korean voice installed at all: leave `voice` unset and let the engine
      // try with the language tag. Degraded, but it still makes a sound, and
      // there is nothing this code can install on the user's behalf.
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
    });
  }

  stop(): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    // Invalidates a speak() that is still waiting for the voice list, which is
    // the window in which a hang-up would otherwise be followed by talking.
    this.generation++;
    this.current = null;
    window.speechSynthesis.cancel();
  }
}
