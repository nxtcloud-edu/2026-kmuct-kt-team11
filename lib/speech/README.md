# 음성 입력 (Speech-to-Text)

말한 것을 텍스트로 바꾸는 재사용 부품. **UI(버튼 등)는 포함하지 않습니다** — 각자
원하는 화면에 원하는 모양으로 붙이고, 이 훅으로 상태만 받아 쓰면 됩니다.

## 팀원이 쓰는 법

```tsx
'use client';
import { useSpeechToText } from '@/lib/speech';

export function VoiceInput({ onText }: { onText: (t: string) => void }) {
  const { listening, transcript, start, stop, supported, error } = useSpeechToText({
    lang: 'ko-KR', // 기본값이라 생략 가능
  });

  if (!supported) return <p>이 브라우저는 음성 입력을 지원하지 않습니다 (Chrome 권장).</p>;

  return (
    <div>
      <button onClick={listening ? stop : start}>
        {listening ? '🔴 멈추기' : '🎤 말하기'}
      </button>
      <p>{transcript}</p>
      {error && <p>{error.message}</p>}
      {/* 확정된 텍스트를 어디론가 넘기고 싶으면: */}
      <button onClick={() => onText(transcript)}>이 텍스트 사용</button>
    </div>
  );
}
```

훅이 돌려주는 것:

| 값 | 뜻 |
|---|---|
| `listening` | 지금 듣는 중인지 |
| `transcript` | 지금까지 인식된 전체 텍스트(중간 결과 포함) |
| `finalTranscript` | 확정된 텍스트만 |
| `interimTranscript` | 아직 확정 안 된 꼬리 부분 |
| `supported` | 이 환경에서 음성 입력이 되는지 (마이크 버튼 노출 조건으로 사용) |
| `error` | 마지막 오류 (`{ code, message }`) 또는 null |
| `start()` / `stop()` / `reset()` | 시작 / 멈춤 / 초기화 |

## 주의

- **크롬 계열에서 가장 잘 됩니다.** Safari는 부분 지원, Firefox는 미지원 → 항상
  `supported`로 감싸세요.
- **HTTPS 또는 localhost에서만** 동작합니다 (브라우저 보안 정책). 배포본은 https라 OK.
- 기본 언어는 `ko-KR`. `useSpeechToText({ lang: 'en-US' })`로 변경.

## 구조 (나중에 엔진 교체용)

```
recognizer.ts          ← 계약(인터페이스). 모든 백엔드가 이걸 구현.
browser-recognizer.ts  ← 브라우저(Web Speech API) 구현. 서버 없음, 무료. (현재 기본)
speech-core.ts         ← 상태 관리 코어. React 무관.
use-speech-to-text.ts  ← 코어를 React에 연결하는 얇은 훅. (팀원이 쓰는 것)
```

**ElevenLabs 등 서버 기반 STT로 바꾸려면**: `SpeechRecognizer`를 구현한 새 백엔드
(예: `ElevenLabsRecognizer`)와 오디오를 받는 서버 API 라우트를 추가한 뒤,
`useSpeechToText({ recognizer: new ElevenLabsRecognizer() })`로 주입하면 됩니다.
**코어·훅·이 훅을 쓰는 컴포넌트는 하나도 안 바뀝니다.** 서버 왕복이 필요하므로 훅만으로는
불가능하고, 반드시 백엔드 구현 + 서버 라우트가 함께 필요합니다.
