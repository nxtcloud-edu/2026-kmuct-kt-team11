import { z } from 'zod';
import { query, tx } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { issueSession, toMe, type SessionUser } from '@/lib/session';
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '@/lib/password';

const Body = z.object({
  email: z.string().email('Must be a valid email address.'),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 해요.`)
    .max(200, '비밀번호가 너무 길어요.'),
  intent: z.enum(['sign_up', 'sign_in']),
});

const USER_COLUMNS = `id, display_name, avatar_url, email, email_verified_at, igsid,
                      instagram_handle, locale,
                      home_area, profile_visible_in_groups, plan,
                      gender, age_band, mbti, onboarded_at`;

/** Failures allowed per address before the door shuts, and for how long. */
const MAX_FAILURES = 8;
const WINDOW_MINUTES = 15;

/**
 * Password sign-up and sign-in.
 *
 * One route with an `intent`, mirroring `POST /auth/magic-link` rather than
 * inventing a second convention for the same job. Both outcomes end in
 * `issueSession()`, so the __Host- cookie, `requireSession()` and every existing
 * guard are untouched — this adds a way to prove who you are, not a second
 * notion of what a session is.
 *
 * Passwords are additive. An account can have a password, a magic link, an
 * Instagram id, or several; `users_recovery_channel_required` still only asks
 * for one way back in, and a password is deliberately NOT one of them — losing
 * a password is exactly the case the magic link recovers from.
 */
export const POST = withRoute(async (req: Request) => {
  const body = Body.parse(await req.json());
  const email = body.email.toLowerCase().trim();

  // Before the intent is dispatched, not inside one branch of it. Sign-up
  // answers 409 for an address we know and 201 for one we do not, which is an
  // enumeration oracle every bit as good as sign-in's — and for a while it was a
  // free one, because the throttle lived inside signIn(). Both intents now spend
  // from the same per-address budget, so probing costs exactly what guessing
  // costs.
  await recordAttempt(email);

  if (body.intent === 'sign_up') return signUp(email, body.password);
  return signIn(email, body.password);
});

/**
 * Writes this attempt down as a failure, and only then decides whether it may run.
 *
 * The order is the whole point, and it is the opposite of the obvious one.
 * Counting first and inserting after verification leaves the 50-100ms of scrypt
 * in between, during which the attempt is happening but is not on record: a
 * burst that arrives together all reads the same count, all passes, and the
 * limit degrades into a suggestion. Recording first means the budget is spent
 * the moment a request is admitted, whatever happens to it afterwards. Nobody
 * should ever move this insert back down to the end of the handler.
 *
 * A rejected attempt rolls its own row back. Leaving it would let anyone hold
 * the window open indefinitely by hammering an address they cannot sign in to,
 * which turns the throttle into a tool for keeping the owner out rather than one
 * for keeping a guesser slow.
 *
 * What this still does not buy: transactions that overlap completely cannot see
 * each other's uncommitted rows, so a batch fired in the same millisecond is
 * counted only once they commit. The floor is now the length of an insert rather
 * than the length of a hash, which is the difference between a limit a botnet
 * walks through and one it has to queue behind. Making it exact would mean
 * serialising every attempt on the address, and that cost lands on the honest
 * sign-in too.
 */
async function recordAttempt(email: string): Promise<void> {
  await tx(async (c) => {
    await c.query(`insert into login_attempts (email, succeeded) values ($1, false)`, [email]);

    // Same transaction, so this count sees the row written a line above and
    // therefore includes the attempt being judged. That is why the comparison is
    // `>` and not the `>=` a count taken before the insert would use — the
    // cut-off is unchanged, the eighth failure still gets served.
    const counted = await c.query<{ count: string }>(
      `select count(*)::text as count from login_attempts
        where email = $1 and not succeeded
          and attempted_at > now() - ($2 || ' minutes')::interval`,
      [email, String(WINDOW_MINUTES)],
    );

    if (Number(counted.rows[0].count) > MAX_FAILURES) {
      throw new ProblemError('login-rate-limited', {
        headers: { 'Retry-After': String(WINDOW_MINUTES * 60) },
      });
    }
  });
}

/**
 * A proven identity wipes the address's failure budget.
 *
 * These rows are keyed on an address anyone can type, never on an account anyone
 * has shown they own. Without this delete, eight guesses by a stranger shut the
 * real owner out for fifteen minutes, the stranger renews that at will, and
 * getting the password right does nothing to help — the throttle would protect
 * nobody and deny exactly one person. Proving you hold the credential is the
 * evidence that the failures were not yours.
 */
async function clearAttempts(email: string): Promise<void> {
  await query(`delete from login_attempts where email = $1`, [email]);
}

async function signUp(email: string, password: string) {
  const password_hash = await hashPassword(password);

  const user = await tx(async (c) => {
    const existing = await c.query<{ id: string }>(
      `select id from users where email = $1 for update`,
      [email],
    );

    // An address we already know. Adding a password to it here would let anyone
    // who guesses an email take the account over, so this is a refusal — the way
    // to get a password onto an existing account is to sign in first.
    //
    // This refusal is visible: 409 here and 201 below tell a caller whether an
    // address is registered, and that is a leak we are choosing, not one we
    // missed. Hiding it needs somewhere to defer the answer to — accept every
    // sign-up flatly, then mail either "confirm your account" or "you already
    // have one", the way the magic link's flat 202 does. lib/mail.ts has no
    // provider yet, so until it does the throttle above is the whole mitigation:
    // the oracle still answers, just no faster than a guesser gets answered.
    if (existing.rows[0]) throw new ProblemError('email-already-linked');

    const created = await c.query<SessionUser>(
      `insert into users (display_name, email, password_hash, password_set_at)
       values ($1, $2, $3, now())
   returning ${USER_COLUMNS}`,
      [email.split('@')[0], email, password_hash],
    );
    return created.rows[0];
  });

  await clearAttempts(email);
  await issueSession(user.id);
  // 201: a sign-up made something. Sign-in below returns 200, which is the only
  // difference a client can see between the two intents.
  return json(toMe(user), { status: 201 });
}

async function signIn(email: string, password: string) {
  const rows = await query<SessionUser & { password_hash: string | null }>(
    `select ${USER_COLUMNS}, password_hash from users where email = $1`,
    [email],
  );
  const user = rows[0] ?? null;

  // Runs the full hash even when there is no user and even when the user has no
  // password — see verifyPassword. An early return here would make "no such
  // account" measurably faster than "wrong password".
  const ok = await verifyPassword(password, user?.password_hash ?? null);

  // One error for every failure mode: unknown address, wrong password, and an
  // account that has never had a password all answer identically. Telling them
  // apart is the whole of account enumeration. The attempt is already on record
  // as a failure — recordAttempt() wrote it before any of this ran — so leaving
  // by this path needs no bookkeeping.
  if (!ok || !user) throw new ProblemError('invalid-credentials');

  await clearAttempts(email);

  // The one moment the plaintext and a stale row are in the same scope, so it is
  // the only moment a row written with weaker parameters can be brought forward
  // without asking anyone to type their password again. `password_set_at` is
  // untouched: the person did not set a password today, we re-wrapped the one
  // they already had.
  const stored = user.password_hash;
  if (stored !== null && needsRehash(stored)) {
    await query(`update users set password_hash = $1 where id = $2`, [
      await hashPassword(password),
      user.id,
    ]);
  }

  await issueSession(user.id);
  return json(toMe(user));
}
