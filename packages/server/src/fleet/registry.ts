import { randomBytes } from 'node:crypto';
import type { Db, Pool, SecretBox } from '@opend/store';
import type { Forward } from './forward.js';

/**
 * The fleet's own tables, in the `opend_fleet` schema next to the site schemas.
 * A site's settings are the environment a single-site deployment would get,
 * sealed as one value with `OPEND_FLEET_KEY`.
 */
const REGISTRY_SQL = `
create schema if not exists opend_fleet;
create table if not exists opend_fleet.sites (
  id bigserial primary key,
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  schema_name text not null unique,
  hosts text[] not null default '{}',
  editor_hosts text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'suspended')),
  env_sealed text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sites_hosts on opend_fleet.sites using gin (hosts);
create index if not exists sites_editor_hosts on opend_fleet.sites using gin (editor_hosts);
create table if not exists opend_fleet.forwards (
  host text primary key,
  upstream text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

export type SiteStatus = 'active' | 'suspended';

export interface Site {
  id: number;
  slug: string;
  schema: string;
  hosts: string[];
  editorHosts: string[];
  status: SiteStatus;
  env: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  id: number;
  slug: string;
  schema: string;
  hosts: string[];
  editorHosts: string[];
  status: SiteStatus;
  envSealed: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `id, slug, schema_name as schema, hosts, editor_hosts as "editorHosts", status,
  env_sealed as "envSealed", created_at as "createdAt", updated_at as "updatedAt"`;

export class SiteUnreadable extends Error {}

export async function migrateRegistry(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended('opend_fleet_registry', 0))");
    await client.query(REGISTRY_SQL);
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtextextended('opend_fleet_registry', 0))")
      .catch(() => {});
    client.release();
  }
}

/** The Postgres schema for a site slug. */
export function schemaFor(slug: string): string {
  return `site_${slug.replace(/-/g, '_')}`;
}

export class Registry {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  private open(row: Row): Site {
    const plain = this.box.decrypt(`site:${row.slug}`, row.envSealed);
    if (plain === null)
      throw new SiteUnreadable(`site ${row.slug}: settings sealed with another key`);
    const { envSealed, ...rest } = row;
    void envSealed;
    return { ...rest, env: JSON.parse(plain) as Record<string, string> };
  }

  private seal(slug: string, env: Record<string, string>): string {
    return this.box.encrypt(`site:${slug}`, JSON.stringify(env));
  }

  async list(): Promise<Site[]> {
    const { rows } = await this.db.query<Row>(
      `select ${COLUMNS} from opend_fleet.sites order by slug`,
    );
    return rows.map((r) => this.open(r));
  }

  async get(slug: string): Promise<Site | null> {
    const { rows } = await this.db.query<Row>(
      `select ${COLUMNS} from opend_fleet.sites where slug = $1`,
      [slug],
    );
    return rows[0] ? this.open(rows[0]) : null;
  }

  /** The site serving `host`, as a docs site or as its editor. */
  async byHost(host: string): Promise<{ site: Site; editor: boolean } | null> {
    const { rows } = await this.db.query<Row & { editor: boolean }>(
      `select ${COLUMNS}, not ($1 = any(hosts)) as editor from opend_fleet.sites
       where $1 = any(hosts) or $1 = any(editor_hosts) limit 1`,
      [host],
    );
    const row = rows[0];
    return row ? { site: this.open(row), editor: row.editor } : null;
  }

  async create(input: {
    slug: string;
    hosts: string[];
    editorHosts: string[];
    env: Record<string, string>;
  }): Promise<Site> {
    const { rows } = await this.db.query<Row>(
      `insert into opend_fleet.sites (slug, schema_name, hosts, editor_hosts, env_sealed)
       values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
      [
        input.slug,
        schemaFor(input.slug),
        input.hosts,
        input.editorHosts,
        this.seal(input.slug, input.env),
      ],
    );
    return this.open(rows[0]!);
  }

  async update(
    slug: string,
    patch: {
      hosts?: string[];
      editorHosts?: string[];
      env?: Record<string, string>;
      status?: SiteStatus;
    },
  ): Promise<Site | null> {
    const current = await this.get(slug);
    if (!current) return null;
    const { rows } = await this.db.query<Row>(
      `update opend_fleet.sites set hosts = $2, editor_hosts = $3, env_sealed = $4, status = $5,
         updated_at = now() where slug = $1 returning ${COLUMNS}`,
      [
        slug,
        patch.hosts ?? current.hosts,
        patch.editorHosts ?? current.editorHosts,
        this.seal(slug, patch.env ?? current.env),
        patch.status ?? current.status,
      ],
    );
    return rows[0] ? this.open(rows[0]) : null;
  }

  async remove(slug: string): Promise<boolean> {
    const res = await this.db.query('delete from opend_fleet.sites where slug = $1', [slug]);
    return res.rowCount === 1;
  }

  /** Hosts already used by another site or by a forward, to refuse duplicates. */
  async hostsTaken(hosts: string[], exceptSlug?: string): Promise<string[]> {
    const { rows } = await this.db.query<{ host: string }>(
      `select h as host from opend_fleet.sites, unnest(hosts || editor_hosts) h
       where h = any($1) and slug <> coalesce($2, '')
       union select host from opend_fleet.forwards where host = any($1)`,
      [hosts, exceptSlug ?? null],
    );
    return rows.map((r) => r.host);
  }

  async forwards(): Promise<Forward[]> {
    const { rows } = await this.db.query<Forward>(
      'select host, upstream from opend_fleet.forwards order by host',
    );
    return rows;
  }

  async forwardFor(host: string): Promise<Forward | null> {
    const { rows } = await this.db.query<Forward>(
      'select host, upstream from opend_fleet.forwards where host = $1',
      [host],
    );
    return rows[0] ?? null;
  }

  async setForward(forward: Forward): Promise<void> {
    await this.db.query(
      `insert into opend_fleet.forwards (host, upstream) values ($1, $2)
       on conflict (host) do update set upstream = excluded.upstream, updated_at = now()`,
      [forward.host, forward.upstream],
    );
  }

  async removeForward(host: string): Promise<boolean> {
    const res = await this.db.query('delete from opend_fleet.forwards where host = $1', [host]);
    return res.rowCount === 1;
  }
}

/** A random secret for a new site's own settings (session secret, admin token). */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}
