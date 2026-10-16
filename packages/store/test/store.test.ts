import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompiledRelease } from '@opend/model';
import {
  CHANNELS,
  FsBlobStore,
  MAX_ATTEMPTS,
  assertSafeKey,
  claimJob,
  createTestDatabase,
  enqueueJob,
  failJob,
  findReaderForLogin,
  getJob,
  getLiveReleaseId,
  getReaderAccess,
  getReleaseSnapshot,
  listen,
  listLiveReleases,
  migrate,
  publishRelease,
  recordDelivery,
  refMatches,
  setEntitlements,
  upsertOrg,
  upsertReader,
  upsertRepo,
  type TestDatabase,
} from '../src/index.js';
import { testDatabaseUrl } from '../src/testing.js';

const url = testDatabaseUrl();

const snapshot = (release: string): CompiledRelease => ({
  schemaVersion: 1,
  release,
  title: 'Docs',
  builtAt: '2026-10-16T00:00:00Z',
  attributes: {},
  nav: [],
  publications: [],
  topics: {},
  chunkUsage: {},
  assets: [],
});

describe('refMatches', () => {
  it.each([
    [['main'], 'main', true],
    [['main'], 'mainline', false],
    [['v*'], 'v1', true],
    [['v*'], 'release/v1', false],
    [['release/*', 'main'], 'release/2.0', true],
    [['v1.x'], 'v1x', false],
  ])('%j matches %s: %s', (patterns, ref, expected) => {
    expect(refMatches(patterns, ref)).toBe(expected);
  });
});

describe('FsBlobStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opend-blobs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('stores and reads blobs, and rejects unsafe keys', async () => {
    const blobs = new FsBlobStore(dir);
    await blobs.put('releases/1/images/a.svg', Buffer.from('svg'));
    expect((await blobs.get('releases/1/images/a.svg'))?.toString()).toBe('svg');
    expect(await blobs.get('releases/1/missing.png')).toBeNull();
    for (const key of ['../x', '/etc/passwd', 'a//b', 'a\\b', 'a/./b']) {
      expect(() => assertSafeKey(key)).toThrow(/unsafe/);
    }
  });
});

