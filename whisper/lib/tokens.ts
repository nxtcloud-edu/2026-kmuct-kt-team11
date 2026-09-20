import { createHash, randomBytes } from 'node:crypto';

/**
 * Tokens are stored hashed. A leaked database read must not yield usable magic
 * links, sessions or invites. SHA-256 is right here and bcrypt is not: these are
 * 256-bit random values, not user-chosen passwords, so there is nothing to brute
 * force and the hash only needs to be one-way.
 */
export function newToken(prefix: string): { token: string; hash: string } {
  const token = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const MAGIC_LINK_TTL_MIN = 15;      // api-contract.md, decision #3
export const SESSION_TTL_DAYS = 30;
export const INVITE_TTL_DAYS = 7;
