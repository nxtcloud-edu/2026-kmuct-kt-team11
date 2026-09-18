import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { queryOne } from './db';
import { ProblemError } from './problem';

const RETENTION_HOURS = 24; // api-contract.md §4

type Stored = { status_code: number; response: unknown; fingerprint: string };

/**
 * `Idempotency-Key` is an IETF draft, not a ratified RFC — a documented convention here.
 * Same key + same body replays the original response.
 * Same key + different body is 409 idempotency-key-reuse.
 *
 * Slice 2's planning key and slice 3's `mid` dedupe reuse this store rather than
 * inventing their own mechanism.
 */
export async function withIdempotency(
  key: string | null,
  userId: string | null,
  body: unknown,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<NextResponse> {
  if (!key) {
    const out = await run();
    return NextResponse.json(out.body, { status: out.status });
  }

  const fingerprint = createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');

  const existing = await queryOne<Stored>(
    `select status_code, response, fingerprint
       from idempotency_keys
      where key = $1 and user_id is not distinct from $2 and expires_at > now()`,
    [key, userId],
  );

  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new ProblemError('idempotency-key-reuse');
    return NextResponse.json(existing.response, {
      status: existing.status_code,
      headers: { 'Idempotency-Replayed': 'true' },
    });
  }

  const out = await run();

  // Only successful outcomes are recorded. Replaying a 4xx would pin a client to a
  // failure it has since fixed.
  if (out.status < 400) {
    await queryOne(
      `insert into idempotency_keys (key, user_id, fingerprint, status_code, response, expires_at)
       values ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval)
       on conflict (key, user_id) do nothing
       returning key`,
      [key, userId, fingerprint, out.status, JSON.stringify(out.body), String(RETENTION_HOURS)],
    );
  }

  return NextResponse.json(out.body, { status: out.status });
}
