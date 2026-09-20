import { ZodError } from "zod";

import {
  bedrockConfigFromEnv,
  callBedrockCourseDraft,
  type BedrockConfig,
} from "./bedrock";
import { parseCourseDraft, validateCourseDraft } from "./draft";
import { loadCourseProfile } from "./profile";
import { buildDateCoursePrompt } from "./prompt";
import { withRankedCandidates } from "./rank";
import { planCourse } from "./schedule";
import type {
  CourseDraft,
  CourseProfile,
  CourseRequest,
  RecommendationResult,
  RecommendationViolation,
} from "./types";
import { validateCourseResponse } from "./validate";

export type CourseModelCaller = (input: { system: string; user: string }) => Promise<string>;

export class RecommendationAgentError extends Error {
  constructor(
    readonly code:
      | "insufficient-candidates"
      | "invalid-model-response"
      | "constraints-unsatisfied",
    message: string,
    readonly violations: RecommendationViolation[] = [],
  ) {
    super(message);
    this.name = "RecommendationAgentError";
  }
}

export interface RecommendationAgentOptions {
  callModel?: CourseModelCaller;
  bedrock?: BedrockConfig;
  profile?: CourseProfile;
  maxAttempts?: number;
  modelId?: string;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  return JSON.parse(fenced ?? trimmed);
}

function zodViolations(error: ZodError): RecommendationViolation[] {
  return error.issues.map((issue) => ({
    code: "schema",
    message: `${issue.path.join(".") || "/"}: ${issue.message}`,
  }));
}

function repairPayload(options: {
  request: CourseRequest;
  previousDraft: unknown;
  violations: RecommendationViolation[];
  attempt: number;
}): string {
  return JSON.stringify(
    {
      task: "이전 초안에서 검증에 실패한 항목만 고쳐 완전한 JSON 초안을 다시 출력하세요.",
      repairAttempt: options.attempt,
      constraints: [
        "candidatePlaces의 placeId만 사용",
        "각 정류장의 대안은 정확히 2개",
        "시간, 이동 시간, 비용 합계는 출력하지 않음",
        "violations에 언급되지 않은 유효한 선택은 가능한 한 유지",
      ],
      violations: options.violations,
      previousDraft: options.previousDraft,
      originalRequest: options.request,
    },
    null,
    2,
  );
}

function preflight(request: CourseRequest): void {
  if (request.candidatePlaces.length < 5) {
    throw new RecommendationAgentError(
      "insufficient-candidates",
      "코스 3곳과 대안 2곳을 구성하려면 후보가 최소 5곳 필요합니다.",
    );
  }

  const savedCount = request.candidatePlaces.filter(
    (place) => (place.source ?? "external") === "saved",
  ).length;
  if (savedCount < 2) {
    throw new RecommendationAgentError(
      "insufficient-candidates",
      "저장한 장소 후보가 최소 2곳 필요합니다.",
    );
  }

  const candidateIds = new Set(request.candidatePlaces.map((place) => place.placeId));
  const missingPinned = (request.user.constraints.pinnedPlaceIds ?? []).filter(
    (placeId) => !candidateIds.has(placeId),
  );
  if (missingPinned.length > 0) {
    throw new RecommendationAgentError(
      "insufficient-candidates",
      "고정한 장소가 사전 필터링에서 제외됐습니다.",
      missingPinned.map((placeId) => ({
        code: "missing-pinned-candidate",
        message: "고정 장소가 사용 가능한 후보군에 없습니다.",
        placeId,
      })),
    );
  }
}

export async function generateDateCourse(
  rawRequest: CourseRequest,
  options: RecommendationAgentOptions = {},
): Promise<RecommendationResult> {
  const profile = options.profile ?? loadCourseProfile();
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("maxAttempts는 1~3 사이의 정수여야 합니다.");
  }

  const ranked = withRankedCandidates(rawRequest, {
    profile,
    limit: 30,
    requireTasteEvidence: true,
  });
  preflight(ranked.request);

  const prompt = buildDateCoursePrompt({ request: ranked.request, profile });
  const bedrock = options.callModel ? options.bedrock : options.bedrock ?? bedrockConfigFromEnv();
  const callModel: CourseModelCaller =
    options.callModel ??
    ((input) => callBedrockCourseDraft({ ...input, config: bedrock }));
  const modelId = options.modelId ?? bedrock?.modelId ?? "injected-model";

  let userMessage = prompt.user;
  let previousDraft: unknown = null;
  let lastViolations: RecommendationViolation[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let draft: CourseDraft;
    const raw = await callModel({ system: prompt.system, user: userMessage });
    try {
      previousDraft = parseJson(raw);
      draft = parseCourseDraft(previousDraft);
    } catch (error) {
      lastViolations =
        error instanceof ZodError
          ? zodViolations(error)
          : [{ code: "invalid-json", message: "모델 응답을 JSON으로 해석할 수 없습니다." }];

      if (attempt < maxAttempts) {
        userMessage = repairPayload({
          request: ranked.request,
          previousDraft,
          violations: lastViolations,
          attempt: attempt + 1,
        });
        continue;
      }
      throw new RecommendationAgentError(
        "invalid-model-response",
        "Bedrock 응답이 코스 초안 스키마를 충족하지 못했습니다.",
        lastViolations,
      );
    }

    const draftViolations = validateCourseDraft(draft, ranked.request, { profile });
    if (draftViolations.length === 0) {
      const course = await planCourse(draft, ranked.request, { profile });
      const finalValidation = validateCourseResponse(course, ranked.request, { profile });
      const finalViolations = finalValidation.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => ({
          code: issue.code,
          message: issue.message,
          placeId: issue.placeId,
        }));

      lastViolations = finalViolations;
      if (lastViolations.length === 0) {
        return {
          status: "validated",
          course,
          violations: [],
          diagnostics: {
            attempts: attempt,
            excludedCandidates: ranked.rank.excluded,
            modelId,
          },
        };
      }
    } else {
      lastViolations = draftViolations;
    }

    previousDraft = draft;
    if (attempt < maxAttempts) {
      userMessage = repairPayload({
        request: ranked.request,
        previousDraft,
        violations: lastViolations,
        attempt: attempt + 1,
      });
    }
  }

  throw new RecommendationAgentError(
    "constraints-unsatisfied",
    "세 번의 생성·수정 후에도 모든 코스 제약을 만족하지 못했습니다.",
    lastViolations,
  );
}
