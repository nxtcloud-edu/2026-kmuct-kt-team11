'use client';

/**
 * Verification-only demo for the speech-to-text module. Not a product screen —
 * it exists so we can confirm "말 → 글자" actually works end to end. Teammates
 * build their own UI; this just proves the hook.
 *
 * Open /speech-demo in Chrome (https or localhost) and click 말하기.
 */

import { useSpeechToText } from '@/lib/speech';

export default function SpeechDemoPage() {
  const {
    listening,
    transcript,
    finalTranscript,
    interimTranscript,
    supported,
    error,
    start,
    stop,
    reset,
  } = useSpeechToText({ lang: 'ko-KR' });

  return (
    <main style={{ maxWidth: 480, margin: '40px auto', padding: 16, fontFamily: 'sans-serif' }}>
      <h1>음성 입력 검증</h1>

      <p>지원 여부: {supported ? '✅ 지원됨' : '❌ 미지원 (Chrome 권장)'}</p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <button onClick={listening ? stop : start} disabled={!supported}>
          {listening ? '🔴 멈추기' : '🎤 말하기'}
        </button>
        <button onClick={reset} disabled={listening}>
          초기화
        </button>
      </div>

      <section style={{ marginTop: 16 }}>
        <p>
          <strong>전체(transcript):</strong> {transcript || '—'}
        </p>
        <p style={{ color: '#666' }}>
          <strong>확정:</strong> {finalTranscript || '—'}
        </p>
        <p style={{ color: '#999' }}>
          <strong>중간:</strong> {interimTranscript || '—'}
        </p>
      </section>

      {error && (
        <p style={{ color: 'crimson' }}>
          오류 [{error.code}]: {error.message}
        </p>
      )}
    </main>
  );
}
