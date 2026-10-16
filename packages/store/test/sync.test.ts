import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  SyncError,
  createTestDatabase,
  enqueueJob,
  forgetPolledRefs,
  getReaderAccess,
  listAudit,
  listOrgs,
  listPolledRefs,
  listReaders,
  recordPolledRef,
  syncEntitlements,
  upsertRepo,
  type EntitlementSnapshot,
  type TestDatabase,
} from '../src/index.js';
import { testDatabaseUrl } from '../src/testing.js';

const url = testDatabaseUrl();
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('migrations', () => {
  it('have unique ids and include 003_polling', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('003_polling');
  });
});

describe.skipIf(!url)('polled refs', () => {
  let db: TestDatabase;
  let repoId: number;
  beforeAll(async () => {
    db = await createTestDatabase(url!);
    repoId = (await upsertRepo(db.pool, { fullName: 'acme/poll', sourceUrl: '/tmp/x' })).id;
  });
  afterAll(async () => db?.drop());

  it('queues one job per new head sha, even with concurrent pollers', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordPolledRef(db.pool, { repoId, ref: 'main', sha: SHA_A }),
      ),
    );
    const jobs = results.filter((j) => j !== null);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ repoId, ref: 'main', sha: SHA_A, status: 'queued' });
    expect(await recordPolledRef(db.pool, { repoId, ref: 'main', sha: SHA_A })).toBeNull();
    expect(await listPolledRefs(db.pool, repoId)).toEqual([
      { ref: 'main', sha: SHA_A, jobId: jobs[0]!.id },
    ]);
  });

  it('does not queue a sha a webhook already queued', async () => {
    await enqueueJob(db.pool, { repoId, ref: 'main', sha: SHA_B });
    expect(await recordPolledRef(db.pool, { repoId, ref: 'main', sha: SHA_B })).toBeNull();
    expect(await listPolledRefs(db.pool, repoId)).toEqual([
      { ref: 'main', sha: SHA_B, jobId: null },
    ]);
  });

  it('forgets refs that disappeared from the remote', async () => {
    await recordPolledRef(db.pool, { repoId, ref: 'v1', sha: SHA_A });
    expect(await forgetPolledRefs(db.pool, repoId, ['main'])).toBe(1);
    expect((await listPolledRefs(db.pool, repoId)).map((r) => r.ref)).toEqual(['main']);
  });
});

