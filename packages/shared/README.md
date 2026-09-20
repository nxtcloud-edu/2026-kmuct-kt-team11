# Recommendation agent

저장한 릴스·틱톡에서 만든 취향 벡터와 사용자가 선택한 MBTI를 이용해 데이트 코스를 만드는 서버 모듈입니다. 설계 결정은 [`docs/recommendation-agent-decision-checklist.md`](../../docs/recommendation-agent-decision-checklist.md)를 따릅니다.

## 처리 흐름

1. `request.ts`가 요청과 후보 장소를 검증합니다.
2. `rank.ts`가 하드 제약을 적용하고 후보를 최대 30곳으로 줄입니다.
3. `prompt.ts`가 `prompts/date-course-system.md`의 L0~L5를 조립합니다.
4. `bedrock.ts`가 AWS Bedrock Converse API로 Claude를 호출합니다.
5. Claude는 `course-draft.schema.json`에 맞춰 장소 선택·순서·추천 근거만 반환합니다.
6. `schedule.ts`가 시간표, 이동 시간, 1인 예산, 광고·주의사항을 후보 데이터로 계산합니다.
7. `validate.ts`가 환각 장소, 영업시간, 이동, 예산, 저장 장소 비율을 검사합니다.
8. 실패 시 `agent.ts`가 위반 항목과 이전 초안을 Claude에 돌려주며 최대 3회 수정합니다.

LLM은 가격, 영업시간, 이동 시간 또는 새 장소를 만들지 않습니다. 계산할 수 없는 가격과 영업시간은 `verificationRequired`에 남습니다.

## 환경 설정

```env
AWS_REGION=<선택한 모델을 지원하는 AWS 리전>
BEDROCK_MODEL_ID=<사용할 Claude model 또는 inference profile ID>
BEDROCK_TIMEOUT_MS=180000
```

AWS 기본 자격 증명 체인을 사용합니다. 실행 역할이나 로컬 프로필에는 선택한 모델에 대한 `bedrock:InvokeModel` 권한이 필요합니다. 모델 ID와 리전은 배포 환경마다 달라질 수 있어 코드에 고정하지 않았습니다.

첫 structured-output 스키마 컴파일은 수 분 걸릴 수 있어 기본 제한 시간을 180초로 두었습니다. 이후 같은 스키마는 Bedrock에서 캐시됩니다.

## API

`POST /api/itineraries`는 로그인이 필요하며 `Idempotency-Key`를 지원합니다. 필수 입력은 다음과 같습니다.

- MBTI와 취향 벡터
- 날짜, 시간대, 참여 인원
- 지역 또는 출발역
- `source`가 `saved` 또는 `external`로 표시된 후보 장소 5곳 이상

후보 조회와 Kakao·Google·Naver 경로 API 연결은 이 모듈의 앞 단계입니다. 현재 기본 이동 제공자는 좌표, 역, 지역 태그를 사용한 추정값을 반환하고 `estimated: true`로 표시합니다. 실제 지도 API를 붙일 때는 `TravelProvider`를 구현해 `planCourse`에 주입하면 됩니다.

## 검증

```bash
npm run test:recommendation
npm exec tsc -- --noEmit
npm run lint
```

자기검사는 첫 Claude 응답에 후보군 밖 장소를 넣고, 검증 실패 후 두 번째 호출에서 수정되는 전체 흐름을 확인합니다. 실제 Bedrock 호출은 AWS 자격 증명과 모델 ID가 설정된 환경에서 API를 통해 확인합니다.
