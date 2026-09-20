import { featureMappings } from './assets';
import { loadCourseProfile, resolveAxes, resolveWeights, type ResolvedAxis } from './profile';
import type { CandidatePlace, CourseProfile, CourseRequest, TasteVector } from './types';

/**
 * 후보를 12~15개로 미리 줄이기 위한 결정적 사전 랭커.
 * mbti-course-profile.json의 scoring 공식을 그대로 옮긴 것이며,
 * LLM은 이 순위를 참고하되 최종 코스 구성은 프롬프트 규칙에 따라 결정한다.
 */

const NEGATION_MARKERS = ["불가", "없음", "안 됨", "안됨", "어려", "제외", "금지", "불필요"];

let featureGroupIndex: Map<string, string> | null = null;

/** transcript-extraction.json의 featureMappings를 term -> group 인덱스로 뒤집는다. */
export function getFeatureGroupIndex(): Map<string, string> {
  if (featureGroupIndex) return featureGroupIndex;

  const index = new Map<string, string>();
  for (const [group, terms] of Object.entries(featureMappings())) {
    for (const term of terms) index.set(term, group);
  }

  featureGroupIndex = index;
  return index;
}

function audienceIds(place: CandidatePlace): string[] {
  return (place.recommendedAudiences ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.id,
  );
}

/** 장소를 신호 매칭 대상 토큰 목록으로 편다. */
export function placeSignalTokens(place: CandidatePlace): string[] {
  const tokens: string[] = [
    place.title,
    place.subcategory ?? "",
    ...(place.features ?? []),
    ...(place.normalizedHashtags ?? []),
    ...(place.occasions ?? []),
    ...(place.benefits ?? []),
    ...(place.cautions ?? []),
    ...audienceIds(place),
    ...Object.values(place.constraints ?? {}).filter((v): v is string => typeof v === "string"),
  ];

  // 구조화된 제약을 태그처럼 다룰 수 있도록 파생 토큰을 붙인다.
  const waiting = place.constraints?.waiting;
  if (waiting && !NEGATION_MARKERS.some((m) => waiting.includes(m))) tokens.push("웨이팅");

  const reservation = place.constraints?.reservation;
  if (reservation?.includes("예약")) {
    tokens.push("예약");
    if (reservation.includes("필수")) tokens.push("예약 필수");
  }

  return tokens.filter((token) => token.length > 0);
}

function tokenMatches(token: string, signal: string): boolean {
  if (!token.includes(signal)) return false;
  // 같은 토큰 안에 부정 표현이 있으면 긍정 신호로 세지 않는다.
  return !NEGATION_MARKERS.some((marker) => token.includes(marker) && !signal.includes(marker));
}

