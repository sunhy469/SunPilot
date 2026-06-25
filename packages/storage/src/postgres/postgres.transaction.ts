import type { PostgresPool } from "./postgres.client.js";

export async function withPostgresTransaction<T>(pool: PostgresPool, work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // Whether the connection is broken and should be discarded by the pool.
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // Guard ROLLBACK: if it throws, the connection is unusable. Swallow the
    // rollback error so the original work error is preserved for the caller.
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    // Passing an error to release() tells the pool to discard this client
    // instead of recycling a possibly-broken connection.
    client.release(broken ? new Error("transaction ROLLBACK failed; discarding connection") : undefined);
  }
}
