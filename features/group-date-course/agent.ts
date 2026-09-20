import { generateDateCourse, type CourseRequest } from '@/packages/shared/src';
import { aggregateMemberPreferences } from './aggregate-preferences';
import { evaluateGroupFairness, repairPinsForUncoveredMembers } from './fairness';
import { rankCandidatesForGroup } from './rank-for-group';
import type {
  GroupAgentPreparedInput,
  GroupContext,
  GroupCourseInput,
  GroupCourseResult,
} from './types';

export function prepareGroupCourseRequest(
  context: GroupContext,
  input: GroupCourseInput,
): GroupAgentPreparedInput {
  const aggregate = aggregateMemberPreferences(context.members, context.requesterMbti);
  const rankedCandidates = rankCandidatesForGroup(context.candidates, context.members).slice(0, 30);
  const request: CourseRequest = {
    user: {
      mbti: aggregate.representativeMbti,
      tasteVectorConfidence: aggregate.confidence,
      savedVideoCount: aggregate.savedPlaceCount,
      tasteVector: aggregate.tasteVector,
      constraints: {
        region: input.region,
        startStation: input.startStation,
        date: input.date,
        timeRange: input.timeRange,
        participantCount: context.members.length,
        budgetPerPerson: input.budgetPerPerson,
        budgetToleranceRate: 0.1,
        maxDurationMin: 300,
        maxLegMinutes: 25,
        maxWalkMinutes: 20,
        pinnedPlaceIds: input.pinnedPlaceIds ?? [],
        forbiddenPlaceIds: input.forbiddenPlaceIds ?? [],
        hard: input.hardConstraints,
      },
    },
    similarUsers: {
      cohortSize: context.members.length,
      similarity: 1,
    },
    candidatePlaces: rankedCandidates.map((item) => item.candidate),
  };

  return { request, rankedCandidates, aggregate };
}
export async function generateGroupDateCourse(
  context: GroupContext,
  input: GroupCourseInput,
): Promise<GroupCourseResult> {
  const prepared = prepareGroupCourseRequest(context, input);
  let request = prepared.request;
  let lastResult: Awaited<ReturnType<typeof generateDateCourse>> | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const recommendation = await generateDateCourse(request, { maxAttempts: 2 });
    lastResult = recommendation;
    const groupMatch = evaluateGroupFairness(
      recommendation.course,
      prepared.rankedCandidates,
      context.members,
    );
    const uncovered = groupMatch.memberCoverage.some((member) => !member.covered);
    if (!uncovered || attempt === 2) {
      return {
        recommendation,
        groupMatch,
        representativeMbti: prepared.aggregate.representativeMbti,
        attempts: attempt,
      };
    }

    const currentPins = request.user.constraints.pinnedPlaceIds ?? [];
    const repairedPins = repairPinsForUncoveredMembers(
      currentPins,
      recommendation.course,
      groupMatch,
      prepared.rankedCandidates,
    );
    if (repairedPins.length === currentPins.length) {
      return {
        recommendation,
        groupMatch,
        representativeMbti: prepared.aggregate.representativeMbti,
        attempts: attempt,
      };
    }
    request = {
      ...request,
      user: {
        ...request.user,
        constraints: { ...request.user.constraints, pinnedPlaceIds: repairedPins },
      },
    };
  }

  throw new Error(`그룹 추천 결과를 만들지 못했습니다: ${lastResult ? '공정성 검증 실패' : '생성 실패'}`);
}
