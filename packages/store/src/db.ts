import pg from 'pg';
import { MIGRATIONS } from './migrations.js';

// bigint ids and counts fit comfortably in a JS number for this application.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export type Db = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** Notification channels. */
export const CHANNELS = {
  /** A live release was swapped; payload is the repo id. */
  releaseChanged: 'opend_release_changed',
  /** Orgs, readers or entitlements changed. */
  entitlementsChanged: 'opend_entitlements_changed',
  /** A build job was queued. */
  jobQueued: 'opend_job_queued',
} as const;

export function createPool(
  connectionString: string,
  onIdleError: (err: Error) => void = (err) => console.error('postgres idle client error', err),
): Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client can be terminated by the server (restart, failover). Without
  // a handler the pool's 'error' event would crash the process.
  pool.on('error', onIdleError);
  return pool;
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies pending migrations. An advisory lock makes concurrent starts (several
 * replicas running migrations on boot) safe.
 */
export async function migrate(pool: Pool): Promise<string[]> {
  return withTransaction(pool, async (client) => {
    await client.query('select pg_advisory_xact_lock(4224242)');
    await client.query(
      'create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())',
    );
    const { rows } = await client.query<{ id: string }>('select id from schema_migrations');
    const applied = new Set(rows.map((r) => r.id));
    const ran: string[] = [];
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await client.query(m.sql);
      await client.query('insert into schema_migrations (id) values ($1)', [m.id]);
      ran.push(m.id);
    }
    return ran;
  });
}

export async function notify(db: Db, channel: string, payload = ''): Promise<void> {
  await db.query('select pg_notify($1, $2)', [channel, payload]);
}

export interface Listener {
  /** Resolves once the first connection is listening. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

/** Listens on channels with a dedicated connection, reconnecting after errors. */
export function listen(
  connectionString: string,
  channels: string[],
  onMessage: (channel: string, payload: string) => void,
  onError: (err: unknown) => void = () => {},
): Listener {
  let client: pg.Client | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));

  const reconnect = (c: pg.Client, err: unknown) => {
    onError(err);
    void c.end().catch(() => {});
    if (!stopped) retry = setTimeout(() => void connect(), 1000);
  };

  const connect = async () => {
    if (stopped) return;
    const c = new pg.Client({ connectionString });
    client = c;
    c.on('notification', (msg) => onMessage(msg.channel, msg.payload ?? ''));
    c.on('error', (err) => reconnect(c, err));
    try {
      await c.connect();
      for (const channel of channels) await c.query(`listen "${channel.replace(/"/g, '')}"`);
      markReady();
    } catch (err) {
      reconnect(c, err);
    }
  };
  void connect();

  return {
    ready,
    stop: async () => {
      stopped = true;
      clearTimeout(retry);
      markReady();
      await client?.end().catch(() => {});
    },
  };
}
