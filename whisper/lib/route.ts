import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { problem, ProblemError } from './problem';

/**
 * Wraps a route handler so every failure leaves as an RFC 9457 problem document
 * rather than Next's default HTML error page. An undocumented error is an outage
 * from the consumer's point of view.
 */
export function withRoute<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
) {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e instanceof ProblemError) return problem(e.code, e.opts);

      if (e instanceof ZodError) {
        return problem('validation-error', {
          errors: e.issues.map((i) => ({
            field: i.path.join('.') || '(body)',
            message: i.message,
          })),
        });
      }

      // Postgres constraint violations mapped to their documented contract errors,
      // so a race that beats the application check still produces the right shape.
      const pg = e as { code?: string; constraint?: string };
      if (pg?.code === '23505') {
        if (pg.constraint === 'saved_places_no_duplicate_idx') return problem('duplicate-saved-place');
        if (pg.constraint === 'users_email_key') return problem('email-already-linked');
        // A duplicate Instagram handle is a refused claim, not a failure: the index
        // exists so two accounts can never both be candidates for one sender.
        if (pg.constraint === 'users_instagram_handle_lower_idx')
          return problem('instagram-handle-taken');
        if (pg.constraint === 'group_members_one_owner_idx') return problem('last-owner');
      }
      if (pg?.code === '23514' && pg.constraint === 'users_recovery_channel_required') {
        return problem('recovery-channel-required');
      }

      console.error('[route] unhandled', e);
      return problem('internal-error');
    }
  };
}

export function json(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, init);
}
