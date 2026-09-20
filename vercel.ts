import { type VercelConfig } from '@vercel/config/v1';

/**
 * Vercel project configuration.
 *
 * Shape note: @vercel/config's compiler (node_modules/@vercel/config/dist/cli.js,
 * `configureRouter`) builds the project config from `module.default` and then merges
 * every *other* named `export const` in as a TOP-LEVEL config field. So a named
 * `export const config = { … }` would compile to `{ "config": { … } }` — a nested key
 * Vercel does not read. The config object therefore leaves as the default export.
 */
const config: VercelConfig = {
  framework: 'nextjs',

  // Seoul, not the iad1 (Washington) default. Gaja is a Seoul-first product: its users,
  // its Postgres and the places it plans around are all in Korea. Functions left in iad1
  // would put a transpacific round trip in front of every database query — the request
  // crosses the ocean to reach the function, and the function crosses back for each
  // query it makes. Pinning the functions next to the database keeps that hop local.
  regions: ['icn1'],

  // The Instagram DM inbox poller. app/api/internal/ingest/instagram/route.ts
  // checks `Authorization: Bearer $CRON_SECRET` in constant time, which Vercel
  // sends on every cron invocation and which also lets the route be driven by
  // hand — the only way it runs today, because this project has no Vercel
  // deployment yet (org admin approval pending).
  //
  // PLAN CONSTRAINT, AND THIS SCHEDULE IS THE CONSERVATIVE READ OF IT. Hobby
  // allows a small number of cron jobs triggered ONCE PER DAY; anything
  // finer-grained — `*/20 * * * *`, `* * * * *` — is a Pro feature, and a
  // sub-daily schedule on Hobby is rejected. A daily poll is close to useless
  // for this product: someone shares a reel at lunch and sees it tomorrow. So
  // this entry is here to be deployable on whatever plan the project lands on,
  // not because daily is the intended cadence.
  //
  // ON PRO, CHANGE THIS ONE LINE to '*/20 * * * *'. The poller is already built
  // for it: lib/ingest/inbox/instagram-poll.ts enforces its own 15-minute floor
  // against `ingest_state.last_attempt_at` with jitter, so a cron that fires
  // more often than the floor is harmless — the extra passes return
  // `skipped: 'min-interval'` without touching Instagram. The floor is the real
  // rate limit; the cron only decides how often it gets a chance to expire.
  crons: [{ path: '/api/internal/ingest/instagram', schedule: '0 3 * * *' }],
};

export default config;
