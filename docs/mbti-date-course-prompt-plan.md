# MBTI 캐릭터 기반 데이트 코스 추천 시스템 프롬프트 설계 계획서

- 문서 버전: v1.0
- 작성일: 2026-09-20
- 대상 파이프라인: 릴스·틱톡 transcript 추출 → 취향 분석 → 유사 사용자 협업 신호 → **MBTI 캐릭터 기반 데이트 코스 생성**
- 관련 기존 자산: [`packages/shared/transcript-extraction.json`](../packages/shared/transcript-extraction.json)

---

## 1. 배경과 문제 정의

현재 레포에는 영상에서 정보를 **뽑아내는** 단계(`transcript-extraction.json`)만 정의되어 있고, 뽑아낸 정보를 **코스로 조립하는** 단계의 프롬프트 규격이 없습니다. 이번 작업의 목표는 사용자가 온보딩에서 고른 MBTI 캐릭터에 따라 서로 다른 데이트 코스가 나오도록 코스 생성 LLM의 시스템 프롬프트를 설계하는 것입니다.

여기서 가장 쉽게 빠지는 함정이 두 가지 있습니다.

1. **16개 프롬프트를 각각 손으로 쓰는 방식.** 공통 규칙을 고칠 때마다 16곳을 고쳐야 하고, 유형 간 품질 편차가 생기며, "ENFP와 INFP가 왜 다른가"를 설명할 수 없게 됩니다.
2. **MBTI가 추천을 지배하는 방식.** 우리 서비스의 핵심 가치는 "사용자가 올린 영상에서 뽑아낸 실제 취향"입니다. MBTI가 이걸 덮어버리면 영상 분석은 장식이 되고, 그냥 MBTI 운세 앱이 됩니다.

따라서 아래 두 가지를 설계 원칙으로 못 박고 시작합니다.

> **원칙 A.** 시스템 프롬프트는 하나이며, MBTI는 4개 축(E/I, S/N, T/F, J/P)의 **파라미터로 주입**된다. 유형별로 프롬프트 전문을 따로 두지 않는다.
>
> **원칙 B.** MBTI는 **사실을 바꾸지 않는다.** MBTI가 영향을 주는 대상은 ① 후보 장소의 랭킹 가중치, ② 코스의 구조(순서·밀도·여유), ③ 추천 이유의 설명 톤 — 이 세 가지뿐이다. 장소의 가격·영업시간·위치 같은 사실은 MBTI와 무관하게 추출 데이터만 따른다.

---

## 2. 전체 파이프라인에서 이 프롬프트의 위치

```
[1] 영상 입력 (릴스/틱톡 URL)
      ↓
[2] transcript · caption · hashtag 추출
      ↓
[3] 정보 구조화 LLM  ← transcript-extraction.json (기존)
      ↓  placeProfile[] (장소 + audience/feature/constraint 태그)
      ↓
[4] 사용자 취향 벡터 생성  ← 사용자가 저장한 영상들의 태그 집계
      ↓  userTasteVector
      ↓
[5] 협업 필터링: 유사 취향 사용자가 좋아한 장소 후보군 추출
      ↓  candidatePlaces[] + similarUserSignal
      ↓
[6] ★ 코스 생성 LLM  ← 이번 문서에서 설계 (mbti-course-profile.json + 시스템 프롬프트)
      ↓
[7] 코스 JSON → 앱 렌더링
```

이번 작업의 범위는 **[6]번 단계만**입니다. [3]번의 `transcript-extraction.json`은 수정하지 않고, 거기서 정의한 태그 어휘(`audienceMappings`, `featureMappings`, `contentCategories`)를 그대로 **재사용**합니다. 이게 중요한 이유는, 추출 단계와 추천 단계가 같은 단어를 써야 "이 영상의 '루프탑' 태그 때문에 이 장소를 골랐다"는 근거 추적이 가능하기 때문입니다.

---

## 3. MBTI를 다루는 방식: 16개가 아니라 4개 축

### 3.1 축별 의미 정의

