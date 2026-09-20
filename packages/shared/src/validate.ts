import { z } from 'zod';

import { getTypeProfile, loadCourseProfile } from './profile';
import { parseHourRange } from './rank';
import type { CandidatePlace, CoursePlan, CourseProfile, CourseRequest } from './types';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const categorySchema = z.enum([
  'restaurant', 'cafe_dessert', 'travel_attraction', 'accommodation',
  'culture_exhibition', 'activity_experience', 'shopping_product', 'beauty_wellness',
]);

const whySchema = z.strictObject({
  tasteEvidence: z.array(z.string()).min(1),
  similarUserEvidence: z.string().nullable().optional(),
  mbtiFit: z.string().min(1),
});

const stopSchema = z.strictObject({
  order: z.number().int().min(1).max(4),
  slot: z.enum(['meal', 'cafe_dessert', 'experience', 'finale']),
  placeId: z.string().min(1),
  name: z.string().min(1),
  category: categorySchema.nullable(),
  source: z.enum(['saved', 'external']),
  startTime: z.string().regex(TIME),
  endTime: z.string().regex(TIME),
  durationMin: z.number().int().min(0),
  estimatedCostPerPerson: z.number().int().min(0).nullable(),
  why: whySchema,
  moveToNext: z.strictObject({
    mode: z.enum(['도보', '대중교통', '택시']),
    minutes: z.number().int().min(0),
    estimated: z.boolean(),
  }).nullable(),
  reservationAction: z.string().nullable(),
  alternatives: z.array(z.strictObject({
    placeId: z.string().min(1),
    name: z.string().nullable(),
    reason: z.string().min(1),
  })).length(2),
  cautions: z.array(z.string()),
  sponsoredNotice: z.string().nullable(),
});