export function countSignalMatches(
  tokens: string[],
  signals: string[],
): { count: number; matched: string[] } {
  const matched = signals.filter((signal) => tokens.some((token) => tokenMatches(token, signal)));
  return { count: matched.length, matched };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export interface TasteFitResult {
  score: number;
  matchedTags: string[];
  matchedFeatureGroups: string[];
}

export function computeTasteFit(place: CandidatePlace, taste: TasteVector): TasteFitResult {
  const categoryScore = place.category ? (taste.categories?.[place.category] ?? 0) : 0;

  const index = getFeatureGroupIndex();
  const groups = new Set<string>();
  for (const feature of place.features ?? []) {
    const group = index.get(feature);
    if (group) groups.add(group);
  }
  const featureScore = mean([...groups].map((group) => taste.features?.[group] ?? 0));

  const tokens = placeSignalTokens(place);
  const matchedTags = (taste.evidence ?? [])
    .map((entry) => entry.tag)
    .filter((tag) => tokens.some((token) => tokenMatches(token, tag)));
  const evidenceScore = Math.min(1, matchedTags.length / 3);

  return {
    score: clamp(0.45 * categoryScore + 0.35 * featureScore + 0.2 * evidenceScore, 0, 1),
    matchedTags,
    matchedFeatureGroups: [...groups],
  };
}

export interface MbtiFitResult {
  score: number;
  matched: string[];
  avoided: string[];
}

export function computeMbtiFit(place: CandidatePlace, axes: ResolvedAxis[]): MbtiFitResult {
  const tokens = placeSignalTokens(place);
  const ids = audienceIds(place);
  const matchedAll: string[] = [];
  const avoidedAll: string[] = [];

  let weightedSum = 0;
  let weightTotal = 0;

  for (const axis of axes) {
    const def = axis.definition;

    const preferred = countSignalMatches(tokens, [
      ...(def.preferredSignals ?? []),
      ...(def.preferredOccasions ?? []),
    ]);
    const categoryHit =
      place.category && def.preferredCategories?.includes(place.category) ? 1 : 0;
    const audienceHit = (def.preferredAudiences ?? []).filter((a) => ids.includes(a)).length;

    const avoided = countSignalMatches(tokens, def.avoidSignals ?? []);
    const avoidAudienceHit = (def.avoidAudiences ?? []).filter((a) => ids.includes(a)).length;

    const positives = preferred.count + categoryHit + audienceHit;
    const negatives = avoided.count + avoidAudienceHit;

    const raw = clamp((positives - negatives) / 2, -1, 1);
    weightedSum += raw * Math.abs(axis.value) * axis.rankingWeight;
    weightTotal += axis.rankingWeight;

    matchedAll.push(...preferred.matched);
    avoidedAll.push(...avoided.matched);
  }

  const score = weightTotal === 0 ? 0.5 : clamp(0.5 + 0.5 * (weightedSum / weightTotal), 0, 1);

  return {
    score,
    matched: [...new Set(matchedAll)],
    avoided: [...new Set(avoidedAll)],
  };
}

/* ------------------------------------------------------------------ */
/* 하드 제약                                                            */
/* ------------------------------------------------------------------ */

export function parseHourRange(value: string): { start: number; end: number } | null {
  if (value.includes("24시간")) return { start: 0, end: 24 * 60 };

  const match = value.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const [, sh, sm, eh, em] = match;
  const start = Number(sh) * 60 + Number(sm);
  let end = Number(eh) * 60 + Number(em);
  if (end <= start) end += 24 * 60; // 새벽 마감

  return { start, end };
}

function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

export interface ConstraintCheck {
  passed: boolean;
  reasons: string[];
}

export function checkHardConstraints(
  place: CandidatePlace,
  constraints: CourseRequest["user"]["constraints"],
): ConstraintCheck {
  const reasons: string[] = [];
  const tokens = placeSignalTokens(place);

  if ((constraints.forbiddenPlaceIds ?? []).includes(place.placeId)) {
    reasons.push("사용자가 제외한 장소");
  }

  if (constraints.region) {
    const region = constraints.region;
    const inRegion =
      (place.location?.regionTags ?? []).some((tag) => tag.includes(region)) ||
      (place.location?.nearestStation ?? "").includes(region) ||
      (place.location?.name ?? "").includes(region);
    if (!inRegion) reasons.push(`요청 지역(${region}) 밖`);
  }

  const perPerson = place.price?.perPerson;
  if (
    constraints.budgetPerPerson !== undefined &&
    perPerson !== undefined &&
    perPerson !== null &&
    perPerson > constraints.budgetPerPerson
  ) {
    reasons.push(`1인 예산 초과 (${perPerson} > ${constraints.budgetPerPerson})`);
  }

  if (constraints.timeRange && place.openingHours) {
    const requested = parseHourRange(constraints.timeRange);
    const open = parseHourRange(place.openingHours);
    if (requested && open && !rangesOverlap(requested, open)) {
      reasons.push(`요청 시간대(${constraints.timeRange})와 영업시간이 겹치지 않음`);
    }
  }

  const hasAny = (signals: string[]) =>
    signals.some((signal) => tokens.some((token) => token.includes(signal)));

  if (
    constraints.hard?.vegetarian &&
    place.category === "restaurant" &&
    !hasAny(["채식", "비건", "vegetarian", "vegan"])
  ) {
    reasons.push("채식 가능 여부를 확인할 수 없음");
  }
  if (constraints.hard?.noSpicy && hasAny(["매운", "마라", "불닭"])) {
    reasons.push("매운 음식 제외 조건과 충돌");
  }
  if (constraints.hard?.withChildren && !hasAny(["아이", "유아", "키즈", "가족", "child"])) {
    reasons.push("아동 동반 가능 여부를 확인할 수 없음");
  }
  if (constraints.hard?.withPet && !hasAny(["반려동물", "애견", "펫", "pet"])) {
    reasons.push("반려동물 동반 가능 여부를 확인할 수 없음");
  }
  if (constraints.hard?.needsParking && !hasAny(["주차", "parking"])) {
    reasons.push("주차 가능 여부를 확인할 수 없음");
  }

  return { passed: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* 랭킹                                                                */
/* ------------------------------------------------------------------ */

export interface RankedCandidate {
  place: CandidatePlace;
  tasteFit: number;
  similarUserFit: number;
  mbtiFit: number;
  finalScore: number;
  matchedTasteTags: string[];
  matchedMbtiSignals: string[];
  avoidedMbtiSignals: string[];
  hasTasteEvidence: boolean;
}

export interface RankResult {
  ranked: RankedCandidate[];
  excluded: Array<{ placeId: string; reasons: string[] }>;
}

export interface RankOptions {
  profile?: CourseProfile;
  /** LLM에 전달할 후보 수 상한. 계획서 8장의 컨텍스트 관리 항목에 대응한다. */
  limit?: number;
  /** 취향 근거가 전혀 없는 후보를 미리 떨어뜨릴지. 기본값 true (L0-3 규칙과 동일). */
  requireTasteEvidence?: boolean;
}

const TIE_BUCKET = 0.05;

export function rankCandidates(request: CourseRequest, options: RankOptions = {}): RankResult {
  const profile = options.profile ?? loadCourseProfile();
  const limit = options.limit ?? 30;
  const requireTasteEvidence = options.requireTasteEvidence ?? true;

  const axes = resolveAxes(profile, request.user.mbti);
  const { weights } = resolveWeights(profile, {
    tasteVectorConfidence: request.user.tasteVectorConfidence,
    savedVideoCount: request.user.savedVideoCount,
  });

  const excluded: RankResult["excluded"] = [];
  const scored: RankedCandidate[] = [];

  for (const place of request.candidatePlaces) {
    const constraintCheck = checkHardConstraints(place, request.user.constraints);
    if (!constraintCheck.passed) {
      excluded.push({ placeId: place.placeId, reasons: constraintCheck.reasons });
      continue;
    }

    const taste = computeTasteFit(place, request.user.tasteVector);
    const mbti = computeMbtiFit(place, axes);
    const similarUserFit = place.similarUserSignal?.likeRate ?? 0;

    const hasTasteEvidence = taste.matchedTags.length > 0 || taste.matchedFeatureGroups.length > 0;
    if (requireTasteEvidence && !hasTasteEvidence) {
      excluded.push({
        placeId: place.placeId,
        reasons: ["사용자 영상에서 나온 취향 근거를 연결할 수 없음"],
      });
      continue;
    }

    scored.push({
      place,
      tasteFit: taste.score,
      similarUserFit,
      mbtiFit: mbti.score,
      finalScore:
        taste.score * weights.userTasteVector +
        similarUserFit * weights.similarUserSignal +
        mbti.score * weights.mbtiAxes,
      matchedTasteTags: taste.matchedTags,
      matchedMbtiSignals: mbti.matched,
      avoidedMbtiSignals: mbti.avoided,
      hasTasteEvidence,
    });
  }

  // 0.05 단위로 버킷을 묶어 동점 구간에서는 mbtiFit이 높은 쪽을 앞세운다.
  const bucket = (score: number) => Math.round(score / TIE_BUCKET);
  scored.sort(
    (a, b) => bucket(b.finalScore) - bucket(a.finalScore) || b.mbtiFit - a.mbtiFit,
  );

  return { ranked: scored.slice(0, limit), excluded };
}

/** 사전 랭킹으로 후보를 줄인 요청 객체를 만든다. */
export function withRankedCandidates(
  request: CourseRequest,
  options: RankOptions = {},
): { request: CourseRequest; rank: RankResult } {
  const rank = rankCandidates(request, options);
  return {
    request: { ...request, candidatePlaces: rank.ranked.map((entry) => entry.place) },
    rank,
  };
}
