/**
 * Browser-side API client.
 *
 * Server Components do NOT use this. They read Postgres through `lib/db` and
 * `lib/session` directly — fetching our own route handler from the server would
 * add an HTTP hop and a second copy of the auth check for nothing. This module
 * is for Client Components, where `/api/*` is the only way in.
 *
 * Everything here funnels failures into one `ApiError` so that screens can
 * render the state matrix without each one re-parsing problem documents.
 */
import type { Problem } from './types';

const PROBLEM_BASE = 'https://gaja.app/errors/';

/** A request that reached the server and came back non-2xx. */
export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail);
    this.name = 'ApiError';
  }
  /** The stable half of the contract. `is('unauthenticated')`, never `detail === '…'`. */
  is(code: string): boolean {
    return this.problem.type === PROBLEM_BASE + code;
  }
  get status(): number {
    return this.problem.status;
  }
  get requestId(): string | null {
    return this.problem.request_id ?? null;
  }
}

/**
 * The request never reached the server, or the response was not a problem
 * document. Distinct from ApiError because the user-facing remedy differs:
 * "check your connection" rather than "here is what went wrong".
 */
export class NetworkError extends Error {
  constructor(message = '서버에 연결하지 못했어요.') {
    super(message);
    this.name = 'NetworkError';
  }
}

type Options = Omit<RequestInit, 'body'> & {
  body?: unknown;
  /** Set on unsafe methods so a retry cannot double-write. See api-contract.md §4. */
  idempotencyKey?: string;
};

export async function apiFetch<T>(path: string, opts: Options = {}): Promise<T> {
  const { body, idempotencyKey, headers, ...rest } = opts;

  const h = new Headers(headers);
  if (body !== undefined) h.set('content-type', 'application/json');
  if (idempotencyKey) h.set('Idempotency-Key', idempotencyKey);

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...rest,
      headers: h,
      // The session lives in a __Host- cookie; without this it is never sent.
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new NetworkError();
  }

  if (res.status === 204) return undefined as T;

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    // A non-JSON body from a route that promises JSON means something upstream
    // (proxy, gateway) answered instead of us. Not an ApiError — we have no
    // problem document to show.
    if (!res.ok) throw new NetworkError();
    throw new NetworkError('응답을 읽지 못했어요.');
  }

  if (!res.ok) throw new ApiError(parsed as Problem);
  return parsed as T;
}

/** Idempotency-Key for a create. One per user intent, not one per retry. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
