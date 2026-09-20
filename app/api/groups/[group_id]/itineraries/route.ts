import { withIdempotency } from '@/lib/idempotency';
import { ProblemError } from '@/lib/problem';
import { json, withRoute } from '@/lib/route';
import { requireUser } from '@/lib/session';
import { assertGroupMember } from '@/lib/saved-places';
import {
  BedrockConfigurationError,
  BedrockInvocationError,
  RecommendationAgentError,
} from '@/packages/shared/src';
import { generateGroupDateCourse } from '@/features/group-date-course/agent';
import { loadGroupContext } from '@/features/group-date-course/load-group-context';
import {
  listGroupCourseRuns,
  saveGroupCourseRun,
} from '@/features/group-date-course/repository';
import { parseGroupCourseInput } from '@/features/group-date-course/schema';

export const runtime = 'nodejs';
type Ctx = { params: Promise<{ group_id: string }> };

export const GET = withRoute(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { group_id } = await ctx.params;
  await assertGroupMember(group_id, user.id);
  return json({ data: await listGroupCourseRuns(group_id), next_cursor: null, has_more: false });
});
export const POST = withRoute(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { group_id } = await ctx.params;
  const raw = await req.json();
  const input = parseGroupCourseInput(raw);

  return withIdempotency(req.headers.get('Idempotency-Key'), user.id, raw, async () => {
    try {
      const context = await loadGroupContext({ groupId: group_id, requesterId: user.id, input });
      const result = await generateGroupDateCourse(context, input);
      const stored = await saveGroupCourseRun({ context, input, result });
      return { status: 201, body: stored };
    } catch (error) {
      if (error instanceof RecommendationAgentError) {
        throw new ProblemError('recommendation-failed', {
          detail: error.message,
          errors: error.violations.map((violation) => ({
            field: violation.placeId ? `candidate_places.${violation.placeId}` : 'course',
            message: `[${violation.code}] ${violation.message}`,
          })),
        });
      }
      if (error instanceof BedrockConfigurationError) {
        throw new ProblemError('recommendation-unavailable', {
          detail: 'Bedrock 연결 환경변수가 설정되지 않았습니다.',
        });
      }
      if (error instanceof BedrockInvocationError) {
        throw new ProblemError('recommendation-unavailable');
      }
      throw error;
    }
  });
});
