import { ProblemError } from './problem';

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

/** Over the cap is clamped, not rejected — api-contract.md §5. */
export function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ProblemError('validation-error', {
      errors: [{ field: 'limit', message: 'Must be a positive integer.' }],
    });
  }
  return Math.min(n, MAX_LIMIT);
}

export type Cursor = { saved_at: string; id: string };

/**
 * Keyset on (saved_at desc, id desc). Base64url-encoded so it is opaque:
 * the contract says clients must not parse it, and an obviously-structured
 * cursor is an invitation to try.
 */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (typeof parsed?.saved_at === 'string' && typeof parsed?.id === 'string') return parsed;
  } catch {
    /* fall through */
  }
  throw new ProblemError('validation-error', {
    errors: [{ field: 'cursor', message: 'Not a valid cursor. Omit it to start from the beginning.' }],
  });
}

/** Fetch limit+1 to learn has_more without a second count query. */
export function page<T extends { id: string; saved_at: Date }>(rows: T[], limit: number) {
  const has_more = rows.length > limit;
  const data = has_more ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    has_more,
    next_cursor: has_more && last ? encodeCursor({ saved_at: last.saved_at.toISOString(), id: last.id }) : null,
  };
}
