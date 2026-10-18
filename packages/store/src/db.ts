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
  /** A setting or stored secret changed (admin console); payload is its key. */
  settingsChanged: 'opend_settings_changed',
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
 * The schema a connection string selects with `options=-c search_path=<schema>`
 * (multi-site fleets put each site in its own schema), or `public`.
 */
export function connectionSchema(connectionString: string): string {
  let options: string | null;
  try {
    options = new URL(connectionString).searchParams.get('options');
  } catch {
    return 'public';
  }
  const match = options?.match(/search_path\s*=\s*"?([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[1] ?? 'public';
}

/** The connection string without its `options` parameter: the database itself. */
function databaseKey(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('options');
    return url.toString();
  } catch {
    return connectionString;
  }
}

/**
 * The channel name used on the wire. Notifications reach every listener of a
 * database, so a site in its own schema gets channels of its own; the public
 * schema (a single-site deployment) keeps the plain names.
 */
export function wireChannel(channel: string, schema: string): string {
  return schema === 'public' ? channel : `${channel}:${schema}`;
}

/**
 * Applies pending migrations to the connection's schema. An advisory lock per
 * schema makes concurrent starts (several replicas running migrations on boot)
 * safe.
 */
export async function migrate(pool: Pool): Promise<string[]> {
  return withTransaction(pool, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(case when current_schema() = 'public' then 4224242 else hashtextextended('opend_migrate:' || current_schema(), 0) end)",
    );
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

/** Notifies `channel` for the schema the query runs in (see `wireChannel`). */
export async function notify(db: Db, channel: string, payload = ''): Promise<void> {
  await db.query(
    "select pg_notify(case when current_schema() = 'public' then $1 else $1 || ':' || current_schema() end, $2)",
    [channel, payload],
  );
}

export interface Listener {
  /** Resolves once the first connection is listening. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

interface Subscription {
  /** Wire channel → plain channel name reported to `onMessage`. */
  channels: Map<string, string>;
  onMessage: (channel: string, payload: string) => void;
  onError: (err: unknown) => void;
  markReady: () => void;
}

/**
 * One LISTEN connection per database and process, shared by every listener
 * (and every site schema) on it, reconnecting after errors.
 */
class Hub {
  private client: pg.Client | null = null;
  private retry: NodeJS.Timeout | undefined;
  private connected = false;
  private closed = false;
  readonly subs = new Set<Subscription>();

  constructor(
    private readonly connectionString: string,
    private readonly onEmpty: () => void,
  ) {
    void this.connect();
  }

  private wire(): Set<string> {
    const all = new Set<string>();
    for (const sub of this.subs) for (const channel of sub.channels.keys()) all.add(channel);
    return all;
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const c = new pg.Client({ connectionString: this.connectionString });
    this.client = c;
    this.connected = false;
    c.on('notification', (msg) => {
      for (const sub of this.subs) {
        const plain = sub.channels.get(msg.channel);
        if (plain !== undefined) sub.onMessage(plain, msg.payload ?? '');
      }
    });
    c.on('error', (err) => this.reconnect(c, err));
    try {
      await c.connect();
      for (const channel of this.wire()) await c.query(`listen ${quoteIdent(channel)}`);
      this.connected = true;
      for (const sub of this.subs) sub.markReady();
    } catch (err) {
      this.reconnect(c, err);
    }
  }

  private reconnect(c: pg.Client, err: unknown): void {
    if (this.client !== c) return;
    this.connected = false;
    for (const sub of this.subs) sub.onError(err);
    void c.end().catch(() => {});
    if (!this.closed) this.retry = setTimeout(() => void this.connect(), 1000);
  }

  async add(sub: Subscription): Promise<void> {
    const before = this.wire();
    this.subs.add(sub);
    if (!this.connected || !this.client) return; // connect() listens and marks it ready
    try {
      for (const channel of sub.channels.keys())
        if (!before.has(channel)) await this.client.query(`listen ${quoteIdent(channel)}`);
      sub.markReady();
    } catch (err) {
      this.reconnect(this.client, err);
    }
  }

  async remove(sub: Subscription): Promise<void> {
    this.subs.delete(sub);
    if (this.subs.size === 0) {
      this.closed = true;
      clearTimeout(this.retry);
      this.onEmpty();
      await this.client?.end().catch(() => {});
      return;
    }
    const still = this.wire();
    if (!this.connected || !this.client) return;
    for (const channel of sub.channels.keys())
      if (!still.has(channel))
        await this.client.query(`unlisten ${quoteIdent(channel)}`).catch(() => {});
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const hubs = new Map<string, Hub>();

/**
 * Listens on channels for the connection string's schema. Listeners on the
 * same database share one connection; `onMessage` gets the plain channel name.
 */
export function listen(
  connectionString: string,
  channels: string[],
  onMessage: (channel: string, payload: string) => void,
  onError: (err: unknown) => void = () => {},
): Listener {
  const schema = connectionSchema(connectionString);
  const key = databaseKey(connectionString);
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  const sub: Subscription = {
    channels: new Map(channels.map((c) => [wireChannel(c, schema), c])),
    onMessage,
    onError,
    markReady,
  };
  let hub = hubs.get(key);
  if (!hub) {
    const created: Hub = new Hub(key, () => {
      if (hubs.get(key) === created) hubs.delete(key);
    });
    hub = created;
    hubs.set(key, hub);
  }
  void hub.add(sub);
  let stopped = false;
  return {
    ready,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      markReady();
      await hub.remove(sub);
    },
  };
}
