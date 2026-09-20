export type EI = 'E' | 'I';
export type SN = 'S' | 'N';
export type TF = 'T' | 'F';
export type JP = 'J' | 'P';
export type Mbti = `${EI}${SN}${TF}${JP}`;

export type AxisName =
  | 'crowdTolerance'
  | 'experienceMode'
  | 'rationaleStyle'
  | 'scheduleRigidity';

export type Pole = 'negative' | 'positive';

/** transcript-extraction.json의 contentCategories 키. lib/api/types.ts의 PlaceCategory와는 다르다 (categories.ts 참고). */
export type ContentCategory =
  | 'restaurant'
  | 'cafe_dessert'
  | 'travel_attraction'
  | 'accommodation'
  | 'culture_exhibition'
  | 'activity_experience'
  | 'shopping_product'
  | 'beauty_wellness';

export type SlotName = 'meal' | 'cafe_dessert' | 'experience' | 'finale';

export type Confidence = 'high' | 'medium' | 'low';

export type TravelMode = '도보' | '대중교통' | '택시';

/** 체크리스트 §1.4. 저장 장소 최소 포함 수와 외부 장소 비율 상한을 강제하려면 출처를 알아야 한다. */
export type PlaceSource = 'saved' | 'external';

/* ------------------------------------------------------------------ */
/* mbti-course-profile.json                                            */
/* ------------------------------------------------------------------ */

export interface AxisPole {
  description: string;
  preferredSignals?: string[];
  avoidSignals?: string[];
  preferredCategories?: ContentCategory[];
  preferredAudiences?: string[];
  avoidAudiences?: string[];
  preferredOccasions?: string[];
  structureRules?: string[];
  toneRules?: string[];
}

export interface Axis {
  label: string;
  poles: Record<Pole, string>;
  rankingWeight: number;
  rankingWeightNote?: string;
  negative: AxisPole;
  positive: AxisPole;
}

export interface MbtiTypeProfile {
  characterName: string;
  oneLineConcept: string;
  axisValues: Record<AxisName, number>;
  overrides: string[];
}

export interface BlendingWeights {
  userTasteVector: number;
  similarUserSignal: number;
  mbtiAxes: number;
}