MBTI 각 축을 성격 이론 그대로 쓰지 않고, **데이트 코스를 구성할 때 실제로 달라져야 하는 변수**로 번역합니다. 각 축은 -1.0 ~ +1.0 스칼라로 표현합니다.

| 축 | 코스 파라미터 | 음(-) 방향 | 양(+) 방향 |
|---|---|---|---|
| E / I | `crowdTolerance` (혼잡·자극 허용치) | I: 조용함, 프라이빗, 웨이팅 회피, 예약제 | E: 핫플, 대형 공간, 축제·팝업, 웨이팅 감수 |
| S / N | `experienceMode` (경험의 결) | S: 감각적·검증된 실체 (미식, 뷰, 체험) | N: 컨셉·서사·이색성 (전시, 테마, 실험적 공간) |
| T / F | `rationaleStyle` (설득 방식) | T: 효율·가성비·동선 논리 | F: 분위기·의미·둘의 기억 |
| J / P | `scheduleRigidity` (일정 경직도) | P: 느슨한 동선, 대안 다수, 즉흥 여지 | J: 확정 타임라인, 예약 필수, 분 단위 |

### 3.2 축이 실제로 바꾸는 것

축 값이 추상적인 형용사로 끝나면 LLM은 결국 비슷한 코스를 냅니다. 각 축을 **기존 태그 어휘 위의 구체적 가중치**로 내려야 합니다. 예를 들어 E/I 축은 다음과 같이 작동합니다.

- `crowdTolerance = -0.8` (강한 I)
  - 선호 feature: `atmosphere`의 "조용한", "프라이빗", "아늑한" / `operation`의 "예약"
  - 기피 feature: `operation`의 "웨이팅", "오픈런" / audience의 `friends_group` 신호
  - 코스 구조 규칙: 정류장 3곳 이하, 이동 15분 이내, 피크 타임 회피 시간대 제안
- `crowdTolerance = +0.8` (강한 E)
  - 선호: `local_explorer` 신호, "핫플", "팝업", "루프탑", 대형 공간
  - 허용: 웨이팅 30분까지 감수하되 그 시간을 코스에 명시
  - 코스 구조 규칙: 정류장 4곳까지, 밀도 높은 상권 클러스터 우선

J/P 축은 장소 선택보다 **코스의 형태**를 바꿉니다. J는 `stops[]`에 시작 시각이 박히고 각 정류장에 예약 액션이 붙습니다. P는 시작 시각 대신 소요 시간 범위만 주고, 정류장마다 `alternatives`를 2개씩 채웁니다.

T/F 축은 **장소를 거의 바꾸지 않고 설명만 바꾸는** 축입니다. 같은 루프탑 바를 두고 T에게는 "도보 4분, 1인 2.5만 원대, 앞 코스 대비 이동 최소"로, F에게는 "해 지는 시간에 맞춰 올라가면 첫 잔 마실 때 노을이 걸립니다"로 씁니다. 이 축을 장소 선택에까지 강하게 걸면 근거 없는 성차별적·스테레오타입 추천이 나오기 쉬우므로, T/F의 장소 랭킹 영향력은 **다른 축의 절반으로 상한**을 둡니다.

### 3.3 16유형 캐릭터는 "껍데기"로만 유지

온보딩 UX상 사용자는 16개 캐릭터 중 하나를 고릅니다. 하지만 프롬프트에 들어가는 건 축 값이고, 유형별로 별도 관리하는 것은 다음 세 가지뿐입니다.

- `characterName` (예: "심야 산책러")
- `oneLineConcept` (코스 제목 생성 시 톤 힌트)
- `overrides` (축 조합만으로 표현 안 되는 유형 고유 규칙. **기본값은 비어 있어야 하며**, 실제 테스트에서 차별화가 부족할 때만 최소한으로 추가)

즉 16유형 = 4축 조합 + 얇은 프레젠테이션 레이어입니다.

---

## 4. 신규 설정 파일: `packages/shared/mbti-course-profile.json`

