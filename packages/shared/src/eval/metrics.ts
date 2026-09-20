import type { CourseResponse, Mbti } from '../types';

/** 계획서 7장의 측정 항목 구현. */

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export interface CourseShape {
  mbti: Mbti;
  placeIds: Set<string>;
  stopCount: number;
  categories: string[];
  hasStartTimes: boolean;
  avgAlternatives: number;
  totalBudget: number | null;
}

export function describeCourse(course: CourseResponse): CourseShape {
  const alternatives = course.stops.map((stop) => stop.alternatives.length);

  return {
    mbti: course.mbti,
    placeIds: new Set(course.stops.map((stop) => stop.placeId)),
    stopCount: course.stops.length,
    categories: course.stops.map((stop) => stop.category ?? "unknown"),
    hasStartTimes: course.stops.every((stop) => Boolean(stop.startTime)),
    avgAlternatives:
      alternatives.length === 0
        ? 0
        : alternatives.reduce((sum, n) => sum + n, 0) / alternatives.length,
    totalBudget: course.estimatedBudgetPerPerson,
  };
}

/* ------------------------------------------------------------------ */
/* 7.1 유형 간 차별성                                                   */
/* ------------------------------------------------------------------ */

export interface DifferentiationReport {
  mean: number;
  min: number;
  max: number;
  pairCount: number;
  withinTarget: boolean;
  verdict: "ok" | "mbti-not-working" | "mbti-dominating" | "insufficient-data";
  mostSimilarPair?: [Mbti, Mbti];
  mostDifferentPair?: [Mbti, Mbti];
}

export const DIFFERENTIATION_TARGET = { min: 0.35, max: 0.6 } as const;

export function typeDifferentiation(shapes: CourseShape[]): DifferentiationReport {
  if (shapes.length < 2) {
    return {
      mean: 0,
      min: 0,
      max: 0,
      pairCount: 0,
      withinTarget: false,
      verdict: "insufficient-data",
    };
  }

  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let pairCount = 0;
  let mostSimilarPair: [Mbti, Mbti] | undefined;
  let mostDifferentPair: [Mbti, Mbti] | undefined;

  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      const a = shapes[i]!;
      const b = shapes[j]!;
      const score = jaccard(a.placeIds, b.placeIds);

      sum += score;
      pairCount += 1;
      if (score > max) {
        max = score;
        mostSimilarPair = [a.mbti, b.mbti];
      }
      if (score < min) {
        min = score;
        mostDifferentPair = [a.mbti, b.mbti];
      }
    }
  }

  const mean = sum / pairCount;
  const withinTarget = mean >= DIFFERENTIATION_TARGET.min && mean <= DIFFERENTIATION_TARGET.max;

  return {
    mean,
    min,
    max,
    pairCount,
    withinTarget,
    verdict: withinTarget
      ? "ok"
      : mean > DIFFERENTIATION_TARGET.max
        ? "mbti-not-working"
        : "mbti-dominating",
    mostSimilarPair,
    mostDifferentPair,
  };
}

/* ------------------------------------------------------------------ */
/* 7.2 단일 축 분리                                                     */
/* ------------------------------------------------------------------ */

/** 한 글자만 다른 쌍. __fixtures__/course-cases/README.md의 표와 대응한다. */
export const ISOLATION_PAIRS: Array<{
  pair: [Mbti, Mbti];
  axis: string;
  expectPlaceOverlapAbove?: number;
}> = [
  { pair: ["ENFP", "INFP"], axis: "crowdTolerance" },
  { pair: ["INFJ", "INFP"], axis: "scheduleRigidity", expectPlaceOverlapAbove: 0.66 },
  { pair: ["INFP", "INTP"], axis: "rationaleStyle", expectPlaceOverlapAbove: 0.66 },
  { pair: ["ISTJ", "INTJ"], axis: "experienceMode" },
];

export interface IsolationReport {
  pair: [Mbti, Mbti];
  axis: string;
  placeOverlap: number;
  stopCountDelta: number;
  startTimeDiffers: boolean;
  alternativesDelta: number;
  budgetDeltaRatio: number | null;
  passed: boolean;
  notes: string[];
}

export function axisIsolation(
  shapes: Map<Mbti, CourseShape>,
  pairs = ISOLATION_PAIRS,
): IsolationReport[] {
  const reports: IsolationReport[] = [];

  for (const { pair, axis, expectPlaceOverlapAbove } of pairs) {
    const [leftMbti, rightMbti] = pair;
    const left = shapes.get(leftMbti);
    const right = shapes.get(rightMbti);
    if (!left || !right) continue;

    const placeOverlap = jaccard(left.placeIds, right.placeIds);
    const budgetDeltaRatio =
      left.totalBudget && right.totalBudget
        ? Math.abs(left.totalBudget - right.totalBudget) /
          Math.max(left.totalBudget, right.totalBudget)
        : null;

    const notes: string[] = [];
    let passed = true;

    if (expectPlaceOverlapAbove !== undefined && placeOverlap < expectPlaceOverlapAbove) {
      passed = false;
      notes.push(
        `${axis}만 다른데 장소 집합이 크게 달라졌습니다 (겹침 ${placeOverlap.toFixed(2)} < ${expectPlaceOverlapAbove}). 축 신호가 서로 간섭할 수 있습니다.`,
      );
    }

    // 의도하지 않은 축이 10% 넘게 흔들렸는지
    if (axis !== "rationaleStyle" && budgetDeltaRatio !== null && budgetDeltaRatio > 0.1) {
      passed = false;
      notes.push(`예산이 ${(budgetDeltaRatio * 100).toFixed(0)}% 차이 납니다.`);
    }

    reports.push({
      pair,
      axis,
      placeOverlap,
      stopCountDelta: Math.abs(left.stopCount - right.stopCount),
      startTimeDiffers: left.hasStartTimes !== right.hasStartTimes,
      alternativesDelta: Math.abs(left.avgAlternatives - right.avgAlternatives),
      budgetDeltaRatio,
      passed,
      notes,
    });
  }

  return reports;
}
