import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('[db] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function getClient(): Promise<PoolClient> {
  return getPool().connect();
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