`transcript-extraction.json`과 같은 위치에 형제 파일로 둡니다. 프롬프트 본문에 축 정의를 하드코딩하지 않고 이 파일에서 조립해 주입합니다.

```json
{
  "version": 1,
  "updatedAt": "2026-09-20",
  "description": "MBTI 캐릭터별 데이트 코스 생성 파라미터. transcript-extraction.json의 태그 어휘를 참조한다.",

  "axes": {
    "crowdTolerance": {
      "poles": { "negative": "I", "positive": "E" },
      "rankingWeight": 1.0,
      "negativePreferredFeatures": ["조용한", "프라이빗", "아늑한", "예약"],
      "negativeAvoidFeatures": ["웨이팅", "오픈런"],
      "positivePreferredFeatures": ["핫플", "팝업", "루프탑", "대형카페"],
      "positiveAvoidFeatures": [],
      "structureRules": {
        "negative": ["정류장 3곳 이하", "정류장 간 이동 15분 이내", "피크 타임 회피 시간대 제시"],
        "positive": ["정류장 최대 4곳", "웨이팅 예상 시간을 코스 일정에 명시"]
      }
    },
    "experienceMode": {
      "poles": { "negative": "S", "positive": "N" },
      "rankingWeight": 1.0,
      "negativePreferredCategories": ["restaurant", "cafe_dessert", "activity_experience"],
      "negativePreferredFeatures": ["내돈내산", "재방문", "오션뷰", "야경"],
      "positivePreferredCategories": ["culture_exhibition", "travel_attraction"],
      "positivePreferredFeatures": ["이색", "컨셉", "팝업", "숨은명소"],
      "structureRules": {
        "negative": ["검증 신호(재방문·내돈내산)가 있는 장소를 1곳 이상 포함"],
        "positive": ["대화 주제가 되는 이색 장소를 1곳 이상 포함"]
      }
    },
    "rationaleStyle": {
      "poles": { "negative": "T", "positive": "F" },
      "rankingWeight": 0.5,
      "toneRules": {
        "negative": ["이동 거리·소요 시간·1인 예산을 문장에 수치로 포함", "대안 대비 우위를 1문장으로 설명"],
        "positive": ["시간대·빛·분위기 등 감각 묘사를 1문장 포함", "두 사람의 경험 흐름으로 서술"]
      }
    },
    "scheduleRigidity": {
      "poles": { "negative": "P", "positive": "J" },
      "rankingWeight": 0.5,
      "structureRules": {
        "negative": ["각 정류장에 alternatives 2개 제공", "시작 시각 대신 소요 시간 범위 제시", "도보 이동 가능한 클러스터 우선"],
        "positive": ["각 정류장에 시작·종료 시각 명시", "예약 필요 장소는 reservationAction 필드 작성", "총 소요 시간을 분 단위로 합산"]
      }
    }
  },

  "types": {
    "INFP": {
      "characterName": "감성 산책러",
      "oneLineConcept": "조용한 골목에서 이야기가 쌓이는 코스",
      "axisValues": { "crowdTolerance": -0.7, "experienceMode": 0.6, "rationaleStyle": 0.8, "scheduleRigidity": -0.6 },
      "overrides": []
    },
    "ESTJ": {
      "characterName": "완벽 동선 플래너",
      "oneLineConcept": "낭비 없는 시간표로 굴러가는 코스",
      "axisValues": { "crowdTolerance": 0.6, "experienceMode": -0.7, "rationaleStyle": -0.8, "scheduleRigidity": 0.8 },
      "overrides": []
    }
  },

  "blending": {
    "weights": { "userTasteVector": 0.5, "similarUserSignal": 0.3, "mbtiAxes": 0.2 },
    "rule": "MBTI 축은 개인 취향과 협업 신호로 계산된 점수에 곱해지는 조정 계수로만 작동하며, 단독으로 후보를 진입시키거나 탈락시키지 않는다.",
    "tieBreaker": "최종 점수 차이가 0.05 이내인 후보들 사이에서는 MBTI 축 적합도가 높은 쪽을 선택한다."
  }
}
```

