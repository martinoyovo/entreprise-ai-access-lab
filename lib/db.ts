import { Pool, type PoolClient } from "pg";

// One pool per process. Next.js dev mode re-evaluates modules on every change,
// so keep the pool on globalThis to avoid leaking connections.
const g = globalThis as unknown as { pgPool?: Pool };
export const pool = g.pgPool ?? new Pool({ connectionString: process.env.DATABASE_URL });
g.pgPool = pool;

export type Db = Pool | PoolClient;

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
