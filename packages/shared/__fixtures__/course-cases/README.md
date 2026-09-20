# 코스 생성 프롬프트 회귀 테스트 케이스

계획서 [7. 검증 계획](../../../docs/mbti-date-course-prompt-plan.md)에 대응하는 픽스처 모음입니다.
모든 장소 데이터는 **합성 데이터**이며 실제 상호·가격이 아닙니다.

## 구성

| 픽스처 | 취향 성향 | 지역 | 신뢰도 | 무엇을 검증하는가 |
|---|---|---|---|---|
| `taste-a-cafe-mood.json` | 카페·감성 | 성수 | high | 기본 경로. 축 4개가 모두 작동하는지 |
| `taste-b-foodie-value.json` | 미식·가성비 | 을지로 | high | 취향에 없는 방향(전시·체험)을 MBTI가 억지로 끼워 넣는지 |
| `taste-c-activity.json` | 체험·액티비티 | 연남 | medium | 영업시간·예약 제약이 많을 때 J/P 축의 시간표 처리 |
| `taste-d-low-confidence.json` | 근거 빈약 | 한남 | low | `lowConfidenceFallback` 경로와 MBTI 지배 여부 |

각 픽스처의 `user.mbti`는 `"{{INJECTED}}"`로 비어 있습니다. 테스트 실행기가 16개 유형을 순회하며 주입합니다.
A/B/C 3종 × 16유형 = **48케이스**가 주 회귀 스위트이고, D는 16유형 전체를 돌리되 fallback 검증만 별도로 봅니다.

## 측정 항목

### 1. 유형 간 차별성 (`typeDifferentiation`)

같은 픽스처를 16유형에 넣고 `stops[].placeId` 집합의 쌍별 Jaccard 유사도를 구해 평균냅니다.

```
J(A, B) = |placeIds(A) ∩ placeIds(B)| / |placeIds(A) ∪ placeIds(B)|
목표: 0.35 ≤ mean(J) ≤ 0.60
```

0.60을 넘으면 MBTI 주입이 먹히지 않는 것이고, 0.35 미만이면 MBTI가 취향 벡터를 덮고 있다는 뜻입니다.
후자의 경우 `blending.weights.mbtiAxes`를 낮추거나 `axisValues`의 절댓값을 줄입니다.

### 2. 단일 축 분리 (`singleAxisIsolation`)

한 글자만 다른 쌍을 비교해 **의도한 축만** 움직였는지 봅니다.

| 쌍 | 달라져야 하는 것 | 달라지면 안 되는 것 |
|---|---|---|
| ENFP / INFP | 정류장 수, 웨이팅 장소 포함 여부 | 예산 규모, 카테고리 구성 |
| INFJ / INFP | `startTime` 유무, `alternatives` 개수 | 선택된 장소 집합 (2/3 이상 겹쳐야 정상) |
| INFP / INTP | 설명 톤 (감각 묘사 vs 수치) | 선택된 장소 집합 |
| ISTJ / INTJ | 이색 장소 포함 여부 | 일정 경직도 관련 필드 |

의도하지 않은 축의 지표가 10% 넘게 흔들리면 축 간 신호가 겹치고 있다는 신호입니다.
`axes`의 `preferredSignals` 중복을 확인하세요.

### 3. 사실성 (`factuality`) — 반드시 0건

자동 검사 항목입니다. 다른 지표를 희생하더라도 이건 지켜야 합니다.

- `stops[].placeId`와 `alternatives[].placeId`가 모두 `candidatePlaces`에 존재하는가
- `estimatedCostPerPerson`이 후보의 `price.perPerson`과 일치하는가 (후보가 null이면 응답도 null)
- `startTime`/`endTime`이 후보의 `openingHours` 범위 안에 있는가
- 후보에 없던 할인·이벤트·메뉴 문자열이 등장하지 않는가
- `sponsored: true`인 후보를 썼다면 `sponsoredNotice`가 채워졌는가
- 후보의 `cautions`가 해당 정류장의 `cautions`에 빠짐없이 전달됐는가

### 4. 근거 커버리지 (`evidenceCoverage`) — 목표 100%

모든 `stops[]`가 `why.tasteEvidence`를 1개 이상 갖고 있어야 합니다.
비어 있는 정류장이 나오면 MBTI만으로 장소가 선택된 것이므로 시스템 프롬프트 L0-3 규칙을 강화합니다.

추가로 `taste-b`의 `pl_b08`(팝업 전시)과 `taste-d`의 `allowedTasteEvidenceTags`는 **함정**입니다.
`pl_b08`은 사용자 취향 벡터에 대응하는 태그가 없으므로 코스에 들어가면 안 됩니다.
들어갔다면 근거를 지어낸 것이므로 실패 처리합니다.

## 실행기가 해야 할 일

1. 픽스처를 읽고 `user.mbti`에 16유형을 차례로 주입
2. `mbti-course-profile.json`으로 L2 블록을 렌더링해 시스템 프롬프트 완성
3. LLM 호출 후 응답을 [`course-response.schema.json`](../../course-response.schema.json)으로 스키마 검증
4. 위 4개 지표 계산 후 리포트 출력
5. 픽스처의 `expectations` 블록을 어서션으로 변환해 검사

각 픽스처의 `expectations.byAxis` 키는 `<축 이름>.<극>` 형식이며, 해당 유형의 `axisValues` 부호가
그 극과 일치할 때만 검사를 적용합니다. 예를 들어 `crowdTolerance.negative` 어서션은
`axisValues.crowdTolerance < 0`인 8개 유형(I로 시작하는 유형)에만 적용합니다.