describe.skipIf(!url)('Postgres store', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(url!);
  });
  afterAll(() => db.drop());

  it('migrations are idempotent', async () => {
    expect(await migrate(db.pool)).toEqual([]);
  });

  it('queues, claims and retries build jobs', async () => {
    const repo = await upsertRepo(db.pool, {
      fullName: 'acme/jobs',
      sourceUrl: '/tmp/x',
      releaseRefs: ['main', 'v*'],
    });
    const job = await enqueueJob(db.pool, { repoId: repo.id, ref: 'main', sha: 'abc' });
    const claimed = await claimJob(db.pool);
    expect(claimed).toMatchObject({ id: job.id, status: 'running', attempts: 1 });
    expect(await claimJob(db.pool)).toBeNull(); // nothing else runnable

    expect(await failJob(db.pool, claimed!, { error: 'network', retryable: true })).toBe('queued');
    expect(await claimJob(db.pool)).toBeNull(); // backoff not elapsed
    await db.pool.query('update build_jobs set run_after = now() where id = $1', [job.id]);
    const again = await claimJob(db.pool);
    expect(again?.attempts).toBe(2);

    expect(
      await failJob(
        db.pool,
        { id: job.id, attempts: MAX_ATTEMPTS },
        { error: 'x', retryable: true },
      ),
    ).toBe('failed');
    expect(
      await failJob(db.pool, again!, { error: 'broken links', retryable: false, diagnostics: [] }),
    ).toBe('failed');
    expect((await getJob(db.pool, job.id))?.status).toBe('failed');
  });

  it('lets concurrent workers claim distinct jobs', async () => {
    const repo = await upsertRepo(db.pool, { fullName: 'acme/concurrent', sourceUrl: '/tmp/y' });
    await Promise.all(
      [1, 2, 3].map((n) => enqueueJob(db.pool, { repoId: repo.id, ref: 'main', sha: `s${n}` })),
    );
    const claimed = await Promise.all([1, 2, 3, 4].map(() => claimJob(db.pool)));
    const ids = claimed.filter(Boolean).map((j) => j!.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('swaps live releases only for newer jobs, per release line', async () => {
    const repo = await upsertRepo(db.pool, { fullName: 'acme/releases', sourceUrl: '/tmp/z' });
    const older = await enqueueJob(db.pool, { repoId: repo.id, ref: 'main', sha: 'old' });
    const newer = await enqueueJob(db.pool, { repoId: repo.id, ref: 'main', sha: 'new' });
    const v1 = await enqueueJob(db.pool, { repoId: repo.id, ref: 'v1', sha: 'one' });

    const base = { repoId: repo.id, ref: 'main', diagnostics: [] };
    const n = await publishRelease(db.pool, {
      ...base,
      jobId: newer.id,
      sha: 'new',
      releaseLine: '2',
      snapshot: snapshot('2.1'),
    });
    expect(n.live).toBe(true);
    // The older push finishes later: stored, but must not replace the newer live release.
    const o = await publishRelease(db.pool, {
      ...base,
      jobId: older.id,
      sha: 'old',
      releaseLine: '2',
      snapshot: snapshot('2.0'),
    });
    expect(o.live).toBe(false);
    expect(await getLiveReleaseId(db.pool, repo.id, '2')).toBe(n.releaseId);

    await publishRelease(db.pool, {
      ...base,
      ref: 'v1',
      jobId: v1.id,
      sha: 'one',
      releaseLine: '1',
      snapshot: snapshot('1.4'),
    });
    expect(
      (await listLiveReleases(db.pool, repo.id)).map((l) => [l.releaseLine, l.release]),
    ).toEqual([
      ['1', '1.4'],
      ['2', '2.1'],
    ]);
    expect((await getReleaseSnapshot(db.pool, n.releaseId))?.release).toBe('2.1');
    expect((await getJob(db.pool, newer.id))?.status).toBe('succeeded');
  });

  it('records webhook deliveries once', async () => {
    expect(await recordDelivery(db.pool, 'd-1', 'push')).toBe(true);
    expect(await recordDelivery(db.pool, 'd-1', 'push')).toBe(false);
  });

  it('resolves readers and their entitlements', async () => {
    await upsertOrg(db.pool, { slug: 'acme', name: 'Acme' });
    const reader = await upsertReader(db.pool, { orgSlug: 'acme', email: 'Ann@Acme.example' });
    expect(reader).not.toBeNull();
    expect(await upsertReader(db.pool, { orgSlug: 'nope', email: 'x@y.z' })).toBeNull();

    // No entitlements yet: the reader exists but sees nothing.
    expect((await getReaderAccess(db.pool, reader!.id))?.context).toBeNull();
    expect(
      await setEntitlements(db.pool, 'acme', {
        products: ['widget'],
        features: [],
        version: '1.4',
      }),
    ).toBe(true);
    expect(
      await setEntitlements(db.pool, 'nope', { products: [], features: [], version: '1' }),
    ).toBe(false);
    expect((await getReaderAccess(db.pool, reader!.id))?.context).toEqual({
      org: 'acme',
      products: ['widget'],
      features: [],
      version: '1.4',
    });
  });

  it('links an OIDC subject to a verified, registered email only', async () => {
    await upsertOrg(db.pool, { slug: 'globex', name: 'Globex' });
    const bob = await upsertReader(db.pool, { orgSlug: 'globex', email: 'bob@globex.example' });
    const iss = 'https://idp.example';
    expect(
      await findReaderForLogin(db.pool, {
        issuer: iss,
        subject: 's1',
        email: 'bob@globex.example',
        emailVerified: false,
      }),
    ).toBeNull();
    expect(
      await findReaderForLogin(db.pool, {
        issuer: iss,
        subject: 's1',
        email: 'nobody@globex.example',
        emailVerified: true,
      }),
    ).toBeNull();
    const linked = await findReaderForLogin(db.pool, {
      issuer: iss,
      subject: 's1',
      email: 'BOB@globex.example',
      emailVerified: true,
    });
    expect(linked?.id).toBe(bob!.id);
    // Later logins match on the subject, even without an email claim.
    expect((await findReaderForLogin(db.pool, { issuer: iss, subject: 's1' }))?.id).toBe(bob!.id);
    // A different subject cannot take over an already linked email.
    expect(
      await findReaderForLogin(db.pool, {
        issuer: iss,
        subject: 's2',
        email: 'bob@globex.example',
        emailVerified: true,
      }),
    ).toBeNull();
  });

  it('delivers notifications to listeners', async () => {
    const got: string[] = [];
    const listener = listen(db.url, [CHANNELS.releaseChanged], (channel, payload) =>
      got.push(`${channel}:${payload}`),
    );
    await listener.ready;
    await db.pool.query('select pg_notify($1, $2)', [CHANNELS.releaseChanged, '42']);
    await expect.poll(() => got).toEqual([`${CHANNELS.releaseChanged}:42`]);
    await listener.stop();
  });
});