`axisValues`는 16유형 전부를 채우되, 위 예시처럼 각 축에 ±0.6~0.8 수준의 값을 부여합니다. 0.3 미만으로 주면 유형 간 차이가 체감되지 않고, 1.0을 주면 MBTI가 취향을 덮습니다.

---

## 5. 시스템 프롬프트 구조

프롬프트를 5개 레이어로 나눕니다. 이 중 **동적으로 바뀌는 건 L2뿐**이고 나머지는 전 유형 공통입니다.

| 레이어 | 내용 | 변동 여부 |
|---|---|---|
| L0 | 역할 정의, 사실성 규칙(추측 금지, 근거 필수, 광고 표기) | 고정 |
| L1 | 입력 데이터 계약 + 출력 JSON 스키마 | 고정 |
| L2 | **MBTI 프로파일 블록** (캐릭터 + 축 값 + 선호/기피 태그 + 구조 규칙 + 톤 규칙) | **유형별 주입** |
| L3 | 코스 조립 규칙 (슬롯 구성, 동선, 예산, 시간) | 고정 |
| L4 | 금지 사항 및 안전 규칙 | 고정 |

### 5.1 L0 — 역할과 사실성 규칙 (초안)

```
당신은 데이트 코스 플래너입니다. 사용자가 저장한 릴스·틱톡 영상에서 추출된 취향 데이터와,
취향이 유사한 다른 사용자들이 좋아한 장소 후보군을 받아 하나의 데이트 코스를 구성합니다.

반드시 지킬 것:
1. candidatePlaces에 없는 장소를 새로 만들어내지 않는다. 모든 정류장은 후보군에서만 고른다.
2. 가격, 주소, 영업시간, 예약 조건은 후보 데이터에 있는 값만 쓴다. 없으면 null로 두고
   verificationRequired에 추가한다. 추정치를 사실처럼 쓰지 않는다.
3. 모든 정류장에는 왜 이 사용자에게 맞는지에 대한 근거를 남긴다.
   근거는 (a) 사용자 영상에서 나온 태그, (b) 유사 사용자 신호, (c) MBTI 적합성 중
   최소 2가지를 포함하며, (a)를 반드시 하나 이상 포함한다.
4. sponsored가 true인 장소를 포함할 경우 해당 정류장에 광고성 콘텐츠 기반임을 표시한다.
5. 후보 데이터의 cautions(노키즈존, 웨이팅, 주차 불가 등)는 누락 없이 코스에 전달한다.
```

3번 규칙이 이 프롬프트의 핵심입니다. "MBTI 적합성만으로 장소를 고를 수 없게" 강제하는 장치이고, 원칙 B를 프롬프트 레벨에서 보증합니다.

### 5.2 L2 — MBTI 프로파일 블록 템플릿

`mbti-course-profile.json`에서 다음 형태로 렌더링해 주입합니다.

```
## 이번 사용자의 캐릭터: {characterName} ({mbti})
컨셉: {oneLineConcept}

### 코스 성향 파라미터
- 혼잡·자극 허용치: {crowdTolerance} ({설명})
- 경험의 결: {experienceMode} ({설명})
- 설득 방식: {rationaleStyle} ({설명})
- 일정 경직도: {scheduleRigidity} ({설명})

### 가산할 신호
{축별 preferredFeatures/Categories 합집합}

### 감산할 신호
{축별 avoidFeatures 합집합}
- 감산 신호가 있다고 후보를 탈락시키지는 않는다. 점수만 낮춘다.

### 이 캐릭터의 코스 구조 규칙
{축별 structureRules 합집합}

### 이 캐릭터의 서술 톤 규칙
{rationaleStyle의 toneRules}

### 가중치 적용 방식
최종 점수 = (개인 취향 적합도 × 0.5) + (유사 사용자 신호 × 0.3) + (MBTI 축 적합도 × 0.2)
MBTI 축 적합도는 순위를 조정하는 용도이며, 개인 취향 근거가 전혀 없는 장소를
MBTI만으로 코스에 넣지 않는다.
```

