/**
 * The MBTI types Gaja can show — all sixteen.
 *
 * The art arrived unlabelled as `Group N.png`. Fourteen were matched to named
 * files byte-for-byte; the remaining two were identified by what they depict and
 * are the ONLY inferred labels here:
 *   ISTJ ← Group 32 — rectangular glasses, holding a document
 *   INTP ← Group 24 — round glasses, pencil behind the ear, looking up
 * If those two are swapped, the fix is renaming two files in `public/mbti/`.
 *
 * `잘 모르겠어요` is not a type and deliberately does not live in this list — the
 * onboarding step renders it as an extra cell that writes null. Forcing a guess
 * would poison the recommendations the question exists to feed.
 */
export const MBTI_TYPES = [
  'ISTJ', 'ISFJ', 'INFJ', 'INTJ',
  'ISTP', 'ISFP', 'INFP', 'INTP',
  'ESTP', 'ESFP', 'ENFP', 'ENTP',
  'ESTJ', 'ESFJ', 'ENFJ', 'ENTJ',
] as const;

export type MbtiType = (typeof MBTI_TYPES)[number];

export function mbtiImage(t: MbtiType): string {
  return `/mbti/${t}.png`;
}

/** Narrows before a value from the wire or the database is treated as a type we can render. */
export function isMbtiType(v: string): v is MbtiType {
  return (MBTI_TYPES as readonly string[]).includes(v);
}
