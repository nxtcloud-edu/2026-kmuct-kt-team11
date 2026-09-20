/**
 * A TTS backend that calls our own server route (app/api/tts), which holds the
 * ElevenLabs key. This class never sees the key — it only knows the route's
 * shape. It fetches the audio, then plays it, reporting progress through the
 * same handlers the browser backend uses, so the hook cannot tell them apart.
 *
 * Needs a paid ElevenLabs plan (the free tier returns 402 for API synthesis).
 * The browser backend is the free default; this is opt-in.
 */

import type {
  SpeechSynthesizer,
  SpeechSynthesizerHandlers,
  SpeechSynthesizerOptions,
} from './synthesizer';

export class ElevenLabsSynthesizer implements SpeechSynthesizer {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly endpoint: string = '/api/tts') {}

  isSupported(): boolean {
    return (
      typeof fetch === 'function' &&
      typeof window !== 'undefined' &&
      typeof Audio !== 'undefined'
    );
  }

  private cleanup(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  speak(
    text: string,
    handlers: SpeechSynthesizerHandlers,
    options: SpeechSynthesizerOptions = {},
  ): void {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;

    void (async () => {
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            voice_id: options.voiceId,
            model_id: options.modelId,
          }),
          signal: controller.signal,
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') return handlers.onEnd?.();
        handlers.onError?.({ code: 'network', message: '서버에 연결하지 못했어요.' });
        return handlers.onEnd?.();
      }

      if (!res.ok) {
        let type = '';
        try {
          const body = await res.json();
          type = typeof body?.type === 'string' ? body.type : '';
        } catch {
          /* non-JSON error body */
        }
        if (type.endsWith('/tts-unavailable') || res.status === 503) {
          handlers.onError?.({ code: 'unavailable', message: '음성 기능이 아직 설정되지 않았어요.' });
        } else {
          handlers.onError?.({ code: 'failed', message: '음성으로 바꾸지 못했어요.' });
        }
        return handlers.onEnd?.();
      }

      const blob = await res.blob();
      if (controller.signal.aborted) return handlers.onEnd?.();

      const url = URL.createObjectURL(blob);
      this.objectUrl = url;
      const audio = new Audio(url);
      this.audio = audio;

      audio.onended = () => {
        this.cleanup();
        handlers.onEnd?.();
      };
      audio.onerror = () => {
        this.cleanup();
        handlers.onError?.({ code: 'failed', message: '오디오를 재생하지 못했어요.' });
        handlers.onEnd?.();
      };

      try {
        handlers.onStart?.();
        await audio.play();
      } catch {
        this.cleanup();
        handlers.onError?.({ code: 'failed', message: '오디오를 재생하지 못했어요.' });
        handlers.onEnd?.();
      }
    })();
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.cleanup();
  }
}