### 5.3 L3 — 코스 조립 규칙 (초안)

```
- 코스는 3~4개 정류장으로 구성하며 정류장 수는 캐릭터의 구조 규칙을 따른다.
- 슬롯 구성의 기본형은 [메인 식사] → [카페·디저트] → [체험 또는 전시] → [마무리(야경·바·산책)]이며,
  후보군 구성에 따라 슬롯을 생략할 수 있다. 같은 카테고리를 연속 배치하지 않는다.
- 정류장 간 이동은 대중교통 또는 도보 기준 25분 이내여야 한다. 초과하면 다른 후보로 교체한다.
- 총 1인 예산을 합산해 제시하고, 후보에 가격 정보가 없는 정류장은 예산 합산에서 제외하되
  그 사실을 명시한다.
- 시간대 제약(브레이크타임, 라스트오더, 휴무)이 충돌하면 순서를 바꾸거나 대안으로 교체한다.
```

### 5.4 L4 — 금지 사항

```
- MBTI를 근거로 사용자의 성격, 연애 방식, 능력을 단정하지 않는다.
  ("INFP는 사람 많은 곳을 싫어합니다" 같은 서술 금지)
- MBTI 설명은 "이 코스를 이렇게 짰다"는 구성 의도로만 쓴다.
- 특정 성별·연령에 대한 고정관념에 기반한 추천 사유를 쓰지 않는다.
- 후보 데이터에 없는 이벤트·할인·한정 메뉴를 만들어내지 않는다.
```

---

## 6. 입출력 데이터 계약

### 6.1 입력

```json
{
  "user": {
    "mbti": "INFP",
    "tasteVector": {
      "categories": { "cafe_dessert": 0.8, "culture_exhibition": 0.6, "restaurant": 0.4 },
      "features": { "atmosphere": 0.9, "view_photo": 0.7, "value": 0.3 },
      "audiences": ["couple", "photo_mood_seeker"],
      "evidence": [
        { "tag": "감성카페", "sourceVideoId": "rl_9f21", "count": 4 }
      ]
    },
    "constraints": { "region": "성수", "date": "2026-09-26", "timeRange": "15:00-22:00", "budgetPerPerson": 60000 }
  },
  "similarUsers": { "cohortSize": 412, "similarity": 0.78 },
  "candidatePlaces": [
    {
      "placeId": "pl_0031",
      "title": "...",
      "category": "cafe_dessert",
      "location": { "name": "...", "nearestStation": "성수", "regionTags": ["성수"] },
      "price": { "perPerson": 18000, "priceLevel": "mid" },
      "features": ["통창", "조용한"],
      "constraints": { "reservation": "불가", "waiting": "주말 20분", "parking": "불가" },
      "openingHours": "11:00-21:00",
      "sponsored": false,
      "cautions": [],
      "similarUserSignal": { "likeRate": 0.62, "cohortRank": 3 },
      "sourceEvidence": [{ "source": "hashtag", "text": "#성수감성카페" }]
    }
  ]
}
```

`candidatePlaces[]`의 필드는 `transcript-extraction.json`의 `llmOutputShape`와 동일한 이름을 씁니다. 별도 변환 레이어를 두지 않기 위해서입니다.

### 6.2 출력