describe.skipIf(!url)('entitlement sync', () => {
  let db: TestDatabase;
  const actor = { actor: 'test' };

  const base: EntitlementSnapshot = {
    orgs: [
      {
        slug: 'acme',
        name: 'Acme',
        entitlements: { products: ['widget'], features: [], version: '1.4' },
        readers: ['ann@acme.example', { email: 'Bob@Acme.example', name: 'Bob' }],
      },
      {
        slug: 'globex',
        name: 'Globex',
        entitlements: { products: ['widget', 'gadget'], features: ['sso'], version: '2.1' },
        readers: ['gus@globex.example'],
      },
    ],
  };

  beforeAll(async () => {
    db = await createTestDatabase(url!);
  });
  beforeEach(async () => {
    await db.pool.query('truncate orgs, audit_log cascade');
  });
  afterAll(async () => db?.drop());

  it('creates everything from an empty database, then is a no-op', async () => {
    const first = await syncEntitlements(db.pool, { snapshot: base, mode: 'merge' }, actor);
    expect(first.summary).toEqual({
      orgs: { created: 2, updated: 0, removed: 0 },
      readers: { created: 3, updated: 0, removed: 0 },
    });
    expect((await listReaders(db.pool)).map((r) => r.email).sort()).toEqual([
      'Bob@Acme.example',
      'ann@acme.example',
      'gus@globex.example',
    ]);
    const again = await syncEntitlements(db.pool, { snapshot: base, mode: 'replace' }, actor);
    expect(again.summary).toEqual({
      orgs: { created: 0, updated: 0, removed: 0 },
      readers: { created: 0, updated: 0, removed: 0 },
    });
  });

  it('merge upserts only; replace also removes what the snapshot omits', async () => {
    await syncEntitlements(db.pool, { snapshot: base, mode: 'merge' }, actor);
    const partial: EntitlementSnapshot = {
      orgs: [
        {
          slug: 'acme',
          name: 'Acme Corp',
          entitlements: { products: ['widget'], features: ['sso'], version: '1.4' },
          readers: ['ann@acme.example', 'cy@acme.example'],
        },
      ],
    };
    const merged = await syncEntitlements(db.pool, { snapshot: partial, mode: 'merge' }, actor);
    expect(merged.summary).toEqual({
      orgs: { created: 0, updated: 1, removed: 0 },
      readers: { created: 1, updated: 0, removed: 0 },
    });
    expect(merged.changes.orgs.updated[0]).toMatchObject({
      slug: 'acme',
      name: { from: 'Acme', to: 'Acme Corp' },
      entitlements: { to: { features: ['sso'] } },
    });
    expect((await listOrgs(db.pool)).map((o) => o.slug)).toEqual(['acme', 'globex']);
    expect(await listReaders(db.pool)).toHaveLength(4);

    const replaced = await syncEntitlements(db.pool, { snapshot: partial, mode: 'replace' }, actor);
    expect(replaced.summary).toEqual({
      orgs: { created: 0, updated: 0, removed: 1 },
      readers: { created: 0, updated: 0, removed: 2 },
    });
    expect(replaced.changes.orgs.removed).toEqual(['globex']);
    expect(replaced.changes.readers.removed.map((r) => r.email)).toEqual([
      'Bob@Acme.example',
      'gus@globex.example',
    ]);
    expect((await listReaders(db.pool)).map((r) => r.email)).toEqual([
      'ann@acme.example',
      'cy@acme.example',
    ]);
  });

  it('keeps omitted entitlements, revokes null ones, and moves readers between orgs', async () => {
    await syncEntitlements(db.pool, { snapshot: base, mode: 'merge' }, actor);
    const result = await syncEntitlements(
      db.pool,
      {
        snapshot: {
          orgs: [
            { slug: 'acme', name: 'Acme', readers: ['ann@acme.example', 'BOB@acme.example'] },
            { slug: 'globex', name: 'Globex', entitlements: null, readers: ['gus@globex.example'] },
            { slug: 'initech', name: 'Initech', readers: [{ email: 'bob@acme.example' }] },
          ],
        },
        mode: 'merge',
      },
      actor,
    ).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(SyncError);
    expect(String(result)).toMatch(/listed in both acme and initech/);

    const ok = await syncEntitlements(
      db.pool,
      {
        snapshot: {
          orgs: [
            { slug: 'globex', name: 'Globex', entitlements: null },
            { slug: 'initech', name: 'Initech', readers: ['bob@acme.example'] },
          ],
        },
        mode: 'merge',
      },
      actor,
    );
    expect(ok.changes.readers.updated).toEqual([
      { email: 'Bob@Acme.example', org: 'initech', fromOrg: 'acme' },
    ]);
    const orgs = await listOrgs(db.pool);
    expect(orgs.find((o) => o.slug === 'acme')?.version).toBe('1.4');
    expect(orgs.find((o) => o.slug === 'globex')?.version).toBeNull();
    const gus = (await listReaders(db.pool)).find((r) => r.email === 'gus@globex.example')!;
    expect((await getReaderAccess(db.pool, gus.id))?.context).toBeNull();
  });

  it('dry run returns the diff and writes nothing, not even an audit entry', async () => {
    const result = await syncEntitlements(
      db.pool,
      { snapshot: base, mode: 'replace' },
      { ...actor, dryRun: true },
    );
    expect(result.dryRun).toBe(true);
    expect(result.summary.orgs.created).toBe(2);
    expect(result.changes.readers.created.map((r) => r.email)).toContain('gus@globex.example');
    expect(await listOrgs(db.pool)).toEqual([]);
    expect(await listAudit(db.pool)).toEqual([]);
  });

  it('records a summary in the audit log', async () => {
    await syncEntitlements(
      db.pool,
      { snapshot: base, mode: 'merge' },
      { actor: 'reconcile', source: 'https://crm.example/export' },
    );
    const [entry] = await listAudit(db.pool);
    expect(entry).toMatchObject({
      actor: 'reconcile',
      action: 'entitlements.sync',
      detail: {
        mode: 'merge',
        source: 'https://crm.example/export',
        summary: { orgs: { created: 2 }, readers: { created: 3 } },
        orgsCreated: ['acme', 'globex'],
      },
    });
  });

  it('applies change events in order', async () => {
    await syncEntitlements(db.pool, { snapshot: base, mode: 'merge' }, actor);
    const result = await syncEntitlements(
      db.pool,
      {
        events: [
          { type: 'org.upsert', org: { slug: 'newco', name: 'Newco' } },
          { type: 'reader.add', org: 'newco', email: 'nia@newco.example', name: 'Nia' },
          {
            type: 'org.upsert',
            org: { slug: 'acme', name: 'Acme', readers: ['ann@acme.example'] },
            exactReaders: true,
          },
          { type: 'reader.remove', email: 'GUS@globex.example' },
          { type: 'org.delete', slug: 'globex' },
          { type: 'org.delete', slug: 'never-existed' },
        ],
      },
      actor,
    );
    expect(result.mode).toBe('events');
    expect(result.summary).toEqual({
      orgs: { created: 1, updated: 0, removed: 1 },
      readers: { created: 1, updated: 0, removed: 2 },
    });
    expect((await listReaders(db.pool)).map((r) => `${r.orgSlug}:${r.email}`)).toEqual([
      'acme:ann@acme.example',
      'newco:nia@newco.example',
    ]);
    await expect(
      syncEntitlements(
        db.pool,
        { events: [{ type: 'reader.add', org: 'nope', email: 'x@y.example' }] },
        actor,
      ),
    ).rejects.toThrow(/no such org nope/);
  });
});
