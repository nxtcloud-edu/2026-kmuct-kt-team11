import { readSystemPromptText } from './assets';
import {
  collectAvoidSignals,
  collectPreferredSignals,
  collectStructureRules,
  collectToneRules,
  getTypeProfile,
  loadCourseProfile,
  resolveAxes,
  resolveWeights,
  type ResolvedAxis,
} from './profile';
import type { BlendingWeights, CourseProfile, CourseRequest, Mbti } from './types';

export const LAYER_IDS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export type PromptTemplate = Record<LayerId, string>;

const WRAP_WIDTH = 96;

/**
 * date-course-system.md에서 각 레이어의 첫 번째 ```text 블록을 뽑는다.
 * 마크다운 문서를 사람이 읽는 원본이자 유일한 출처로 유지하기 위한 방식이며,
 * L2의 두 번째 블록(렌더링 예시)은 의도적으로 무시한다.
 */
export function extractLayers(markdown: string): PromptTemplate {
  const sections = markdown.split(/^## (L\d)\./m);
  const layers = {} as PromptTemplate;

  for (let i = 1; i < sections.length; i += 2) {
    const id = sections[i] as LayerId;
    const body = sections[i + 1] ?? "";
    const blockBody = body.match(/```text\r?\n([\s\S]*?)\r?\n```/)?.[1];
    if (blockBody !== undefined) layers[id] = blockBody.trim();
  }

  const missing = LAYER_IDS.filter((id) => !layers[id]);
  if (missing.length > 0) {
    throw new Error(
      `date-course-system.md에서 ${missing.join(", ")} 레이어의 text 블록을 찾지 못했습니다.`,
    );
  }

  return layers;
}

export function loadPromptTemplate(): PromptTemplate {
  return extractLayers(readSystemPromptText());
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

/** 신호 목록이 한 줄로 너무 길어지지 않게 감싼다. */
function wrapJoin(items: string[], width = WRAP_WIDTH): string {
  const lines: string[] = [];
  let current = "";

  for (const item of items) {
    const next = current.length === 0 ? item : `${current}, ${item}`;
    if (next.length > width && current.length > 0) {
      lines.push(`${current},`);
      current = item;
    } else {
      current = next;
    }
  }
  if (current.length > 0) lines.push(current);

  return lines.join("\n");
}

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function renderAxisLines(axes: ResolvedAxis[]): string {
  return axes
    .map((axis) => `- ${axis.label}: ${signed(axis.value)} (${axis.definition.description})`)
    .join("\n");
}

function renderPreferredSignals(axes: ResolvedAxis[]): string {
  const { signals, categories, audiences, occasions } = collectPreferredSignals(axes);
  const parts: string[] = [];

  if (signals.length > 0) parts.push(wrapJoin(signals));
  if (categories.length > 0) parts.push(`(카테고리 가산: ${categories.join(", ")})`);
  if (audiences.length > 0) parts.push(`(추천 대상 가산: ${audiences.join(", ")})`);
  if (occasions.length > 0) parts.push(`(상황 가산: ${occasions.join(", ")})`);

  return parts.length > 0 ? parts.join("\n") : "없음";
}

function renderAvoidSignals(axes: ResolvedAxis[]): string {
  const { signals, audiences } = collectAvoidSignals(axes);
  const parts: string[] = [];

  if (signals.length > 0) parts.push(wrapJoin(signals));
  if (audiences.length > 0) parts.push(`(추천 대상 감산: ${audiences.join(", ")})`);

  return parts.length > 0 ? parts.join("\n") : "없음";
}

function renderOverrides(overrides: string[]): string {
  if (overrides.length === 0) return "";
  return `### 이 유형의 추가 규칙\n${bulletList(overrides)}`;
}

function renderLowConfidenceNote(
  profile: CourseProfile,
  lowConfidence: boolean,
): string {
  if (!lowConfidence) return "";
  return [
    "### 취향 데이터가 부족한 사용자입니다",
    `- ${profile.blending.lowConfidenceFallback.extraRule}`,
    "- 근거가 약한 만큼 단정적인 표현을 피하고, 선택 이유를 더 조심스럽게 서술한다.",
  ].join("\n");
}

function fillPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+(?:\.[A-Za-z]+)?)\}\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`프롬프트 템플릿의 자리표시자 ${match}에 대응하는 값이 없습니다.`);
    }
    return value;
  });
}

export interface RenderedProfileBlock {
  text: string;
  weights: BlendingWeights;
  lowConfidence: boolean;
}

/** L2 블록만 렌더링한다. 프롬프트 디버깅과 스냅샷 테스트에 쓴다. */
export function renderProfileBlock(options: {
  mbti: Mbti;
  request?: Pick<CourseRequest, "user">;
  profile?: CourseProfile;
  template?: PromptTemplate;
}): RenderedProfileBlock {
  const profile = options.profile ?? loadCourseProfile();
  const template = options.template ?? loadPromptTemplate();
  const type = getTypeProfile(profile, options.mbti);
  const axes = resolveAxes(profile, options.mbti);

  const { weights, lowConfidence } = resolveWeights(profile, {
    tasteVectorConfidence: options.request?.user.tasteVectorConfidence,
    savedVideoCount: options.request?.user.savedVideoCount,
  });

  const filled = fillPlaceholders(template.L2, {
    MBTI: options.mbti,
    CHARACTER_NAME: type.characterName,
    ONE_LINE_CONCEPT: type.oneLineConcept,
    AXIS_LINES: renderAxisLines(axes),
    PREFERRED_SIGNALS: renderPreferredSignals(axes),
    AVOID_SIGNALS: renderAvoidSignals(axes),
    STRUCTURE_RULES: bulletList(collectStructureRules(axes)),
    TONE_RULES: bulletList(collectToneRules(axes)),
    TYPE_OVERRIDES: renderOverrides(type.overrides),
    LOW_CONFIDENCE_NOTE: renderLowConfidenceNote(profile, lowConfidence),
    "WEIGHTS.userTasteVector": String(weights.userTasteVector),
    "WEIGHTS.similarUserSignal": String(weights.similarUserSignal),
    "WEIGHTS.mbtiAxes": String(weights.mbtiAxes),
  });

  // 비어 있는 자리표시자가 남긴 연속 빈 줄을 정리한다.
  const text = filled.replace(/\n{3,}/g, "\n\n").trim();

  return { text, weights, lowConfidence };
}

export interface BuiltPrompt {
  system: string;
  user: string;
  weights: BlendingWeights;
  lowConfidence: boolean;
  profileBlock: string;
}

/**
 * L0~L5를 합쳐 최종 시스템 프롬프트를 만든다.
 * L2만 유형별로 바뀌고 나머지 레이어는 모든 요청에서 동일하다.
 */
export function buildDateCoursePrompt(options: {
  request: CourseRequest;
  profile?: CourseProfile;
  template?: PromptTemplate;
}): BuiltPrompt {
  const profile = options.profile ?? loadCourseProfile();
  const template = options.template ?? loadPromptTemplate();
  const mbti = options.request.user.mbti;

  const block = renderProfileBlock({
    mbti,
    request: options.request,
    profile,
    template,
  });

  const system = [
    template.L0,
    template.L1,
    block.text,
    template.L3,
    template.L4,
    template.L5,
  ].join("\n\n---\n\n");

  return {
    system,
    user: JSON.stringify(options.request, null, 2),
    weights: block.weights,
    lowConfidence: block.lowConfidence,
    profileBlock: block.text,
  };
}
