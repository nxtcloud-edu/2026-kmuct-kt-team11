# 릴스 음성 전사

영상이나 오디오 파일의 **말소리**를 텍스트로 변환합니다.
`claude.md` 의 추출 하네스 계획 중 rung 3(ASR)만 떼어낸 것입니다.

## 무엇을 하고, 무엇을 하지 않는가

| | |
|---|---|
| 내레이션·대화 | 텍스트로 나옵니다 |
| 화면에 박힌 자막·간판·메뉴판 글씨 | **읽지 않습니다** |
| 영상에 보이는 장면·사물 | **읽지 않습니다** |
| BGM만 있고 말이 없는 영상 | 빈 결과가 나옵니다 (실패가 아니라 데이터입니다) |

화면 속 글씨가 필요하면 계획서의 rung 2(비전)가 필요하고, 그건 프레임 추출 때문에
ffmpeg가 다시 들어옵니다.

## 설정

API 키를 `.env.local` 에 넣습니다.

```
OPENAI_API_KEY=sk-proj-...
```

> **주의**: 시스템 환경변수가 `.env.local` 보다 우선합니다. 쉘이나 Windows 환경변수에
> `OPENAI_API_KEY` 가 이미 있으면 그쪽이 이깁니다. 값이 `sk-sk-` 로 시작하면 접두사가
> 중복된 것이며, `provider_config()` 가 401 대신 그 사실을 알려줍니다.

벤더를 바꾸려면 (계획서 H8):

```
AI_GATEWAY_API_KEY=...        # 있으면 OPENAI_API_KEY보다 우선
AI_GATEWAY_BASE_URL=...       # 기본값은 키 종류에 따라 자동 선택
ASR_MODEL=whisper-1
```

## 실행

```bash
npm install
npm run dev      # http://localhost:3000
npm test
npm run build
```

## 배포

**시스템 바이너리가 필요 없습니다.** 전사 API가 영상 컨테이너(`mp4`, `webm` 등)를 받아
서버에서 오디오를 직접 뽑아내므로, 25MB 이하 파일은 원본 그대로 전송됩니다. ffmpeg는
지원하지 않는 컨테이너이거나 25MB를 넘을 때만 호출됩니다.

Vercel에 그대로 올라갑니다. 프로젝트 환경변수에 `OPENAI_API_KEY` 를 넣으면 됩니다.

### 알려진 제약

- **Vercel 서버리스 요청 본문 상한은 약 4.5MB입니다.** 앱은 25MB까지 허용하지만,
  Vercel에 올리면 4.5MB를 넘는 업로드가 함수에 도달하기 전에 거부됩니다. 더 큰 파일을
  다루려면 클라이언트에서 Blob 스토리지로 직접 올리고 서버는 그 URL을 받아 처리하는
  구조로 바꿔야 합니다.
- 전사에는 수십 초가 걸릴 수 있습니다. 함수 실행 시간 제한을 확인하세요.

## 인스타그램 URL은 왜 웹에 없는가

계획서의 **H6**: yt-dlp 경로는 배포하지 않습니다.

- 인스타그램은 데이터센터 IP를 차단합니다 (스펙 §8의 `blocked` = "401/429 — IP
  reputation, usually a datacenter address"). Vercel·AWS 어디서 돌려도 대부분 막힙니다.
- 스크래핑은 ToS 노출을 프로덕션에 싣는 일입니다.
- 추출기는 몇 주 단위로 깨집니다.

그래서 URL 경로는 **로컬 개발 CLI에만** 있습니다.

```bash
npm run transcribe -- "https://www.instagram.com/reel/XXXX/"
npm run transcribe -- ./clip.mp4 --json --out transcript.txt
```

`yt-dlp` 와 `ffmpeg` 가 PATH에 있어야 합니다.

`lib/extraction/media/no-ytdlp-in-app.test.ts` 가 `app/` 아래 어떤 파일도 yt-dlp를
import하거나 이름으로 실행하지 않는지 검사합니다.

프로덕션에서 릴스를 받으려면 스크래핑이 아니라 **인스타그램 DM 웹훅**을 씁니다. 사용자가
릴스를 비즈니스 계정으로 전달하면 Meta가 첨부 CDN URL을 보내주고, 그걸 `fetch` 하면
됩니다. `MediaSource` 인터페이스가 그대로 있으므로 구현체만 갈아끼우면 됩니다.

## 구조

```
app/
  transcribe/page.tsx           업로드 UI (파일만 받음. / 는 랜딩 페이지가 차지)
  api/transcribe/route.ts       POST, 멀티파트 업로드 → AsrRung
lib/extraction/
  types.ts                      Media, AsrRung
  cli-args.ts                   CLI 인자 파싱 (테스트 가능하도록 분리)
  provider.ts                   키·엔드포인트·모델 설정, 비용 추정
  upload.ts                     원본 직송 가능 여부 판단
  rungs/asr.ts                  전사 본체
  media/index.ts                MediaSource 경계, 릴스 ID 파싱
  media/yt-dlp.ts               개발 전용 — app/ 에서 import 금지
scripts/transcribe.ts           개발 전용 CLI
```
