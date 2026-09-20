import { loadCourseProfile } from './profile';
import { parseHourRange, resolveOpeningTimeline, type OpeningWindow } from './opening-hours';
import type {
  CandidatePlace,
  CourseDraft,
  CoursePlan,
  CourseProfile,
  CourseRequest,
  GeoPoint,
  PlaceSource,
  PlannedStop,
  TravelLeg,
} from './types';

/**
 * 체크리스트 §1.5. LLM은 장소 선택·순서·이유만 만들고, 시간표·이동·예산은 여기서 계산한다.
 * 영업시간 충돌과 이동 시간 오산을 프롬프트 지시가 아니라 코드로 잡기 위해서다.
 */

/* ------------------------------------------------------------------ */
/* 이동 시간 제공자                                                      */
/* ------------------------------------------------------------------ */

export interface TravelQuery {
  from: CandidatePlace;
  to: CandidatePlace;
  allowTaxi: boolean;
  maxWalkMinutes: number;
  maxMoveMinutes: number;
}

export interface TravelProvider {
  estimate(query: TravelQuery): Promise<TravelLeg> | TravelLeg;
}

const WALK_METERS_PER_MIN = 75; // 4.5km/h
const TRANSIT_METERS_PER_MIN = 300; // 18km/h, 표정속도
const TRANSIT_OVERHEAD_MIN = 8; // 도보 접근 + 대기 + 환승
const TAXI_METERS_PER_MIN = 400;
const TAXI_OVERHEAD_MIN = 5;

function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 경로 API가 붙기 전까지 쓰는 기본 구현 (체크리스트 §6.2 미확정).
 * 좌표가 있으면 직선거리로, 없으면 역·지역 태그로 거칠게 추정한다.
 * 어느 쪽이든 estimated: true로 표시해 사용자에게 추정값임을 알릴 수 있게 한다.
 */
export const fallbackTravelProvider: TravelProvider = {
  estimate({ from, to, allowTaxi, maxWalkMinutes, maxMoveMinutes }): TravelLeg {
    const a = from.location?.coords;
    const b = to.location?.coords;

    if (!a || !b) return coarseEstimate(from, to, maxMoveMinutes);

    const meters = haversineMeters(a, b);
    // 직선거리는 실제 보행 경로보다 짧다. 도시 격자 보정.
    const routed = meters * 1.3;

    const walk = Math.ceil(routed / WALK_METERS_PER_MIN);
    if (walk <= maxWalkMinutes) return { mode: '도보', minutes: walk, estimated: true };

    const transit = Math.ceil(routed / TRANSIT_METERS_PER_MIN) + TRANSIT_OVERHEAD_MIN;
    if (transit <= maxMoveMinutes || !allowTaxi) {
      return { mode: '대중교통', minutes: transit, estimated: true };
    }

    // 체크리스트 §2.3: 택시는 사용자가 허용했고 대중교통이 한도를 넘을 때만.
    const taxi = Math.ceil(routed / TAXI_METERS_PER_MIN) + TAXI_OVERHEAD_MIN;
    return { mode: '택시', minutes: taxi, estimated: true };
  },
};

function coarseEstimate(
  from: CandidatePlace,
  to: CandidatePlace,
  maxMoveMinutes: number,
): TravelLeg {
  const stationA = from.location?.nearestStation;
  const stationB = to.location?.nearestStation;
  if (stationA && stationB && stationA === stationB) {
    return { mode: '도보', minutes: 8, estimated: true };
  }

  return { mode: '대중교통', minutes: maxMoveMinutes + 1, estimated: true };
}

/* ------------------------------------------------------------------ */
/* 시간 유틸                                                            */
/* ------------------------------------------------------------------ */

