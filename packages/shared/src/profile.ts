import { courseProfile } from './assets';
import {
  AXIS_ORDER,
  type Axis,
  type AxisName,
  type AxisPole,
  type BlendingWeights,
  type Confidence,
  type CourseProfile,
  type Mbti,
  type MbtiTypeProfile,
  type Pole,
} from './types';

export function loadCourseProfile(): CourseProfile {
  return courseProfile();
}

export function getTypeProfile(profile: CourseProfile, mbti: Mbti): MbtiTypeProfile {
  const type = profile.types[mbti];
  if (!type) throw new Error(`mbti-course-profile.json에 ${mbti} 정의가 없습니다.`);
  return type;
}

/** 축 값의 부호가 어느 극을 활성화하는지. 0은 양극으로 취급한다. */
export function activePole(axisValue: number): Pole {
  return axisValue < 0 ? "negative" : "positive";
}

export function getAxis(profile: CourseProfile, axis: AxisName): Axis {
  const found = profile.axes[axis];
  if (!found) throw new Error(`mbti-course-profile.json에 ${axis} 축 정의가 없습니다.`);
  return found;
}

export interface ResolvedAxis {
  name: AxisName;
  label: string;
  value: number;
  pole: Pole;
  poleLetter: string;
  rankingWeight: number;
  definition: AxisPole;
}

/** 특정 유형에 대해 4개 축의 활성 극과 규칙을 한 번에 해석한다. */
export function resolveAxes(profile: CourseProfile, mbti: Mbti): ResolvedAxis[] {
  const type = getTypeProfile(profile, mbti);

  return AXIS_ORDER.map((name) => {
    const axis = getAxis(profile, name);
    const value = type.axisValues[name] ?? 0;
    const pole = activePole(value);

    return {
      name,
      label: axis.label,
      value,
      pole,
      poleLetter: axis.poles[pole],
      rankingWeight: axis.rankingWeight,
      definition: axis[pole],
    };
  });
}

/**
 * 저신뢰 사용자인지 판정한다.
 * mbti-course-profile.json의 blending.lowConfidenceFallback.trigger를 코드로 옮긴 것이다.
 */
export function isLowConfidence(input: {
  tasteVectorConfidence?: Confidence;
  savedVideoCount?: number;
}): boolean {
  if (input.tasteVectorConfidence === "low") return true;
  return input.savedVideoCount !== undefined && input.savedVideoCount < 3;
}

export function resolveWeights(
  profile: CourseProfile,
  input: { tasteVectorConfidence?: Confidence; savedVideoCount?: number },
): { weights: BlendingWeights; lowConfidence: boolean } {
  const lowConfidence = isLowConfidence(input);
  return {
    weights: lowConfidence
      ? profile.blending.lowConfidenceFallback.weights
      : profile.blending.weights,
    lowConfidence,
  };
}

/** 활성 극들에서 가산 신호를 모은다. 축 순서를 유지하고 중복은 제거한다. */
export function collectPreferredSignals(axes: ResolvedAxis[]): {
  signals: string[];
  categories: string[];
  audiences: string[];
  occasions: string[];
} {
  const signals = new Set<string>();
  const categories = new Set<string>();
  const audiences = new Set<string>();
  const occasions = new Set<string>();

  for (const axis of axes) {
    axis.definition.preferredSignals?.forEach((s) => signals.add(s));
    axis.definition.preferredCategories?.forEach((c) => categories.add(c));
    axis.definition.preferredAudiences?.forEach((a) => audiences.add(a));
    axis.definition.preferredOccasions?.forEach((o) => occasions.add(o));
  }

  return {
    signals: [...signals],
    categories: [...categories],
    audiences: [...audiences],
    occasions: [...occasions],
  };
}

export function collectAvoidSignals(axes: ResolvedAxis[]): {
  signals: string[];
  audiences: string[];
} {
  const signals = new Set<string>();
  const audiences = new Set<string>();

  for (const axis of axes) {
    axis.definition.avoidSignals?.forEach((s) => signals.add(s));
    axis.definition.avoidAudiences?.forEach((a) => audiences.add(a));
  }

  return { signals: [...signals], audiences: [...audiences] };
}

export function collectStructureRules(axes: ResolvedAxis[]): string[] {
  const rules: string[] = [];
  for (const axis of axes) {
    for (const rule of axis.definition.structureRules ?? []) {
      if (!rules.includes(rule)) rules.push(rule);
    }
  }
  return rules;
}

export function collectToneRules(axes: ResolvedAxis[]): string[] {
  const rules: string[] = [];
  for (const axis of axes) {
    for (const rule of axis.definition.toneRules ?? []) {
      if (!rules.includes(rule)) rules.push(rule);
    }
  }
  return rules;
}
