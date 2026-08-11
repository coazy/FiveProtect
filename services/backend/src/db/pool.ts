import pg from 'pg';

const { Pool, types } = pg;

// node-postgres returns bigint as a string to avoid silent precision loss. Every bigint in
// this schema is a count or an id that fits comfortably in a double, and a string would
// leak into JSON responses as a quoted number.
types.setTypeParser(20, (value) => Number.parseInt(value, 10));

export type Database = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): Database {
  return new Pool({
    connectionString,
    // The long poll on the verdict endpoint holds no connection between polls, so the pool
    // only needs to cover genuinely concurrent queries.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * Runs `body` inside a transaction, rolling back on any throw.
 *
 * Used where a read and a write must not be separated — chiefly nonce consumption, where a
 * second attempt has to find the nonce already gone.
 */
export async function withTransaction<T>(
  pool: Database,
  body: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
