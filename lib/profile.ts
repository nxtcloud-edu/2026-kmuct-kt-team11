/**
 * The onboarding answers, as options and as labels.
 *
 * These lived inside `app/(onboarding)/onboarding/steps.tsx` until the account
 * screen had to show the same answers back. Two copies of a value list is two
 * chances to disagree about what `undisclosed` is called, so there is one list
 * and both screens read it.
 *
 * The types come from `lib/session.ts` as `import type`, which is erased at
 * compile time — nothing in this module pulls `pg` or `next/headers` into a
 * Client Component bundle.
 *
 * `AREAS` is a plain string list rather than a union because `users.home_area`
 * is free text with only a length CHECK behind it: the picker offers ten, the
 * column accepts anything up to 80 characters, and narrowing here would make the
 * client stricter than the database for no gain.
 */
import type { AgeBand, Gender } from './session';

export const GENDERS: { value: Gender; label: string }[] = [
  { value: 'female', label: '여성' },
  { value: 'male', label: '남성' },
  { value: 'undisclosed', label: '선택 안 함' },
];

export const AGE_BANDS: { value: AgeBand; label: string }[] = [
  { value: '10s', label: '10대' },
  { value: '20s', label: '20대' },
  { value: '30s', label: '30대' },
  { value: '40s', label: '40대' },
  { value: '50plus', label: '50대+' },
];

export const AREAS = ['성수', '연남', '한남', '강남', '을지로', '홍대', '압구정', '여의도', '잠실', '기타'];

/**
 * What a screen prints where an answer is missing.
 *
 * Null is not the same as `undisclosed`: one is a question that was skipped, the
 * other is a question that was answered "I'd rather not say". The account screen
 * shows the skipped ones as this word — never as a blank, and never in
 * `--text-tertiary`, which measures 2.81:1 and may not carry text a user reads.
 */
export const UNSET = '미설정';

export function genderLabel(v: Gender | null): string {
  return GENDERS.find((g) => g.value === v)?.label ?? UNSET;
}

export function ageBandLabel(v: AgeBand | null): string {
  return AGE_BANDS.find((a) => a.value === v)?.label ?? UNSET;
}