export interface CourseProfile {
  version: number;
  updatedAt: string;
  description: string;
  designPrinciples: string[];
  axes: Record<AxisName, Axis>;
  scoring: {
    axisFitFormula: string;
    mbtiFitFormula: string;
    finalScoreFormula: string;
    notes: string[];
  };
  blending: {
    weights: BlendingWeights;
    rule: string;
    tieBreaker: string;
    lowConfidenceFallback: {
      trigger: string;
      weights: BlendingWeights;
      extraRule: string;
    };
  };
  courseComposition: {
    minStops?: number;
    maxStops?: number;
    candidateLimit?: number;
    minSavedPlaces?: number;
    maxExternalRatio?: number;
    maxMoveMinutes?: number;
    maxWalkMinutes?: number;
    budgetTolerance?: number;
    maxDurationMin?: number;
    slotTemplate: SlotName[];
    slotMapping: Record<SlotName, ContentCategory[]>;
    defaultDurationMin?: Record<SlotName, number>;
    rules: string[];
  };
  guardrails: string[];
  types: Record<Mbti, MbtiTypeProfile>;
  evaluationTargets: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 코스 생성 요청                                                        */
/* ------------------------------------------------------------------ */

export interface TasteEvidenceEntry {
  tag: string;
  sourceVideoId: string;
  count: number;
}

export interface TasteVector {
  categories?: Partial<Record<ContentCategory, number>>;
  features?: Record<string, number>;
  audiences?: string[];
  evidence?: TasteEvidenceEntry[];
}

/**
 * 체크리스트 §2.2에서 확정한 하드 제약. 취향 점수가 아니라 후보 제외 기준이다.
 * 값이 undefined면 "묻지 않음"이고 false와 다르다.
 */
export interface HardConstraints {
  vegetarian?: boolean;
  noSpicy?: boolean;
  limitedWalking?: boolean;
  withChildren?: boolean;
  withPet?: boolean;
  needsParking?: boolean;
  allowTaxi?: boolean;
}

export interface UserConstraints {
  region?: string;
  startStation?: string;
  date?: string;
  timeRange?: string;
  participantCount?: number;
  budgetPerPerson?: number;
  budgetToleranceRate?: number;
  maxDurationMin?: number;
  maxLegMinutes?: number;
  maxWalkMinutes?: number;
  pinnedPlaceIds?: string[];
  forbiddenPlaceIds?: string[];
  hard?: HardConstraints;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface CandidatePlace {
  placeId: string;
  title: string;
  category: ContentCategory | null;
  subcategory?: string | null;
  /** 체크리스트 §1.4. 지정하지 않으면 external로 간주한다. */
  source?: PlaceSource;
  location?: {
    name?: string | null;
    address?: string | null;
    nearestStation?: string | null;
    regionTags?: string[];
    coords?: GeoPoint | null;
  };
  price?: {
    amounts?: number[];
    perPerson?: number | null;
    priceLevel?: string | null;
    discount?: string | null;
  };
  features?: string[];
  normalizedHashtags?: string[];
  occasions?: string[];
  benefits?: string[];
  recommendedAudiences?: Array<{ id: string } | string>;
  constraints?: Record<string, string | null>;
  openingHours?: string | null;
  cautions?: string[];
  sponsored?: boolean;
  similarUserSignal?: { likeRate?: number; cohortRank?: number };
  sourceEvidence?: Array<{ source: string; text: string }>;
}

export interface CourseRequest {
  user: {
    mbti: Mbti;
    tasteVectorConfidence?: Confidence;
    savedVideoCount?: number;
    tasteVector: TasteVector;
    constraints: UserConstraints;
  };
  similarUsers?: { cohortSize: number; similarity: number };
  candidatePlaces: CandidatePlace[];
}

/* ------------------------------------------------------------------ */
/* LLM 출력 (course-draft.schema.json)                                  */
/* ------------------------------------------------------------------ */

export interface DraftWhy {
  tasteEvidence: string[];
  similarUserEvidence?: string | null;
  mbtiFit: string;
}

/**
 * 체크리스트 §1.5. LLM은 장소 선택, 순서, 이유만 만든다.
 * 시각, 소요 시간, 이동 시간, 예산은 코드가 계산한다 (schedule.ts).
 */
export interface DraftStop {
  order: number;
  slot: SlotName;
  placeId: string;
  name: string;
  category: ContentCategory | null;
  why: DraftWhy;
  alternatives: Array<{ placeId: string; name: string | null; reason: string }>;
  cautions: string[];
  sponsoredNotice: string | null;
}

export interface CourseDraft {
  mbti: Mbti;
  characterName: string;
  courseTitle: string;
  courseSummary: string;
  stops: DraftStop[];
  mbtiRationale: string;
  verificationRequired: string[];
  cautions: string[];
}

/* ------------------------------------------------------------------ */
/* 최종 코스 (코드가 계산해 채운 결과)                                     */
/* ------------------------------------------------------------------ */

export interface TravelLeg {
  mode: TravelMode;
  minutes: number;
  /** 실제 경로 API를 쓴 값인지, 좌표·지역 기반 추정인지 */
  estimated: boolean;
}

export interface PlannedStop {
  order: number;
  slot: SlotName;
  placeId: string;
  name: string;
  category: ContentCategory | null;
  source: PlaceSource;
  startTime: string;
  endTime: string;
  durationMin: number;
  estimatedCostPerPerson: number | null;
  why: DraftWhy;
  moveToNext: TravelLeg | null;
  reservationAction: string | null;
  alternatives: Array<{ placeId: string; name: string | null; reason: string }>;
  cautions: string[];
  sponsoredNotice: string | null;
}

export interface CoursePlan {
  mbti: Mbti;
  characterName: string;
  courseTitle: string;
  courseSummary: string;
  totalDurationMin: number;
  estimatedBudgetPerPerson: number | null;
  budgetNote: string | null;
  budgetOverrun: { amount: number; ratio: number } | null;
  tasteVectorConfidence: Confidence | null;
  savedPlaceCount: number;
  externalRatio: number;
  stops: PlannedStop[];
  mbtiRationale: string;
  verificationRequired: string[];
  cautions: string[];
  warnings: string[];
}

/** 기존 평가 하니스와 공개 계약에서 쓰는 이름. */
export type CourseResponse = CoursePlan;

export interface RecommendationViolation {
  code: string;
  message: string;
  placeId?: string;
}

export interface RecommendationResult {
  status: 'validated';
  course: CoursePlan;
  violations: RecommendationViolation[];
  diagnostics: {
    attempts: number;
    excludedCandidates: Array<{ placeId: string; reasons: string[] }>;
    modelId: string;
  };
}

export const ALL_MBTI: Mbti[] = [
  'INTJ', 'INTP', 'ENTJ', 'ENTP',
  'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
  'ISTP', 'ISFP', 'ESTP', 'ESFP',
];

export const AXIS_ORDER: AxisName[] = [
  'crowdTolerance',
  'experienceMode',
  'rationaleStyle',
  'scheduleRigidity',
];
