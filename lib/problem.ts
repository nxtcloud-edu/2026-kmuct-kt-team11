import { NextResponse } from 'next/server';

/**
 * RFC 9457 problem details. Obsoletes RFC 7807.
 * `type` URIs are part of the contract — clients branch on them, never on `detail`.
 * See docs/gaja/api-contract.md §3 for the full catalogue.
 */
const BASE = 'https://gaja.app/errors/';

export type ProblemCode =
  | 'validation-error'
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'magic-link-invalid'
  | 'magic-link-rate-limited'
  | 'recovery-channel-required'
  | 'email-already-linked'
  | 'instagram-handle-taken'
  | 'idempotency-key-reuse'
  | 'invite-invalid'
  | 'invite-expired'
  | 'invite-revoked'
  | 'invite-already-member'
  | 'not-group-member'
  | 'last-owner'
  | 'duplicate-saved-place'
  | 'invalid-credentials'
  | 'login-rate-limited'
  | 'oauth-failed'
  | 'oauth-email-required'
  | 'ingest-breaker-tripped'
  | 'internal-error';

const CATALOGUE: Record<ProblemCode, { status: number; title: string; detail: string }> = {
  'validation-error':         { status: 422, title: 'Validation Error',            detail: 'One or more fields are invalid.' },
  'unauthenticated':          { status: 401, title: 'Unauthenticated',             detail: 'Sign in to continue.' },
  'forbidden':                { status: 403, title: 'Forbidden',                   detail: 'You do not have permission to change this.' },
  'not-found':                { status: 404, title: 'Not Found',                   detail: 'No such record.' },
  'magic-link-invalid':       { status: 400, title: 'Link no longer valid',        detail: 'This link has expired or was already used. Request a new one.' },
  'magic-link-rate-limited':  { status: 429, title: 'Too many requests',           detail: 'Too many link requests. Try again in a few minutes.' },
  'recovery-channel-required':{ status: 409, title: 'Recovery channel required',   detail: 'Removing this email would leave the account with no way to sign back in. Link Instagram first, or set a different email.' },
  'email-already-linked':     { status: 409, title: 'Email already linked',        detail: 'That address is already linked to another Gaja account.' },
  // A typed handle is only a hint, so losing the race costs the second claimant
  // nothing that was theirs — say so plainly rather than implying an accusation.
  'instagram-handle-taken':   { status: 409, title: 'Instagram handle already claimed', detail: '다른 계정에서 이미 연결해 둔 인스타그램 아이디예요. 오타가 없는지 확인해 주시고, 본인 아이디가 맞다면 비워둔 채로 넘어가셔도 괜찮아요.' },
  'idempotency-key-reuse':    { status: 409, title: 'Idempotency key reused',      detail: 'This Idempotency-Key was already used with a different request body. Generate a new key.' },
  // Three codes, because the three causes have three different remedies and one
  // of them is not "ask for a new link". `invite-invalid` now means only what it
  // says: this token matches nothing we ever issued — a typo, a truncated paste,
  // or a guess. Since 20260920000010 an invite is reusable, so "already used" is
  // no longer one of the reasons a link fails.
  'invite-invalid':           { status: 400, title: 'Invite link not recognised',  detail: '이 초대 링크를 찾을 수 없어요. 주소가 잘린 건 아닌지 확인하고, 초대해 준 사람에게 다시 받아 주세요.' },
  'invite-expired':           { status: 400, title: 'Invite link expired',         detail: '초대 링크가 만료됐어요. 초대해 준 사람에게 새 링크를 받아 주세요.' },
  'invite-revoked':           { status: 400, title: 'Invite link turned off',      detail: '이 초대 링크는 더 이상 쓸 수 없어요. 그룹 멤버에게 새 링크를 요청해 주세요.' },
  'invite-already-member':    { status: 409, title: 'Already a member',            detail: 'You are already in this group.' },
  'not-group-member':         { status: 403, title: 'Not a group member',          detail: 'You are not a member of this group.' },
  'last-owner':               { status: 409, title: 'Group would have no owner',   detail: 'Make someone else an owner before leaving.' },
  'duplicate-saved-place':    { status: 409, title: 'Already saved',               detail: 'You already saved this place here.' },
  'invalid-credentials':      { status: 401, title: 'Sign-in failed',             detail: '이메일 또는 비밀번호가 맞지 않아요.' },
  'login-rate-limited':       { status: 429, title: 'Too many attempts',          detail: '로그인 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.' },
  'oauth-failed':             { status: 400, title: 'Sign-in did not complete',   detail: 'That sign-in did not complete. Try again.' },
  'oauth-email-required':     { status: 409, title: 'Email permission required',  detail: 'Gaja needs your email address so you can always get back in. Allow email access and try again.' },
  // Not a transient 503: nothing retries out of this state. The Instagram
  // poller stopped because Instagram challenged it, and it stays stopped until a
  // person clears the challenge and resets ingest_state by hand. Retry-After
  // would be a lie, so the route does not send one.
  'ingest-breaker-tripped':   { status: 503, title: 'Ingestion halted',            detail: 'Reel ingestion has stopped and will not resume until it is reset by hand.' },
  'internal-error':           { status: 500, title: 'Something went wrong',        detail: 'Something went wrong on our end. Try again.' },
};

export type FieldError = { field: string; message: string };

export function problem(
  code: ProblemCode,
  opts: { detail?: string; instance?: string; errors?: FieldError[]; headers?: HeadersInit } = {},
) {
  const spec = CATALOGUE[code];
  const body: Record<string, unknown> = {
    type: BASE + code,
    title: spec.title,
    status: spec.status,
    // A caller-supplied detail may override the default, but never leaks internals:
    // stack traces, SQL and hostnames are correlated via request_id instead.
    detail: opts.detail ?? spec.detail,
    request_id: crypto.randomUUID(),
  };
  if (opts.instance) body.instance = opts.instance;
  if (opts.errors?.length) body.errors = opts.errors;

  return NextResponse.json(body, {
    status: spec.status,
    headers: { 'content-type': 'application/problem+json', ...(opts.headers ?? {}) },
  });
}

/** Thrown inside handlers; converted by withRoute(). */
export class ProblemError extends Error {
  constructor(
    readonly code: ProblemCode,
    readonly opts: { detail?: string; errors?: FieldError[]; headers?: HeadersInit } = {},
  ) {
    super(code);
  }
}
