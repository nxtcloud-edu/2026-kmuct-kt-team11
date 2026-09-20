import { z } from "zod";

import { getTypeProfile, loadCourseProfile } from "./profile";
import type {
  CandidatePlace,
  CourseDraft,
  CourseProfile,
  CourseRequest,
  RecommendationViolation,
} from "./types";

const categorySchema = z.enum([
  "restaurant",
  "cafe_dessert",
  "travel_attraction",
  "accommodation",
  "culture_exhibition",
  "activity_experience",
  "shopping_product",
  "beauty_wellness",
]);

const alternativeSchema = z.strictObject({
  placeId: z.string().min(1),
  name: z.string().nullable(),
  reason: z.string().min(1),
});

const draftStopSchema = z.strictObject({
  order: z.number().int().min(1).max(4),
  slot: z.enum(["meal", "cafe_dessert", "experience", "finale"]),
  placeId: z.string().min(1),
  name: z.string().min(1),
  category: categorySchema.nullable(),
  why: z.strictObject({
    tasteEvidence: z.array(z.string()).min(1),
    similarUserEvidence: z.string().nullable(),
    mbtiFit: z.string().min(1),
  }),
  alternatives: z.array(alternativeSchema).length(2),
  cautions: z.array(z.string()),
  sponsoredNotice: z.string().nullable(),
});

export const courseDraftSchema = z.strictObject({
  mbti: z.string().regex(/^[EI][SN][TF][JP]$/),
  characterName: z.string().min(1),
  courseTitle: z.string().min(1),
  courseSummary: z.string().min(1),
  stops: z.array(draftStopSchema).min(3).max(4),
  mbtiRationale: z.string().min(1),
  verificationRequired: z.array(z.string()),
  cautions: z.array(z.string()),
});

export function parseCourseDraft(value: unknown): CourseDraft {
  return courseDraftSchema.parse(value) as CourseDraft;
}

function sourceOf(place: CandidatePlace): "saved" | "external" {
  return place.source ?? "external";
}

export function validateCourseDraft(
  draft: CourseDraft,
  request: CourseRequest,
  options: { profile?: CourseProfile } = {},
): RecommendationViolation[] {
  const profile = options.profile ?? loadCourseProfile();
  const violations: RecommendationViolation[] = [];
  const places = new Map(request.candidatePlaces.map((place) => [place.placeId, place]));
  const selected = new Set<string>();
  const selectedIds = new Set(draft.stops.map((stop) => stop.placeId));
  const allowedEvidence = new Set(
    (request.user.tasteVector.evidence ?? []).map((entry) => entry.tag),
  );

  if (draft.mbti !== request.user.mbti) {
    violations.push({ code: "mbti-mismatch", message: "요청 MBTI와 응답 MBTI가 다릅니다." });
  }

  const expectedCharacter = getTypeProfile(profile, request.user.mbti).characterName;
  if (draft.characterName !== expectedCharacter) {
    violations.push({
      code: "character-name-mismatch",
      message: `캐릭터명은 ${expectedCharacter}이어야 합니다.`,
    });
  }

  for (const [index, stop] of draft.stops.entries()) {
    const place = places.get(stop.placeId);
    if (!place) {
      violations.push({
        code: "unknown-place",
        message: "후보군에 없는 장소입니다.",
        placeId: stop.placeId,
      });
      continue;
    }

    if (stop.order !== index + 1) {
      violations.push({
        code: "invalid-order",
        message: "정류장 순서는 1부터 연속이어야 합니다.",
        placeId: stop.placeId,
      });
    }

    if (selected.has(stop.placeId)) {
      violations.push({
        code: "duplicate-place",
        message: "같은 장소가 두 번 선택됐습니다.",
        placeId: stop.placeId,
      });
    }
    selected.add(stop.placeId);

    if (
      allowedEvidence.size > 0 &&
      !stop.why.tasteEvidence.some((evidence) =>
        [...allowedEvidence].some((tag) => evidence.includes(tag)),
      )
    ) {
      violations.push({
        code: "unsupported-taste-evidence",
        message: "사용자 영상의 태그로 확인할 수 없는 취향 근거입니다.",
        placeId: stop.placeId,
      });
    }

    const alternativeIds = new Set<string>();
    for (const alternative of stop.alternatives) {
      if (!places.has(alternative.placeId)) {
        violations.push({
          code: "unknown-alternative",
          message: "후보군에 없는 대안 장소입니다.",
          placeId: alternative.placeId,
        });
      }
      if (selectedIds.has(alternative.placeId) || alternativeIds.has(alternative.placeId)) {
        violations.push({
          code: "duplicate-alternative",
          message: "대안은 코스에 선택된 장소 및 다른 대안과 달라야 합니다.",
          placeId: alternative.placeId,
        });
      }
      alternativeIds.add(alternative.placeId);
    }

    if (place.sponsored && !stop.sponsoredNotice) {
      violations.push({
        code: "missing-sponsored-notice",
        message: "광고·협찬 장소 표시가 누락됐습니다.",
        placeId: stop.placeId,
      });
    }

    for (const caution of place.cautions ?? []) {
      if (!stop.cautions.some((value) => value.includes(caution) || caution.includes(value))) {
        violations.push({
          code: "dropped-caution",
          message: `주의사항이 누락됐습니다: ${caution}`,
          placeId: stop.placeId,
        });
      }
    }
  }

  const selectedPlaces = draft.stops
    .map((stop) => places.get(stop.placeId))
    .filter((place): place is CandidatePlace => Boolean(place));
  const savedCount = selectedPlaces.filter((place) => sourceOf(place) === "saved").length;
  const externalCount = selectedPlaces.length - savedCount;

  if (savedCount < 2) {
    violations.push({
      code: "too-few-saved-places",
      message: `저장 장소가 ${savedCount}곳입니다. 최소 2곳이 필요합니다.`,
    });
  }
  if (externalCount > Math.floor(selectedPlaces.length / 2)) {
    violations.push({
      code: "too-many-external-places",
      message: "외부 추천 장소가 전체 정류장의 50%를 넘습니다.",
    });
  }

  for (const pinned of request.user.constraints.pinnedPlaceIds ?? []) {
    if (!selected.has(pinned)) {
      violations.push({
        code: "missing-pinned-place",
        message: "사용자가 고정한 장소가 코스에서 빠졌습니다.",
        placeId: pinned,
      });
    }
  }

  return violations;
}
