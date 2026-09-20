/**
 * What a saved place is called when Gaja could not pin it.
 *
 * ── WHY THIS IS ONE CONSTANT AND NOT FOUR STRINGS ───────────────────────────
 * Four screens render the same fallback — the home deck, the saved-places list,
 * and the place-detail view twice (the place itself and its siblings from the
 * same reel). They had four copies of the sentence and all four were wrong in
 * the same way, which is what a duplicated string is for.
 *
 * ── WHY THE OLD COPY WAS WRONG ──────────────────────────────────────────────
 * It said `장소를 확인하는 중이에요` — "we're checking the place". That is a
 * progress claim, and nothing is in progress. `saved_places.status = 'pending'`
 * with `place_id = null` is what lib/ingest/save-reel.ts writes for a venue
 * whose ordinal did not geocode; the extraction has already finished and no
 * code path ever re-resolves the row. A user who reads "확인하는 중" waits, and
 * they will wait forever — one sat on that sentence for five minutes during a
 * live demo before asking why it was so slow.
 *
 * The honest statement is that we looked and failed. It is phrased in the past
 * tense for exactly that reason, and it matches the sentence the events cards
 * already use for the same situation (`위치를 확인하지 못해 저장할 수 없어요`), so
 * the two screens describe one fact the same way.
 *
 * NOT an error, and not styled as one. A reel whose caption names a café but
 * prints no address is the ordinary case, not a failure — the venue is still
 * saved, still has its name and hours in `reels.extracted`, and still links
 * back to the post. The only thing missing is a map pin.
 */
export const UNRESOLVED_PLACE_LABEL = '위치를 확인하지 못했어요';
