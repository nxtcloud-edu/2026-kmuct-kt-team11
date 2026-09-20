'use client';

/**
 * Verification-only demo for the text-to-speech module. Not a product screen —
 * it exists so we can confirm "글자 → 말" actually works end to end.
 *
 * Type text (stand-in for the model's future answer), click 읽기, hear it.
 * The day the model produces text, a teammate passes that text to speak()
 * instead of this textarea's value — nothing else changes.
 *
 * Default backend is the browser's built-in voice — free, no key, works in
 * Chrome offline. (ElevenLabs is opt-in and needs a paid plan.)
 */

import { useState } from 'react';
import { useTextToSpeech } from '@/lib/speech';

const SAMPLE =
  '오늘은 성수동에서 시작해요. 첫 번째 카페는 열한 시에 열어요. 걸어서 오 분 거리예요.';

export default function TtsDemoPage() {
  const [text, setText] = useState(SAMPLE);
  const { speak, stop, speaking, supported, error } = useTextToSpeech({ lang: 'ko-KR' });

  return (
    <main style={{ maxWidth: 480, margin: '40px auto', padding: 16, fontFamily: 'sans-serif' }}>
      <h1>음성 출력 검증</h1>

      <p>지원 여부: {supported ? '✅ 지원됨 (브라우저 음성)' : '❌ 미지원 (Chrome 권장)'}</p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        style={{ width: '100%', padding: 8, fontSize: 16, boxSizing: 'border-box' }}
        placeholder="모델이 낼 텍스트를 여기에 (지금은 손으로 입력)"
      />

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <button onClick={() => speak(text)} disabled={!supported}>
          🔊 읽기
        </button>
        <button onClick={stop} disabled={!speaking}>
          ⏹ 멈추기
        </button>
      </div>

      <p style={{ color: '#666' }}>{speaking ? '▶️ 재생 중…' : '—'}</p>

      {error && (
        <p style={{ color: 'crimson' }}>
          오류 [{error.code}]: {error.message}
        </p>
      )}
    </main>
  );
}
