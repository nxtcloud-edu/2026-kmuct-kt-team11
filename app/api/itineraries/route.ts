import { withIdempotency } from '@/lib/idempotency';
import { ProblemError } from '@/lib/problem';
import { withRoute } from '@/lib/route';
import { requireUser } from '@/lib/session';
import {
  BedrockConfigurationError,
  BedrockInvocationError,
  RecommendationAgentError,
  generateDateCourse,
  parseCourseRequest,
} from '@/packages/shared/src';

export const runtime = 'nodejs';

export const POST = withRoute(async (req: Request) => {
  const user = await requireUser();
  const raw = await req.json();
  const request = parseCourseRequest(raw);

  return withIdempotency(req.headers.get('Idempotency-Key'), user.id, raw, async () => {
    try {
      const result = await generateDateCourse(request);
      return { status: 201, body: result };
    } catch (error) {
      if (error instanceof RecommendationAgentError) {
        throw new ProblemError('recommendation-failed', {
          detail: error.message,
          errors: error.violations.map((violation) => ({
            field: violation.placeId ? `candidatePlaces.${violation.placeId}` : 'course',
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