export const courseResponseSchema = z.strictObject({
  mbti: z.string().regex(/^[EI][SN][TF][JP]$/),
  characterName: z.string().min(1),
  courseTitle: z.string().min(1),
  courseSummary: z.string().min(1),
  totalDurationMin: z.number().int().min(0),
  estimatedBudgetPerPerson: z.number().int().min(0).nullable(),
  budgetNote: z.string().nullable(),
  budgetOverrun: z.strictObject({ amount: z.number().min(0), ratio: z.number().min(0) }).nullable(),
  tasteVectorConfidence: z.enum(['high', 'medium', 'low']).nullable(),
  savedPlaceCount: z.number().int().min(0),
  externalRatio: z.number().min(0).max(1),
  stops: z.array(stopSchema).min(3).max(4),
  mbtiRationale: z.string().min(1),
  verificationRequired: z.array(z.string()),
  cautions: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  stopOrder?: number;
  placeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  metrics: { evidenceCoverage: number; factualityErrors: number };
}

function toMinutes(time: string): number | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

const FACTUALITY_CODES = new Set([
  'schema', 'unknown-place', 'unknown-alternative', 'price-mismatch', 'source-mismatch',
  'missing-sponsored-notice', 'dropped-caution', 'outside-opening-hours',
  'missing-taste-evidence', 'duplicate-place', 'duplicate-alternative',
  'character-name-mismatch',
]);

export function validateCourseResponse(
  response: unknown,
  request: CourseRequest,
  options: { profile?: CourseProfile } = {},
): ValidationResult {
  const profile = options.profile ?? loadCourseProfile();
  const issues: ValidationIssue[] = [];
  const parsed = courseResponseSchema.safeParse(response);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ code: 'schema', severity: 'error', message: `${issue.path.join('.') || '/'} ${issue.message}` });
    }
    return { ok: false, issues, metrics: { evidenceCoverage: 0, factualityErrors: issues.length } };
  }

  const course = parsed.data as CoursePlan;
  const byId = new Map<string, CandidatePlace>(request.candidatePlaces.map((place) => [place.placeId, place]));
  const selectedIds = new Set(course.stops.map((stop) => stop.placeId));
  const expectedCharacter = getTypeProfile(profile, request.user.mbti).characterName;
  const maxMoveMinutes = request.user.constraints.maxLegMinutes ?? profile.courseComposition.maxMoveMinutes ?? 25;
  const maxDurationMin = request.user.constraints.maxDurationMin ?? profile.courseComposition.maxDurationMin ?? 300;
  const minSavedPlaces = profile.courseComposition.minSavedPlaces ?? 2;
  const maxExternalRatio = profile.courseComposition.maxExternalRatio ?? 0.5;
  const budgetTolerance = request.user.constraints.budgetToleranceRate ?? profile.courseComposition.budgetTolerance ?? 0.1;

  if (course.mbti !== request.user.mbti) {
    issues.push({ code: 'mbti-mismatch', severity: 'error', message: '요청 MBTI와 결과 MBTI가 다릅니다.' });
  }
  if (course.characterName !== expectedCharacter) {
    issues.push({ code: 'character-name-mismatch', severity: 'error', message: `characterName은 ${expectedCharacter}이어야 합니다.` });
  }

  const seen = new Set<string>();
  let evidenceFilled = 0;
  let budgetSum = 0;

  course.stops.forEach((stop, index) => {
    const place = byId.get(stop.placeId);
    const at = { stopOrder: stop.order, placeId: stop.placeId };
    if (!place) {
      issues.push({ code: 'unknown-place', severity: 'error', message: '후보군에 없는 장소입니다.', ...at });
      return;
    }

    if (stop.order !== index + 1) issues.push({ code: 'invalid-order', severity: 'error', message: '정류장 순서가 연속적이지 않습니다.', ...at });
    if (seen.has(stop.placeId)) issues.push({ code: 'duplicate-place', severity: 'error', message: '같은 장소가 두 번 등장합니다.', ...at });
    seen.add(stop.placeId);

    if (stop.source !== (place.source ?? 'external')) {
      issues.push({ code: 'source-mismatch', severity: 'error', message: '장소 출처가 후보 데이터와 다릅니다.', ...at });
    }

    const alternativeIds = new Set<string>();
    for (const alternative of stop.alternatives) {
      if (!byId.has(alternative.placeId)) issues.push({ code: 'unknown-alternative', severity: 'error', message: `후보에 없는 대안 ${alternative.placeId}입니다.`, ...at });
      if (selectedIds.has(alternative.placeId) || alternativeIds.has(alternative.placeId)) {
        issues.push({ code: 'duplicate-alternative', severity: 'error', message: '대안이 선택 장소 또는 다른 대안과 중복됩니다.', ...at });
      }
      alternativeIds.add(alternative.placeId);
    }

    const expectedPrice = place.price?.perPerson ?? null;
    if (stop.estimatedCostPerPerson !== expectedPrice) issues.push({ code: 'price-mismatch', severity: 'error', message: '후보 가격과 결과 가격이 다릅니다.', ...at });
    if (expectedPrice !== null) budgetSum += expectedPrice;

    if (place.sponsored && !stop.sponsoredNotice) issues.push({ code: 'missing-sponsored-notice', severity: 'error', message: '광고·협찬 표시가 없습니다.', ...at });
    for (const caution of place.cautions ?? []) {
      if (!stop.cautions.some((item) => item.includes(caution) || caution.includes(item))) {
        issues.push({ code: 'dropped-caution', severity: 'error', message: `주의사항이 누락됐습니다: ${caution}`, ...at });
      }
    }

    if (stop.why.tasteEvidence.length > 0) evidenceFilled += 1;
    else issues.push({ code: 'missing-taste-evidence', severity: 'error', message: '영상 취향 근거가 없습니다.', ...at });

    const open = place.openingHours ? parseHourRange(place.openingHours) : null;
    const start = toMinutes(stop.startTime ?? '');
    const end = toMinutes(stop.endTime ?? '');
    if (open && start !== null && end !== null && (start < open.start || end > open.end)) {
      issues.push({ code: 'outside-opening-hours', severity: 'error', message: `${stop.startTime}-${stop.endTime}이 영업시간 밖입니다.`, ...at });
    }

    const isLast = index === course.stops.length - 1;
    if (!isLast && !stop.moveToNext) issues.push({ code: 'missing-move', severity: 'error', message: '다음 장소 이동 정보가 없습니다.', ...at });
    if (isLast && stop.moveToNext) issues.push({ code: 'trailing-move', severity: 'error', message: '마지막 장소에는 이동 정보가 없어야 합니다.', ...at });
    if (stop.moveToNext && stop.moveToNext.minutes > maxMoveMinutes) issues.push({ code: 'too-far', severity: 'error', message: `이동 시간이 ${maxMoveMinutes}분을 초과합니다.`, ...at });
    if (stop.moveToNext?.mode === '택시' && !request.user.constraints.hard?.allowTaxi) issues.push({ code: 'taxi-not-allowed', severity: 'error', message: '택시가 허용되지 않았습니다.', ...at });
  });

  if (course.totalDurationMin > maxDurationMin) issues.push({ code: 'course-too-long', severity: 'error', message: `총 코스 시간이 ${maxDurationMin}분을 초과합니다.` });
  if (course.savedPlaceCount < minSavedPlaces) issues.push({ code: 'too-few-saved-places', severity: 'error', message: `저장 장소가 최소 ${minSavedPlaces}곳 필요합니다.` });
  if (course.externalRatio > maxExternalRatio) issues.push({ code: 'too-many-external-places', severity: 'error', message: '외부 장소 비율이 50%를 초과합니다.' });

  const budgetLimit = request.user.constraints.budgetPerPerson;
  if (budgetLimit !== undefined && budgetSum > budgetLimit) {
    issues.push({
      code: 'budget-exceeded',
      severity: budgetSum > budgetLimit * (1 + budgetTolerance) ? 'error' : 'warning',
      message: `1인 예산 ${budgetSum}원이 요청 예산 ${budgetLimit}원을 초과합니다.`,
    });
  }

  const factualityErrors = issues.filter((issue) => issue.severity === 'error' && FACTUALITY_CODES.has(issue.code)).length;
  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    issues,
    metrics: {
      evidenceCoverage: course.stops.length === 0 ? 0 : evidenceFilled / course.stops.length,
      factualityErrors,
    },
  };
}