```json
{
  "mbti": "INFP",
  "characterName": "감성 산책러",
  "courseTitle": "해질녘 성수 골목 한 바퀴",
  "courseSummary": "사람 적은 시간대를 골라 통창 카페에서 시작해 노을로 마무리하는 코스",
  "totalDurationMin": 300,
  "estimatedBudgetPerPerson": 52000,
  "budgetNote": "3번 정류장은 가격 정보가 없어 합산에서 제외했습니다.",
  "stops": [
    {
      "order": 1,
      "slot": "cafe_dessert",
      "placeId": "pl_0031",
      "name": "...",
      "startTime": null,
      "durationMin": 70,
      "why": {
        "tasteEvidence": ["저장한 영상 4개에서 '감성카페' 태그가 반복됨", "'통창' 선호 신호"],
        "similarUserEvidence": "취향 유사 사용자 412명 중 62%가 저장",
        "mbtiFit": "혼잡도 낮은 시간대에 조용히 대화하기 좋은 구조"
      },
      "moveToNext": { "mode": "도보", "minutes": 8 },
      "alternatives": [{ "placeId": "pl_0044", "reason": "웨이팅이 길 경우 대체" }],
      "cautions": ["주말 20분 웨이팅"],
      "sponsoredNotice": null
    }
  ],
  "mbtiRationale": "조용한 곳에서 시작해 사람이 빠지는 시간대로 이동하도록 순서를 잡았고, 정류장 사이를 모두 도보권으로 묶어 일정 변경이 쉽도록 구성했습니다.",
  "verificationRequired": ["2번 정류장 영업시간", "3번 정류장 1인 예산"],
  "cautions": []
}
```

`why` 객체를 3분할한 이유는, 나중에 앱에서 "이 추천이 내 영상 때문인지 / 비슷한 사람들 때문인지 / MBTI 때문인지"를 사용자에게 분리해 보여줄 수 있게 하기 위해서입니다. 이건 서비스 신뢰도와 직결되는 부분이고, 해커톤 데모에서도 차별점으로 보여주기 좋습니다.

---

## 7. 검증 계획

프롬프트 수정의 성패는 "16유형이 실제로 다른 코스를 내는가"와 "그 차이가 설명 가능한가"로 갈립니다. 다음 4가지를 측정합니다.

**7.1 유형 간 차별성**
동일한 `userTasteVector`와 `candidatePlaces`를 16유형에 각각 넣고, 코스 장소 집합의 Jaccard 유사도를 계산합니다. 목표는 평균 0.35~0.6 구간입니다. 0.8 이상이면 MBTI가 작동하지 않는 것이고, 0.2 이하면 MBTI가 취향을 덮어버린 것입니다.

**7.2 단일 축 분리 테스트**
한 글자만 다른 쌍(ENFP vs INFP, INFJ vs INFP 등)을 비교해 의도한 축 방향으로만 결과가 움직이는지 확인합니다. E/I만 바꿨는데 예산과 카테고리가 전부 달라진다면 축 가중치가 서로 간섭하고 있다는 뜻입니다.

**7.3 사실성 회귀 테스트**
후보군에 없는 장소가 등장했는지, 후보에 없던 가격·영업시간이 생성됐는지를 자동 검사합니다. 목표는 0건이며, 이 항목은 다른 지표를 희생해서라도 지켜야 합니다.

**7.4 근거 커버리지**
모든 `stops[]`가 `why.tasteEvidence`를 1개 이상 갖고 있는지 검사합니다. 목표 100%. 비어 있는 정류장이 있다면 MBTI만으로 장소가 선택된 것이므로 프롬프트 L0-3 규칙을 강화해야 합니다.

테스트 픽스처는 `packages/shared/__fixtures__/course-cases/`에 취향 프로필 3종(카페·감성형 / 미식·가성비형 / 액티비티형) × 16유형 = 48케이스로 구성합니다.

---

## 8. 리스크와 대응

**MBTI 고정관념 강화.** "I니까 사람 많은 곳은 싫겠죠" 같은 문장은 사용자 경험을 해칠 뿐 아니라 틀리기도 쉽습니다. L4 금지 규칙으로 막고, 추가로 코스 결과 화면에 축 값을 사용자가 직접 조정할 수 있는 슬라이더를 두는 것을 권장합니다. 사용자가 조정하면 `axisValues`를 덮어쓰면 됩니다.

**MBTI가 취향 데이터를 덮는 문제.** 블렌딩 가중치 0.2와 L0-3 규칙(취향 근거 필수)이 1차 방어선이고, 7.4 근거 커버리지 테스트가 2차 방어선입니다.

**후보군이 빈약할 때의 품질 저하.** 신규 사용자가 영상을 1~2개만 올린 경우 취향 벡터가 거의 비어 협업 신호와 MBTI만 남습니다. 이 경우 `tasteVectorConfidence`가 낮음을 프롬프트에 전달하고, 코스 요약에 "영상을 더 추가하면 추천이 정확해집니다"를 포함하도록 별도 규칙을 둡니다.

