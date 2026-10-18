import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHANNELS,
  connectionSchema,
  createApiKey,
  createPool,
  createTestDatabase,
  exportSite,
  importSite,
  ImportRefused,
  listen,
  listReaders,
  migrate,
  notify,
  upsertOrg,
  upsertReader,
  upsertRepo,
  withTransaction,
  wireChannel,
  type Pool,
  type TestDatabase,
} from '../src/index.js';
import { testDatabaseUrl } from '../src/testing.js';

const url = testDatabaseUrl();

const schemaUrl = (base: string, schema: string): string => {
  const u = new URL(base);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
};

describe('connection schemas', () => {
  it('reads the schema from the connection string', () => {
    expect(connectionSchema('postgres://h/db')).toBe('public');
    expect(connectionSchema(schemaUrl('postgres://h/db', 'site_a'))).toBe('site_a');
    expect(wireChannel('opend_job_queued', 'public')).toBe('opend_job_queued');
    expect(wireChannel('opend_job_queued', 'site_a')).toBe('opend_job_queued:site_a');
  });
});

describe.skipIf(!url)('sites in their own schemas', () => {
  let db: TestDatabase;
  const pools: Record<string, Pool> = {};
  const urls: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDatabase(url!);
    for (const s of ['site_a', 'site_b', 'site_c']) {
      await db.pool.query(`create schema ${s}`);
      urls[s] = schemaUrl(db.url, s);
      pools[s] = createPool(urls[s]);
    }
    await migrate(pools.site_a!);
    await migrate(pools.site_b!);
    await migrate(pools.site_c!);
  });
  afterAll(async () => {
    for (const p of Object.values(pools)) await p.end();
    await db?.drop();
  });

  it('keeps each site’s rows in its own schema', async () => {
    await upsertOrg(pools.site_a!, { slug: 'acme', name: 'Acme A' });
    await upsertOrg(pools.site_b!, { slug: 'acme', name: 'Acme B' });
    await upsertReader(pools.site_a!, { email: 'ann@acme.example', orgSlug: 'acme' });
    await upsertReader(pools.site_b!, { email: 'ann@acme.example', orgSlug: 'acme' });
    expect((await listReaders(pools.site_a!)).map((r) => r.email)).toEqual(['ann@acme.example']);
    const { rows } = await db.pool.query('select count(*)::int as n from readers');
    expect(rows[0].n).toBe(0);
  });

  it('delivers notifications only to listeners of the same site', async () => {
    const got: string[] = [];
    const a = listen(urls.site_a!, [CHANNELS.releaseChanged], (c, p) => got.push(`a ${c} ${p}`));
    const b = listen(urls.site_b!, [CHANNELS.releaseChanged], (c, p) => got.push(`b ${c} ${p}`));
    const pub = listen(db.url, [CHANNELS.releaseChanged], (c, p) => got.push(`p ${c} ${p}`));
    await Promise.all([a.ready, b.ready, pub.ready]);
    await notify(pools.site_a!, CHANNELS.releaseChanged, '1');
    await notify(db.pool, CHANNELS.releaseChanged, '2');
    await expect
      .poll(() => got.sort())
      .toEqual([`a ${CHANNELS.releaseChanged} 1`, `p ${CHANNELS.releaseChanged} 2`]);
    await notify(pools.site_b!, CHANNELS.releaseChanged, '3');
    await expect.poll(() => got.length).toBe(3);
    expect(got).toContain(`b ${CHANNELS.releaseChanged} 3`);
    // All three share one connection to the database.
    const { rows } = await db.pool.query(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and query ilike 'listen%'",
    );
    expect(rows[0].n).toBe(1);
    await Promise.all([a.stop(), b.stop(), pub.stop()]);
  });

  it('moves a site to an empty one with an export', async () => {
    const repo = await upsertRepo(pools.site_a!, {
      fullName: 'acme/docs',
      sourceUrl: 'https://github.com/acme/docs.git',
    });
    const { key } = await createApiKey(pools.site_a!, {
      name: 'ci',
      scopes: ['read'],
      audience: 'staff',
      createdBy: 'test',
    });
    const data = await exportSite(pools.site_a!);
    expect(data.tables.readers).toHaveLength(1);

    const counts = await withTransaction(pools.site_c!, (c) => importSite(c, data));
    expect(counts).toMatchObject({ repos: 1, orgs: 1, readers: 1, api_keys: 1 });
    expect((await listReaders(pools.site_c!)).map((r) => r.email)).toEqual(['ann@acme.example']);
    const { rows } = await pools.site_c!.query('select id, full_name from repos');
    expect(rows).toEqual([{ id: repo.id, full_name: 'acme/docs' }]);
    const hash = await pools.site_c!.query('select id from api_keys where id = $1', [key.id]);
    expect(hash.rows).toHaveLength(1);
    // Sequences moved past the imported ids.
    const next = await upsertOrg(pools.site_c!, { slug: 'globex', name: 'Globex' });
    expect(next).toBeDefined();

    await expect(withTransaction(pools.site_c!, (c) => importSite(c, data))).rejects.toThrow(
      ImportRefused,
    );
    await expect(
      withTransaction(pools.site_b!, (c) =>
        importSite(c, { ...data, format: 'nope' } as unknown as typeof data),
      ),
    ).rejects.toThrow(ImportRefused);
  });
});
