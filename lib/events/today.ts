/**
 * Today, in Seoul, as `YYYY-MM-DD`.
 *
 * ONE DEFINITION, BECAUSE TWO SCREENS RENDER THE SAME CARD. `lib/events/format.ts`
 * is pure and takes `today` as an argument precisely so nothing downstream reads
 * the clock during render — but somebody has to read it once, on the server, and
 * if each page did its own the events tab and the home rail could disagree about
 * whether a run has ended. A card that says `D-1` on one screen and `오늘 종료` on
 * the other is not a rounding difference; it is two answers to the same question.
 *
 * `Asia/Seoul` explicitly, not the server's local zone: `events.closes_on` is a
 * `date` and "has this ended" is asked in the timezone the venue is in. A
 * function running in `icn1` happens to agree today; pinning it means it still
 * agrees if the region ever changes.
 *
 * Its own file rather than a thirteenth export from `format.ts`: that file's
 * contract is that nothing in it reads the clock, and `scripts/test-events.sh`
 * compiles it alone on the strength of having no imports and no ambient state.
 * This function is the one impure part of the same job, so it is quarantined
 * where it cannot weaken that claim.
 *
 * `en-CA` is the locale whose short date IS ISO.
 */
export function seoulToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