**프롬프트 길이.** L0~L4 전체에 후보 20곳을 넣으면 컨텍스트가 커집니다. 후보는 사전 랭킹으로 12~15곳까지 줄여 전달하고, 각 후보의 필드는 코스 생성에 실제로 쓰이는 것만 추려 보냅니다.

---

## 9. 실행 로드맵

| 단계 | 작업 | 산출물 | 상태 |
|---|---|---|---|
| 1 | 4축 정의 확정 및 축별 태그 매핑 작성 | [`mbti-course-profile.json`](../packages/shared/mbti-course-profile.json)의 `axes` 섹션 | 완료 |
| 2 | 16유형 `axisValues` + 캐릭터 네이밍 | 같은 파일의 `types` 섹션 | 완료 (네이밍은 기획·디자인 검토 필요) |
| 3 | 시스템 프롬프트 L0~L5 작성 | [`prompts/date-course-system.md`](../packages/shared/prompts/date-course-system.md) | 완료 |
| 4 | 프로파일 → L2 블록 렌더러 구현 | `src/prompt.ts`, `src/rank.ts` | 완료 |
| 5 | 입출력 스키마 코드화 | [`course-response.schema.json`](../packages/shared/course-response.schema.json), `src/validate.ts` | 완료 |
| 6 | 픽스처로 7.1~7.4 측정 | [`__fixtures__/course-cases/`](../packages/shared/__fixtures__/course-cases/), `src/eval/` | 완료 (실제 측정은 LLM 연결 후) |
| 7 | 측정 결과로 축 가중치·`overrides` 튜닝 | 프로파일 v2 | 6단계 실행 이후 |

1~6단계가 모두 코드와 데이터로 존재합니다. 남은 것은 LLM 호출부를 연결해
`node dist/eval/cli.js --caller <모듈>`로 회귀 스위트를 돌리고, 그 결과로 7단계를 진행하는 일입니다.
사용법은 [`packages/shared/README.md`](../packages/shared/README.md)에 정리했습니다.

### 구현하면서 계획과 달라진 점

- **사전 랭커를 추가했습니다.** 계획서 8장의 컨텍스트 길이 리스크에 대응하려면 후보를 12~15개로
  줄여야 하는데, 그 순위를 LLM에 맡기면 검증이 불가능합니다. `rankCandidates()`가
  `mbti-course-profile.json`의 `scoring` 공식을 결정적으로 계산해 후보를 자르고,
  취향 근거를 연결할 수 없는 후보를 미리 떨어뜨립니다. 원칙 B를 프롬프트 문구가 아니라
  코드로 한 번 더 막는 장치이기도 합니다.
- **픽스처를 3종이 아니라 4종으로 만들었습니다.** `lowConfidenceFallback` 경로가 검증되지 않은 채
  남는 게 걸려서 `taste-d-low-confidence`를 추가했습니다.
- **프롬프트 원본을 마크다운에 두고 코드가 파싱하도록 했습니다.** 프롬프트 문구를 TypeScript
  문자열 상수로 옮기면 사람이 읽는 문서와 실제 프롬프트가 갈라지기 때문에,
  `date-course-system.md`의 ` ```text ` 블록을 유일한 출처로 삼았습니다.

---

## 10. 정리

핵심은 세 가지입니다. 첫째, 프롬프트는 하나로 유지하고 MBTI는 4축 파라미터로 주입해 유지보수 비용을 16분의 1로 줄입니다. 둘째, MBTI의 역할을 랭킹 가중치·코스 구조·설명 톤으로 한정하고 사실 생성에는 관여시키지 않습니다. 셋째, 모든 정류장이 사용자 영상에서 나온 근거를 최소 하나 갖도록 강제해서 "영상 기반 취향 분석"이라는 우리 서비스의 핵심 주장이 결과물에서 실제로 확인되게 만듭니다.
