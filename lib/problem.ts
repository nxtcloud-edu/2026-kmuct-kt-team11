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
  | 'recommendation-failed'
  | 'recommendation-unavailable'
  | 'ingest-breaker-tripped'
  | 'ingest-not-configured'
  | 'ingest-session-expired'
  | 'reel-url-invalid'
  | 'reel-not-a-reel'
  | 'reel-unavailable'
  | 'nearby-not-configured'
  | 'event-not-located'
  | 'tts-unavailable'
  | 'tts-failed'
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
  'recommendation-failed':    { status: 422, title: 'No valid course found',       detail: 'The recommendation could not satisfy every required constraint.' },
  'recommendation-unavailable': { status: 503, title: 'Recommendation unavailable', detail: 'The recommendation service is temporarily unavailable.' },
  // Not a transient 503: nothing retries out of this state. The Instagram
  // poller stopped because Instagram challenged it, and it stays stopped until a
  // person clears the challenge and resets ingest_state by hand. Retry-After
  // would be a lie, so the route does not send one.
  'ingest-breaker-tripped':   { status: 503, title: 'Ingestion halted',            detail: '릴스 수집이 멈췄어요. 손으로 다시 켜기 전까지는 재개되지 않아요.' },
  // Also not transient, and not a bug either: an environment variable is missing,
  // so nothing was attempted. 503 rather than 500 because the service is
  // genuinely unavailable rather than broken, and the fix is a deployment, not a
  // retry. The detail names the VARIABLE and never its value — `IG_SESSION_ID`
  // is a bearer credential for an entire Instagram account.
  'ingest-not-configured':    { status: 503, title: 'Ingestion not configured',    detail: '릴스 수집에 필요한 환경 변수가 설정되지 않았어요.' },
  // THE COPY MAY NOT BLAME THE PERSON READING IT. The Instagram session Gaja
  // fetches reels with expires on its own schedule, and renewing it is an
  // operator's job that no user can do, reach or even see. A message like
  // "다시 로그인해 주세요" would send them to check their own Instagram account,
  // find nothing wrong with it, and conclude the app is broken in a way they
  // caused. So: say plainly that it is ours, and say what to do instead — the
  // paste field is the only path affected, and a saved link still works later.
  // Names no variable and no vendor: this one is shown to users, not to a cron.
  'ingest-session-expired':   { status: 503, title: 'Instagram connection expired', detail: '지금은 인스타그램에서 릴스를 가져올 수 없어요. 가자 쪽 연결이 만료돼서 저희가 다시 연결해야 해요. 링크는 그대로 두었다가 조금 뒤에 다시 붙여넣어 주세요.' },
  // 422 and not 404: nothing was looked up. The string does not name a post, so
  // no request to Instagram was made and none should be. The detail is the
  // backstop — the paste field validates the same shapes in the browser and
  // says this before the button is even enabled.
  'reel-url-invalid':         { status: 422, title: 'Not an Instagram reel link',  detail: '인스타그램 릴스 주소가 아니에요. 릴스에서 공유 › 링크 복사를 눌러 나온 주소를 붙여넣어 주세요.' },
  // The link was fine and the post behind it is a photo. Distinct from the
  // above because the remedy is different: they pasted a real Instagram post,
  // just not one with a reel in it.
  'reel-not-a-reel':          { status: 422, title: 'Not a reel',                  detail: '릴스가 아니라 사진 게시물이에요. 가자는 릴스만 읽을 수 있어요.' },
  // Deleted, private, or never existed — Instagram answers all three the same
  // way, so the copy does too. Saying "비공개" about a post that was actually
  // deleted would be a guess, and saying it about one that IS private would
  // confirm a private post exists to anyone holding its shortcode.
  'reel-unavailable':         { status: 404, title: 'Reel not available',          detail: '이 릴스를 열 수 없어요. 비공개 계정이거나 삭제된 게시물일 수 있어요. 공개된 릴스인지 확인해 주세요.' },
  // Same class as `ingest-not-configured` and deliberately its own code: this is
  // a DIFFERENT capability with a different variable behind it, and a user told
  // "릴스 수집이 설정되지 않았어요" while tapping 주변 장소 찾기 learns nothing. The
  // detail names neither variable nor value — `APIFY_TOKEN` and `GEMINI_API_KEY`
  // are billed credentials, and a problem response is a thing users can read.
  'nearby-not-configured':    { status: 503, title: 'Nearby search not configured', detail: '주변 장소를 찾는 기능이 이 환경에 설정되어 있지 않아요. 찾아보지 못했을 뿐, 근처에 아무것도 없다는 뜻은 아니에요.' },
  // NOT a 404, and the difference is the whole message: the event exists, the
  // user is looking at its card, and what is missing is a LOCATION. Most yanolja
  // listings publish a hall name (`NOL 유니플렉스 1관`) and no street address, so
  // there is nothing to geocode and nothing to pin on a map — and inventing
  // coordinates to make the save button work would put a wrong pin in somebody's
  // saved places forever. The screen disables the control and this is the
  // backstop for a request that arrives anyway.
  'event-not-located':        { status: 409, title: 'Event has no saveable location', detail: '이 행사는 정확한 위치를 확인하지 못해서 저장할 수 없어요. 예매 페이지에서 장소를 확인해 주세요.' },
  // The third member of the `*-not-configured` family, and the only one the
  // CLIENT is expected to RECOVER from rather than display. Every browser that
  // can run the assistant already has an on-device voice, so "the hosted voice
  // is not usable here" never means "you get no voice" — the sheet hears this
  // and re-speaks the same answer through `speechSynthesis`. See the fallback in
  // lib/speech/fallback-synthesizer.ts.
  //
  // It deliberately covers BOTH halves of unusable — no key configured at all,
  // and a key that authenticates but whose scopes or plan refuse synthesis (the
  // 401/402/403 mapped in app/api/tts/route.ts). The remedy is the same for both
  // (someone changes a dashboard setting) and neither is fixed by retrying, so
  // splitting them would buy the reader nothing. The detail names neither the
  // vendor nor the variable, for the reason `nearby-not-configured` gives.
  'tts-unavailable':          { status: 503, title: 'Voice not available',         detail: '이 환경에서는 준비된 목소리를 쓸 수 없어요. 기기에 있는 목소리로 읽어 드릴게요.' },
  // Unlike the above, this one IS worth retrying: the provider was configured,
  // reachable and willing, and the request still failed. 502 rather than 503
  // because the failure is upstream's, not a gap in this deployment.
  'tts-failed':               { status: 502, title: 'Voice synthesis failed',      detail: '음성으로 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.' },
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