function formatMinutes(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function openingWindows(place: CandidatePlace, date: string): OpeningWindow[] | null {
  if (!place.openingHours) return null;
  const resolution = resolveOpeningTimeline(place.openingHours, date);
  return resolution.status === 'unknown' ? null : resolution.windows;
}

function waitingMinutes(place: CandidatePlace): number {
  const waiting = place.constraints?.waiting;
  const match = waiting?.match(/(\d+)\s*분/);
  return match ? Number(match[1]) : 0;
}

/* ------------------------------------------------------------------ */
/* 코스 계산                                                            */
/* ------------------------------------------------------------------ */

export interface PlanOptions {
  profile?: CourseProfile;
  travel?: TravelProvider;
}

function resolveSource(place: CandidatePlace): PlaceSource {
  return place.source ?? 'external';
}

function reservationActionFor(place: CandidatePlace): string | null {
  const reservation = place.constraints?.reservation;
  if (!reservation || !reservation.includes('예약')) return null;

  return reservation.includes('필수')
    ? `${place.title}은 예약 필수입니다. 방문 2일 전까지 예약하세요.`
    : `${place.title}은 예약을 권장합니다.`;
}

const MIN_DURATION: Record<string, number> = {
  meal: 45,
  cafe_dessert: 30,
  experience: 45,
  finale: 30,
};

function fitVisit(
  windows: OpeningWindow[],
  earliestStart: number,
  desiredDuration: number,
  latestStart: number,
  minimumDuration: number,
): { start: number; duration: number } | null {
  for (const window of windows) {
    const start = Math.max(earliestStart, window.start);
    if (start > latestStart || start >= window.end) continue;
    if (window.lastOrder !== null && start > window.lastOrder) continue;
    const duration = Math.min(desiredDuration, window.end - start);
    if (duration >= minimumDuration) return { start, duration };
  }
  return null;
}

export async function planCourse(
  draft: CourseDraft,
  request: CourseRequest,
  options: PlanOptions = {},
): Promise<CoursePlan> {
  const profile = options.profile ?? loadCourseProfile();
  const travel = options.travel ?? fallbackTravelProvider;
  const composition = profile.courseComposition;
  const maxMoveMinutes = request.user.constraints.maxLegMinutes ?? composition.maxMoveMinutes ?? 25;
  const maxWalkMinutes = request.user.constraints.maxWalkMinutes ??
    (request.user.constraints.hard?.limitedWalking ? 10 : composition.maxWalkMinutes ?? 20);
  const maxDurationMin = request.user.constraints.maxDurationMin ?? composition.maxDurationMin ?? 300;
  const budgetTolerance =
    request.user.constraints.budgetToleranceRate ?? composition.budgetTolerance ?? 0.1;
  const defaultDuration: Record<string, number> = {
    meal: 75,
    cafe_dessert: 60,
    experience: 90,
    finale: 60,
    ...(composition.defaultDurationMin ?? {}),
  };

  const byId = new Map(request.candidatePlaces.map((place) => [place.placeId, place]));
  const allowTaxi = request.user.constraints.hard?.allowTaxi ?? false;
  const requested = request.user.constraints.timeRange
    ? parseHourRange(request.user.constraints.timeRange)
    : null;

  const warnings: string[] = [];
  const verificationRequired: string[] = [...draft.verificationRequired];
  const cautions = new Set<string>(draft.cautions);

  const ordered = [...draft.stops].sort((a, b) => a.order - b.order);
  const stops: PlannedStop[] = [];

  let cursor = requested?.start ?? 12 * 60;
  let budgetSum = 0;
  let pricedCount = 0;
  let unpricedCount = 0;

  for (const [index, draftStop] of ordered.entries()) {
    const place = byId.get(draftStop.placeId);
    if (!place) {
      warnings.push(`후보에 없는 장소 ${draftStop.placeId}를 건너뛰었습니다.`);
      continue;
    }

    const windows = openingWindows(place, request.user.constraints.date ?? '');
    let duration = defaultDuration[draftStop.slot] ?? 60;
    let start = cursor + waitingMinutes(place);

    if (windows) {
      const fitted = fitVisit(
        windows,
        start,
        duration,
        requested?.end ?? start + maxDurationMin,
        MIN_DURATION[draftStop.slot] ?? 30,
      );
      if (!fitted) {
        warnings.push(`${place.title}을 요청 시간 안에 이용할 수 없습니다. 순서를 바꾸거나 교체하세요.`);
      } else {
        start = fitted.start;
        if (fitted.duration < duration) {
          duration = fitted.duration;
          warnings.push(`${place.title}의 마감 시각에 맞춰 체류 시간을 ${duration}분으로 줄였습니다.`);
        }
      }
    } else {
      verificationRequired.push(`${place.title} 영업시간`);
    }

    const end = start + duration;

    const perPerson = place.price?.perPerson ?? null;
    if (perPerson === null) {
      unpricedCount += 1;
      verificationRequired.push(`${place.title} 1인 예산`);
    } else {
      budgetSum += perPerson;
      pricedCount += 1;
    }

    for (const caution of place.cautions ?? []) cautions.add(`${place.title}: ${caution}`);

    const nextDraft = ordered[index + 1];
    const nextPlace = nextDraft ? byId.get(nextDraft.placeId) : undefined;

    let moveToNext: TravelLeg | null = null;
    if (nextPlace) {
      moveToNext = await travel.estimate({
        from: place,
        to: nextPlace,
        allowTaxi,
        maxWalkMinutes,
        maxMoveMinutes,
      });

      if (moveToNext.minutes > maxMoveMinutes) {
        warnings.push(
          `${place.title} → ${nextPlace.title} 이동이 ${moveToNext.minutes}분으로 한도 ${maxMoveMinutes}분을 넘습니다.`,
        );
      }
    }

    stops.push({
      order: draftStop.order,
      slot: draftStop.slot,
      placeId: place.placeId,
      name: place.title,
      category: place.category,
      source: resolveSource(place),
      startTime: formatMinutes(start),
      endTime: formatMinutes(end),
      durationMin: duration,
      estimatedCostPerPerson: perPerson,
      why: draftStop.why,
      moveToNext,
      reservationAction: reservationActionFor(place),
      alternatives: draftStop.alternatives.map((alternative) => ({
        placeId: alternative.placeId,
        name: byId.get(alternative.placeId)?.title ?? null,
        reason: alternative.reason,
      })),
      cautions: [...(place.cautions ?? [])],
      sponsoredNotice: place.sponsored
        ? '광고·협찬 콘텐츠에서 수집된 장소입니다.'
        : null,
    });

    cursor = end + (moveToNext?.minutes ?? 0);
  }

  const totalDurationMin = cursor - (requested?.start ?? 12 * 60);

  if (totalDurationMin > maxDurationMin) {
    warnings.push(`총 코스 시간이 ${totalDurationMin}분으로 한도 ${maxDurationMin}분을 넘습니다.`);
  }

  if (requested && cursor > requested.end) {
    warnings.push(
      `코스가 요청 시간대(${request.user.constraints.timeRange})보다 ${cursor - requested.end}분 늦게 끝납니다.`,
    );
  }

  // 체크리스트 §2.4: 총예산의 10%까지 초과를 허용하되 경고한다.
  const budgetLimit = request.user.constraints.budgetPerPerson;
  let budgetOverrun: CoursePlan['budgetOverrun'] = null;
  if (budgetLimit !== undefined && budgetSum > budgetLimit) {
    const amount = budgetSum - budgetLimit;
    const ratio = amount / budgetLimit;
    budgetOverrun = { amount, ratio };
    warnings.push(
      ratio <= budgetTolerance
        ? `1인 예산이 ${amount.toLocaleString()}원(${(ratio * 100).toFixed(0)}%) 초과합니다.`
        : `1인 예산이 허용 범위(${budgetTolerance * 100}%)를 넘어 ${amount.toLocaleString()}원 초과합니다.`,
    );
  }

  const savedPlaceCount = stops.filter((stop) => stop.source === 'saved').length;
  const externalRatio = stops.length === 0 ? 0 : 1 - savedPlaceCount / stops.length;

  const minSavedPlaces = composition.minSavedPlaces ?? 2;
  const maxExternalRatio = composition.maxExternalRatio ?? 0.5;
  if (savedPlaceCount < minSavedPlaces) {
    warnings.push(
      `저장한 장소가 ${savedPlaceCount}곳뿐입니다. 최소 ${minSavedPlaces}곳이 필요합니다.`,
    );
  }
  if (externalRatio > maxExternalRatio) {
    warnings.push(
      `외부 추천 장소 비율이 ${(externalRatio * 100).toFixed(0)}%로 상한 ${maxExternalRatio * 100}%를 넘습니다.`,
    );
  }

  return {
    mbti: draft.mbti,
    characterName: draft.characterName,
    courseTitle: draft.courseTitle,
    courseSummary: draft.courseSummary,
    totalDurationMin,
    estimatedBudgetPerPerson: pricedCount > 0 ? budgetSum : null,
    budgetNote:
      unpricedCount > 0
        ? `가격 정보가 없는 ${unpricedCount}곳은 예산 합산에서 제외했습니다.`
        : null,
    budgetOverrun,
    tasteVectorConfidence: request.user.tasteVectorConfidence ?? null,
    savedPlaceCount,
    externalRatio,
    stops,
    mbtiRationale: draft.mbtiRationale,
    verificationRequired,
    cautions: [...cautions],
    warnings,
  };
}
