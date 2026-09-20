# 음성 (Speech)

두 방향 모두 있습니다. **UI(버튼 등)는 포함하지 않습니다** — 각자 원하는 화면에
원하는 모양으로 붙이고, 훅으로 상태만 받아 쓰면 됩니다.

| 훅 | 방향 | 백엔드 |
|---|---|---|
| `useSpeechToText` | 말 → 글자 | 브라우저 Web Speech API. 서버 없음, 키 없음 |
| `useTextToSpeech` | 글자 → 말 | 기본은 브라우저 `speechSynthesis`. ElevenLabs는 선택 |

**이미 붙어 있는 곳:** `components/agent-sheet.tsx`의 통화 버튼. 둘을 이어서 **핸즈프리
통화**를 만듭니다 — 말하면 그게 메시지가 되고, 답을 읽어주고, 읽기가 끝나면 마이크가
다시 열립니다. 새로 만들지 말고 거기를 먼저 보세요.

# 음성 입력 (Speech-to-Text)

말한 것을 텍스트로 바꾸는 재사용 부품.

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

## 음성 출력 (Text-to-Speech)

```tsx
import { useTextToSpeech, preferredSynthesizer } from '@/lib/speech';

const [synthesizer] = useState(preferredSynthesizer);
const { speak, stop, speaking, supported, error } = useTextToSpeech({ synthesizer });
speak('오늘은 성수동에서 시작해요.');
```

`preferredSynthesizer()`를 쓰세요. 구체적인 백엔드를 직접 넣는 건 데모에서만.

### 어느 목소리가 나오는가

**기본은 기기 목소리(`speechSynthesis`)입니다. 키도, 설정도, 계정도 필요 없어요.**
받아서 바로 돌리면 그냥 됩니다.

ElevenLabs는 **선택**이고 `NEXT_PUBLIC_TTS_PROVIDER=elevenlabs`를 켰을 때만 시도합니다.
안 켜면 `/api/tts`로 요청 자체가 안 나가요 — 아무도 설정 안 한 기능 때문에 사용자가
왕복 지연을 낼 이유가 없으니까.

켜져 있어도 **소리가 나기 전에** 실패하면 기기 목소리가 같은 문장을 대신 읽고,
그 세션 동안은 다시 시도하지 않습니다 (`FallbackSynthesizer`). 즉 **음성 업그레이드가
막혀 있다고 사용자가 답을 못 듣는 일은 없습니다.**

지금 이 저장소의 `ELEVENLABS_API_KEY`가 정확히 그 상태입니다: 인증은 되는데
`text_to_speech` 권한이 꺼진 scoped key라 401이 돌아옵니다. 무료 플랜은 402고요.
둘 다 `/api/tts`가 `tts-unavailable`로 바꿔서 내려주고, 클라이언트는 그걸 보고
기기 목소리로 넘어갑니다. **고치려면 ElevenLabs 대시보드에서 Text to Speech 권한을
켜야 합니다 — 코드로 우회할 수 있는 게 아닙니다.**

### 구조

```
synthesizer.ts             ← 계약(인터페이스). 모든 백엔드가 이걸 구현.
browser-synthesizer.ts     ← 브라우저 speechSynthesis. 무료, 오프라인. (기본)
elevenlabs-synthesizer.ts  ← /api/tts를 호출. 키는 서버에만.
fallback-synthesizer.ts    ← 위 둘의 합성 + preferredSynthesizer(). 새 엔진 아님.
use-text-to-speech.ts      ← React 훅. (팀원이 쓰는 것)
```

## 통화(핸즈프리)로 쓸 때: `tapRecognizer` / `tapSynthesizer`

훅 두 개는 **상태**(`listening`, `speaking`, `transcript`)를 줍니다. 그런데 턴을
주고받는 통화에 필요한 건 **사건**입니다 — 마이크가 실제로 열렸다, 한 턴이 끝났다,
답 읽기가 끝났다. 상태 변화를 effect로 되짚어 사건을 추측하면, 재시작 로직과 만나는
순간 그게 바로 무한 루프가 됩니다.

```tsx
const tapsRef = useRef<RecognizerTap & SynthesizerTap>({});
const [engine] = useState(() => {
  const taps = () => tapsRef.current;
  return {
    recognizer: tapRecognizer(new BrowserRecognizer(), taps),
    synthesizer: tapSynthesizer(preferredSynthesizer(), taps),
  };
});
const mic = useSpeechToText({ lang: 'ko-KR', recognizer: engine.recognizer });
const voice = useTextToSpeech({ synthesizer: engine.synthesizer, lang: 'ko-KR' });
```

| 콜백 | 언제 |
|---|---|
| `onOpen` | 마이크가 진짜 열렸을 때. `start()` 호출과 다릅니다(권한 창, 거부) |
| `onSettled(text)` | 한 세션이 끝났을 때. **빈 문자열이 정상입니다** |
| `onFail(error)` | 인식 오류 |
| `onAudioStart` / `onAudioEnd` | 답 읽기 시작 / 끝(중단·실패 포함, 정확히 한 번) |

탭은 엔진이 아닙니다. 전부 그대로 아래로 넘기기 때문에 ElevenLabs 폴백도 그대로
동작합니다. 구현은 `tap.ts`.

### `continuous = true`가 답이 아닌 이유

Web Speech 인식기는 플래그와 무관하게 침묵에서 세션을 끝냅니다. 그래서 연속 청취는
**`onSettled`에서 다시 `start()`를 거는 체인**으로 만듭니다. 두 가지를 반드시 막으세요:

- `onend` 안에서 곧바로 `start()`를 부르면 크롬이 "already started"를 던지고, 그게
  다시 오류+종료로 돌아와 **타이트 루프**가 됩니다. 한 틱(150~200ms) 띄우세요.
- 통화를 끊은 뒤에도 재시작되지 않도록 "지금 마이크를 원하는가"를 ref로 들고 판단하세요.

### 에코(자기 목소리를 자기가 받아쓰는 문제)

브라우저에는 우리가 쓸 수 있는 AEC가 없습니다. 답을 읽는 동안 **마이크를 닫는 것**이
해법입니다(half-duplex). 끼어들기는 탭 한 번으로 `voice.stop()` + 마이크 재개.

### 한국어 목소리

`browser-synthesizer.ts`가 `ko-KR` → `ko` 순으로 고르고, 같은 조건이면 기기 내장
목소리를 먼저 씁니다(macOS/Chrome의 Yuna 등). **`getVoices()`는 첫 호출에서 비어 있고
`voiceschanged`로 나중에 채워지는 게 정상**이라, 첫 문장은 목록을 기다렸다가 말합니다
(최대 1.5초). 이걸 안 기다리면 한국어 문장을 영어 목소리가 읽습니다.
