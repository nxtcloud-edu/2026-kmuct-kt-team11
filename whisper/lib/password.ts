import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * scrypt from Node's own crypto rather than bcrypt or argon2: both of those are
 * native addons, which means a build step in every deploy target, and this
 * project has five runtime dependencies on purpose. scrypt is memory-hard,
 * which is the property that matters against GPU cracking, and it is already
 * here.
 *
 * Parameters are stored inside the hash string, so raising them later does not
 * strand existing rows — `verifyPassword` reads whatever each row was written
 * with, and `needsRehash` says when one is behind. The password route calls it
 * on a successful sign-in and rewrites the row there, which is the only moment
 * the plaintext and the stale hash are both in hand.
 */

// 128 * N * r = 16 MiB per hash. Enough to be expensive in bulk, low enough
// that a burst of concurrent sign-ins does not exhaust a small server.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

/**
 * Eight characters, and nothing else.
 *
 * No forced symbol or case classes: they mostly produce `Password1!`, and NIST
 * has advised against composition rules since SP 800-63B. Length is the control
 * that actually costs an attacker something.
 */
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Always compares in constant time, and always does the work.
 *
 * A null `stored` — an account that has only ever used magic links — still runs
 * a full hash against a dummy value before returning false. Returning early
 * would make "this address has no password" measurably faster than "wrong
 * password", which is the same account-enumeration leak the flat 202 on
 * `POST /auth/magic-link` exists to prevent.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const target = stored ?? (await DUMMY_HASH);
  const parts = target.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });

  // Lengths are equal by construction above, but timingSafeEqual throws rather
  // than returning false when they are not, so the guard stays.
  if (actual.length !== expected.length) return false;
  const ok = timingSafeEqual(actual, expected);
  return stored === null ? false : ok;
}

/** True when a row was written with weaker parameters than the current ones. */
export function needsRehash(stored: string): boolean {
  const [scheme, n, r, p] = stored.split('$');
  return scheme !== 'scrypt' || Number(n) < N || Number(r) < R || Number(p) < P;
}

/**
 * The stand-in hash a passwordless account is compared against. Not a secret —
 * the point is to spend the same time, not to hide anything.
 *
 * Started at import rather than on first use. Generating it lazily made the
 * first request that ever hit a passwordless address pay two scrypts instead of
 * one: 135ms against the usual 45-55ms, which is a loud answer to "does this
 * address have a password?" and undoes everything the unconditional hash above
 * is for. On serverless there is no such thing as one cold request either —
 * every new isolate gets its own first one. Starting it here means no request
 * ever generates it; the first one may still wait on it, but waiting costs the
 * same whether or not the address exists, because `verifyPassword` reaches this
 * promise only when `stored` is null and the wait is shared by everyone.
 */
const DUMMY_HASH: Promise<string> = hashPassword(
  'gaja-dummy-password-for-constant-time-compare',
);

// A promise that rejects with nothing listening takes the process down in Node,
// and nothing listens until the first passwordless sign-in. This handler exists
// only to be present; the `await` above still sees the rejection.
DUMMY_HASH.catch(() => {});
