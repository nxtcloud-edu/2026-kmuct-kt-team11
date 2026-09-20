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
};

export default config;
