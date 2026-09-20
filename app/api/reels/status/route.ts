import { withRoute, json } from '@/lib/route';
import { readIngestStatus } from '@/lib/ingest/status';
import { requireUser } from '@/lib/session';

/**
 * What the signed-in user's reel ingestion is doing right now.
 *
 * The smallest endpoint in the app, and it is meant to stay that way. Its only
 * consumer is the status card on the home screen
 * (app/(app)/home/ingest-status.tsx), which polls it every few seconds while the
 * tab is visible so a reel that lands while the user is looking appears without
 * a refresh. One indexed aggregate over a handful of rows — see
 * lib/ingest/status.ts for why it is an aggregate and not a list.
 *
 * READ ONLY. Nothing here starts, retries or cancels a pass, and nothing should:
 * the ingest trigger lives behind `CRON_SECRET`
 * (app/api/internal/ingest/instagram/route.ts) and a user-session endpoint that
 * could kick the poller would be a way for any signed-in account to spend the
 * Instagram account's rate budget.
 *
 * Scoped to the caller by `requireUser()`, and there is no id parameter to
 * widen it with. A reel is one person's DM.
 */

// Counts rows on every call. Marked explicitly so it can never be mistaken for
// a prerenderable GET and served from a cache — a cached status is a card that
// says `분석 중` about a reel that finished four minutes ago.
export const dynamic = 'force-dynamic';

export const GET = withRoute(async () => {
  const user = await requireUser();
  return json(await readIngestStatus(user.id));
});
