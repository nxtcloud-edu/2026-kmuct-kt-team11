import { readFixtureText } from '../assets';
import { generateDateCourse } from '../agent';
import { loadCourseProfile } from '../profile';
import { withRankedCandidates, type RankResult } from '../rank';
import { validateCourseResponse, type ValidationResult } from '../validate';
import {
  ALL_MBTI,
  type CandidatePlace,
  type Confidence,
  type CourseRequest,
  type CourseResponse,
  type Mbti,
  type TasteVector,
  type UserConstraints,
} from '../types';
import {
  axisIsolation,
  describeCourse,
  typeDifferentiation,
  type CourseShape,
  type DifferentiationReport,
  type IsolationReport,
} from './metrics';

export const FIXTURE_FILES = [
  "taste-a-cafe-mood",
  "taste-b-foodie-value",
  "taste-c-activity",
  "taste-d-low-confidence",
] as const;

export type FixtureId = (typeof FIXTURE_FILES)[number];

export interface CourseFixture {
  fixtureId: string;
  description: string;
  user: {
    mbti: string;
    tasteVectorConfidence?: Confidence;
    savedVideoCount?: number;
    tasteVector: TasteVector;
    constraints: UserConstraints;
  };
  similarUsers?: { cohortSize: number; similarity: number };
  candidatePlaces: CandidatePlace[];
  expectations?: Record<string, unknown>;
}

export function loadFixture(id: FixtureId): CourseFixture {
  return JSON.parse(readFixtureText(id)) as CourseFixture;
}

export function buildRequestFromFixture(fixture: CourseFixture, mbti: Mbti): CourseRequest {
  return {
    user: { ...fixture.user, mbti },
    similarUsers: fixture.similarUsers,
    candidatePlaces: fixture.candidatePlaces.map((place) => ({
      ...place,
      source: place.source ?? 'saved',
    })),
  };
}

export type CallModel = (input: {
  system: string;
  user: string;
  mbti: Mbti;
  fixtureId: string;
}) => Promise<string>;

/** 모델이 코드 펜스로 감싸 반환하는 경우를 흡수한다. */
export function parseModelJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\n([\s\S]*?)\n```/);
  return JSON.parse((fenced?.[1] ?? raw).trim());
}

export interface TypeRun {
  mbti: Mbti;
  ok: boolean;
  raw: string;
  response?: CourseResponse;
  validation?: ValidationResult;
  error?: string;
  excludedByPreRank: string[];
}

export interface FixtureReport {
  fixtureId: string;
  runs: TypeRun[];
  differentiation: DifferentiationReport;
  isolation: IsolationReport[];
  evidenceCoverage: number;
  factualityErrors: number;
  schemaFailures: number;
}

export interface RunOptions {
  callModel: CallModel;
  fixtures?: FixtureId[];
  types?: Mbti[];
  /** 사전 랭커로 후보를 줄여서 보낼지. 기본값 true */
  preRank?: boolean;
  onProgress?: (fixtureId: string, mbti: Mbti, index: number, total: number) => void;
}

export async function runFixture(
  fixtureId: FixtureId,
  options: RunOptions,
): Promise<FixtureReport> {
  const profile = loadCourseProfile();
  const fixture = loadFixture(fixtureId);
  const types = options.types ?? ALL_MBTI;
  const preRank = options.preRank ?? true;

  const runs: TypeRun[] = [];

  for (const [index, mbti] of types.entries()) {
    options.onProgress?.(fixtureId, mbti, index + 1, types.length);

    const baseRequest = buildRequestFromFixture(fixture, mbti);
    const emptyRank: RankResult = { ranked: [], excluded: [] };
    const { request, rank } = preRank
      ? withRankedCandidates(baseRequest, { profile })
      : { request: baseRequest, rank: emptyRank };

    const excludedByPreRank = rank.excluded.map((entry) => entry.placeId);
    let raw = "";
    try {
      const result = await generateDateCourse(request, {
        profile,
        modelId: 'evaluation-caller',
        callModel: async ({ system, user }) => {
          raw = await options.callModel({ system, user, mbti, fixtureId });
          return raw;
        },
      });
      const validation = validateCourseResponse(result.course, request, { profile });

      runs.push({
        mbti,
        ok: validation.ok,
        raw,
        response: result.course,
        validation,
        excludedByPreRank,
      });
    } catch (error) {
      runs.push({
        mbti,
        ok: false,
        raw,
        error: error instanceof Error ? error.message : String(error),
        excludedByPreRank,
      });
    }
  }

  const shapes: CourseShape[] = [];
  const shapeByType = new Map<Mbti, CourseShape>();

  for (const run of runs) {
    if (!run.response) continue;
    const shape = describeCourse(run.response);
    shapes.push(shape);
    shapeByType.set(run.mbti, shape);
  }

  const validated = runs.filter((run) => run.validation);
  const evidenceCoverage =
    validated.length === 0
      ? 0
      : validated.reduce((sum, run) => sum + (run.validation?.metrics.evidenceCoverage ?? 0), 0) /
        validated.length;

  return {
    fixtureId,
    runs,
    differentiation: typeDifferentiation(shapes),
    isolation: axisIsolation(shapeByType),
    evidenceCoverage,
    factualityErrors: validated.reduce(
      (sum, run) => sum + (run.validation?.metrics.factualityErrors ?? 0),
      0,
    ),
    schemaFailures: runs.filter((run) => !run.response).length,
  };
}

export async function runEvaluation(options: RunOptions): Promise<FixtureReport[]> {
  const fixtures = options.fixtures ?? [...FIXTURE_FILES];
  const reports: FixtureReport[] = [];

  for (const fixtureId of fixtures) {
    reports.push(await runFixture(fixtureId, options));
  }

  return reports;
}

export function formatReport(reports: FixtureReport[]): string {
  const lines: string[] = [];

  for (const report of reports) {
    const { differentiation: diff } = report;
    lines.push(`## ${report.fixtureId}`);
    lines.push(`- 실행: ${report.runs.length}건, 파싱 실패: ${report.schemaFailures}건`);
    lines.push(
      `- 7.1 유형 간 차별성: 평균 ${diff.mean.toFixed(3)} (목표 0.35~0.60) -> ${diff.verdict}`,
    );
    if (diff.mostSimilarPair) {
      lines.push(
        `  - 가장 비슷한 쌍: ${diff.mostSimilarPair.join(" / ")} (${diff.max.toFixed(2)})`,
      );
    }
    lines.push(`- 7.3 사실성 오류: ${report.factualityErrors}건 (목표 0)`);
    lines.push(
      `- 7.4 근거 커버리지: ${(report.evidenceCoverage * 100).toFixed(1)}% (목표 100%)`,
    );

    lines.push("- 7.2 단일 축 분리:");
    for (const isolation of report.isolation) {
      const mark = isolation.passed ? "통과" : "실패";
      lines.push(
        `  - ${isolation.pair.join(" / ")} (${isolation.axis}): ${mark}, 장소 겹침 ${isolation.placeOverlap.toFixed(2)}`,
      );
      for (const note of isolation.notes) lines.push(`    - ${note}`);
    }

    const failures = report.runs.filter((run) => !run.ok);
    if (failures.length > 0) {
      lines.push(`- 실패한 유형 ${failures.length}개:`);
      for (const run of failures) {
        const reason =
          run.error ??
          run.validation?.issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => `${issue.code}${issue.placeId ? `(${issue.placeId})` : ""}`)
            .join(", ");
        lines.push(`  - ${run.mbti}: ${reason || "알 수 없음"}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}
