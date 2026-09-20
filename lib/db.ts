import { Pool, type QueryResultRow } from 'pg';

declare global {
  var __gajaPool: Pool | undefined;
}

/**
 * On a long-lived server there is one process, so one pool of 10 is right. On Vercel
 * there is no such thing as one process: the platform runs N function instances and
 * scales N with traffic, each with its own module instance and therefore its own pool.
 * A `max` of 10 is really 10 × N connections, and N is not a number we choose — a
 * traffic spike exhausts Postgres' connection limit and every instance starts failing
 * to connect at once. Keeping it at 1 per instance makes the ceiling proportional to
 * concurrency instead of a multiple of it. `VERCEL` is set in Vercel's build and
 * runtime environments, and nowhere else, so local and self-hosted keep the 10.
 *
 * This only works if production's DATABASE_URL points at Supabase's TRANSACTION POOLER
 * on port 6543, not the direct connection on 5432 — the direct port hands out real
 * backend connections and would hit the same ceiling from the other side. The `tx()`
 * helper below is safe under transaction pooling: it checks out one dedicated client
 * and wraps the work in explicit BEGIN/COMMIT, so the whole transaction lives inside a
 * single pooled session. It carries no state across statements — no prepared
 * statements, no SET, no advisory locks — which is what transaction mode forbids.
 */
const max = process.env.VERCEL ? 1 : 10;

// Next dev reloads modules; a module-level Pool would leak a connection pool per reload.
export const pool =
  global.__gajaPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    idleTimeoutMillis: 30_000,
    // Explicit, not the driver default — an unbounded connect is a hang, not an error.
    connectionTimeoutMillis: 5_000,
  });
if (process.env.NODE_ENV !== 'production') global.__gajaPool = pool;

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Runs fn inside a transaction. Rolls back on throw, always releases. */
export async function tx<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
