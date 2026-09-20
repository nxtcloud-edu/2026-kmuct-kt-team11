/**
 * One manual ingest pass, from clips captured out of a logged-in browser.
 *
 * WHY THIS EXISTS, AND WHEN TO DELETE IT
 *
 * `InstagramPollSource` needs `IG_SESSION_ID`, and `sessionid` is httpOnly — no
 * script can read it out of a browser, so it has to be pasted in by hand. Until
 * that happens the poller cannot run, and until the poller runs a reel that has
 * already arrived in the DM inbox sits there invisible to the product.
 *
 * This script closes that gap without weakening anything: it reads clips from a
 * JSON file captured out of the browser session, then runs them through the
 * SAME four stages the cron route runs, in the same order, with the same
 * functions. It is a different `InboxSource`, hand-fed — which is exactly the
 * seam `lib/ingest/inbox/index.ts` was built to allow.
 *
 * Delete this once `IG_SESSION_ID` is configured and the poller runs. It is a
 * bridge, not a second ingestion path, and it must never grow logic the route
 * does not also have — if it does, the two drift and this one silently becomes
 * the liar.
 *
 * Usage:  ./scripts/ingest-inbox-once.sh <clips.json>
 */

import { readFileSync } from 'node:fs';
import { resolveSenderToUser } from '../lib/ingest/route-sender';
import { extractPlacesFromCaption } from '../lib/extract/caption';
import { resolvePlaceCandidates, placeIdsByOrdinal } from '../lib/research/resolve-place';
import { saveReel } from '../lib/ingest/save-reel';
import { captureReelThumbnail } from '../lib/ingest/thumbnail';
import type { PlaceCategory } from '../lib/api/types';

type Clip = {
  igsid: string;
  reelVideoId: string;
  sourceUrl: string | null;
  caption: string | null;
  category: PlaceCategory;
  thumb: { url: string; width: number; height: number } | null;
};

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('usage: ingest-inbox-once <clips.json>');
  const clips: Clip[] = JSON.parse(readFileSync(path, 'utf8'));

  let saved = 0;
  let dropped = 0;
  let existed = 0;

  for (const clip of clips) {
    console.log(`\n── ${clip.reelVideoId} ──`);

    // 1. Route. An unrecognised sender is dropped and never written — the same
    //    rule the route enforces, for the same reason.
    const routed = await resolveSenderToUser(clip.igsid);
    if (!routed) {
      console.log(`   sender ${clip.igsid}: no account → dropped`);
      dropped++;
      continue;
    }
    console.log(`   sender ${clip.igsid} → user ${routed.userId}`);

    // 2. Extract. Rung 1 only; this script never downloads video.
    const extraction = clip.caption ? await extractPlacesFromCaption(clip.caption) : null;
    console.log(
      `   extraction: ${extraction?.places.length ?? 0} place(s), ` +
        `confidence=${extraction?.confidence ?? 'n/a'}, model=${extraction?.model ?? 'n/a'}`,
    );

    // 3. Resolve. Network calls, deliberately OUTSIDE saveReel's transaction —
    //    holding a pooled client across a geocode would be the bug the pool of
    //    one on Vercel punishes hardest.
    //
    //    `clip.category` is now the FALLBACK, not the answer. The extractor
    //    classifies each venue with its own confidence
    //    (`PlaceCandidate.category`), and the value typed into the clips JSON
    //    only covers the entries it declined to classify. Leaving it in the file
    //    is still worth it: a hand-fed clip is one a human already looked at.
    let placeIds: Map<number, string> | undefined;
    if (extraction && extraction.places.length > 0) {
      const resolved = await resolvePlaceCandidates(extraction.places, {
        category: clip.category,
      });
      placeIds = placeIdsByOrdinal(resolved);
      const nameByOrdinal = new Map(extraction.places.map((p) => [p.ordinal, p.name]));
      for (const r of resolved) {
        const name = nameByOrdinal.get(r.ordinal) ?? '(unknown)';
        const label = r.placeId
          ? `→ ${r.placeId}${r.matched ? ' (matched existing)' : ''}`
          : `unresolved (${r.failure ?? '?'})`;
        console.log(`     ${r.ordinal}. ${name} ${label}`);
      }
    }

    // 4. Save. One transaction, idempotent on (user_id, reel_video_id).
    const result = await saveReel({
      userId: routed.userId,
      reelVideoId: clip.reelVideoId,
      sourceUrl: clip.sourceUrl,
      rawCaption: clip.caption,
      extraction,
      placeIds,
    });
    console.log(
      `   saved: reel=${result.reelId} places=${result.savedPlaceIds.length} ` +
        `alreadyExisted=${result.alreadyExisted}`,
    );
    if (result.alreadyExisted) existed++;
    else saved++;

    // 5. Thumbnail. After the commit, in its own narrow failure domain: a CDN
    //    hiccup must not cost us ten extracted venues.
    if (clip.thumb && !result.alreadyExisted) {
      const outcome = await captureReelThumbnail(result.reelId, clip.thumb);
      if (outcome.ok) console.log('   thumbnail: stored');
      else console.log(`   thumbnail: skipped (${outcome.reason})`);
    }
  }

  console.log(`\nsaved=${saved} alreadyExisted=${existed} dropped=${dropped}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
