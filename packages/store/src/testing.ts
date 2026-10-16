import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, migrate, type Pool } from './db.js';

export interface TestDatabase {
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

/**
 * Creates a fresh, migrated database next to the one `baseUrl` points at, so
 * test files can run in parallel. Used by integration tests only.
 */
export async function createTestDatabase(baseUrl: string): Promise<TestDatabase> {
  const name = `opend_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  await migrate(pool);
  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: baseUrl });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

/**
 * The database URL for integration tests. Tests are skipped when it is unset,
 * except in CI, where a missing database is an error.
 */
export function testDatabaseUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL must be set in CI');
  return url;
}
