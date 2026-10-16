import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importSPKI, jwtVerify } from 'jose';
import { SEARCH_INDEX_FORMAT } from '@opend/filter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FsBlobStore,
  assetKey,
  createTestDatabase,
  enqueueJob,
  getJob,
  getLiveReleaseId,
  getReleaseSnapshot,
  getSearchIndex,
  listLiveReleases,
  testDatabaseUrl,
  upsertRepo,
  type TestDatabase,
} from '@opend/store';
import {
  GitHubApp,
  createDocsRepo,
  fetchSource,
  processNext,
  reindexRelease,
  summarize,
  type DocsRepo,
  type StatusReporter,
} from '../src/index.js';

const STARTER = join(import.meta.dirname, '../../../templates/docs-starter');
const url = testDatabaseUrl();

describe('GitHubApp', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  it('mints a signed app JWT, caches installation tokens and posts statuses', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (String(input).endsWith('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'inst-token',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
          { status: 201 },
        );
      }
      return new Response('{}', { status: 201 });
    }) as typeof fetch;
    const app = new GitHubApp(
      { appId: '123', privateKey, apiUrl: 'https://ghe.example/api/v3/' },
      fakeFetch,
    );

    expect(await app.installationToken(9)).toBe('inst-token');
    expect(await app.installationToken(9)).toBe('inst-token');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ghe.example/api/v3/app/installations/9/access_tokens');
    const jwt = String((calls[0]!.init.headers as Record<string, string>).authorization).replace(
      'Bearer ',
      '',
    );
    const { payload } = await jwtVerify(jwt, await importSPKI(publicKey, 'RS256'));
    expect(payload.iss).toBe('123');
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600);

    await app.report(
      { fullName: 'acme/docs', installationId: 9 },
      'abc123',
      'failure',
      'x'.repeat(200),
    );
    const status = calls[1]!;
    expect(status.url).toBe('https://ghe.example/api/v3/repos/acme/docs/statuses/abc123');
    const body = JSON.parse(String(status.init.body));
    expect(body).toMatchObject({ state: 'failure', context: 'opend/build' });
    expect(body.description).toHaveLength(140);

    await app.report({ fullName: 'local/docs', installationId: null }, 'abc123', 'success', 'ok');
    expect(calls).toHaveLength(2); // nothing to report for sources without an installation
  });
});

describe('fetchSource', () => {
  let repo: DocsRepo;
  beforeAll(() => {
    repo = createDocsRepo(STARTER);
  });
  afterAll(() => repo.remove());

  it('checks out exactly the requested commit', async () => {
    const first = repo.head();
    repo.commit({ 'later.txt': 'later' });
    const src = await fetchSource(repo.dir, first);
    try {
      expect(() => readFileSync(join(src.dir, 'later.txt'))).toThrow();
      expect(readFileSync(join(src.dir, 'opend.config.yaml'), 'utf8')).toContain('release:');
    } finally {
      await src.cleanup();
    }
  });

  it('rejects non-sha input and reports missing commits without leaking tokens', async () => {
    await expect(fetchSource(repo.dir, '--upload-pack=evil')).rejects.toThrow(/not a commit sha/);
    // The reason is git's first "fatal:" line, not a trailing hint.
    await expect(fetchSource(repo.dir, 'deadbeef'.repeat(5), 'secret-token')).rejects.toThrow(
      /^fetching \w+ failed: fatal: /,
    );
    await expect(fetchSource(repo.dir, 'deadbeef'.repeat(5), 'secret-token')).rejects.not.toThrow(
      /secret-token/,
    );
  });
});

describe('fetchSource option injection', () => {
  it('never treats a source URL as a git option', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opend-inject-'));
    const marker = join(dir, 'pwned');
    try {
      await expect(
        fetchSource(`--upload-pack=touch ${marker};`, 'deadbeef'.repeat(5)),
      ).rejects.toThrow(/^fetching \w+ failed/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('summarize', () => {
  it('lists the first errors', () => {
    expect(
      summarize([
        { severity: 'warning', code: 'w', message: '' },
        { severity: 'error', code: 'broken-link', message: '', file: 'a.dita', line: 2 },
        { severity: 'error', code: 'missing-conref', message: '', file: 'b.dita', line: 9 },
        { severity: 'error', code: 'x', message: '' },
      ]),
    ).toBe('3 errors: a.dita:2 broken-link; b.dita:9 missing-conref');
  });
});

describe.skipIf(!url)('runJob', () => {
  let db: TestDatabase;
  let docs: DocsRepo;
  let blobDir: string;
  const reported: string[] = [];
  const reporter: StatusReporter = {
    report: async (_repo, sha, state, description) =>
      void reported.push(`${sha.slice(0, 7)} ${state} ${description}`),
  };
  const deps = () => ({ pool: db.pool, blobs: new FsBlobStore(blobDir), reporter, log: () => {} });

  beforeAll(async () => {
    db = await createTestDatabase(url!);
    docs = createDocsRepo(STARTER);
    blobDir = mkdtempSync(join(tmpdir(), 'opend-worker-blobs-'));
  });
  afterAll(async () => {
    await db.drop();
    docs.remove();
    rmSync(blobDir, { recursive: true, force: true });
  });

  it('publishes a passing build with its assets', async () => {
    const repo = await upsertRepo(db.pool, { fullName: 'acme/docs', sourceUrl: docs.dir });
    const sha = docs.head();
    const job = await enqueueJob(db.pool, { repoId: repo.id, ref: 'main', sha });
    expect(await processNext(deps())).toBe('published');

    const releaseId = await getLiveReleaseId(db.pool, repo.id, '2');
    expect(releaseId).not.toBeNull();
    const snapshot = await getReleaseSnapshot(db.pool, releaseId!);
    expect(Object.keys(snapshot!.topics)).toHaveLength(8);
    expect((await getJob(db.pool, job.id))?.status).toBe('succeeded');
    // Indexed for search in the publish transaction, and rebuildable later.
    const topicRows = async () =>
      (
        await db.pool.query<{ n: number }>(
          'select count(*)::int as n from search_topics where release_id = $1',
          [releaseId],
        )
      ).rows[0]!.n;
    expect((await getSearchIndex(db.pool, releaseId!))?.format).toBe(SEARCH_INDEX_FORMAT);
    expect(await topicRows()).toBe(8);
    await db.pool.query('delete from search_indexes');
    expect(await reindexRelease(db.pool, releaseId!)).toMatchObject({ releaseId, topics: 8 });
    expect(await topicRows()).toBe(8);
    expect(await reindexRelease(db.pool, releaseId! + 1000)).toBeNull();
    const blobs = new FsBlobStore(blobDir);
    expect((await blobs.get(assetKey(repo.id, sha, 'images/logo.svg')))?.toString()).toContain(
      '<svg',
    );
    expect((await blobs.get(assetKey(repo.id, sha, 'theme/site.css')))?.toString()).toContain(
      '--opend-accent',
    );
    expect(reported).toEqual([
      `${sha.slice(0, 7)} pending Building docs`,
      `${sha.slice(0, 7)} success Published 2.1`,
    ]);
  });

  it('fails a broken push and keeps the previous release live', async () => {
    const repo = await upsertRepo(db.pool, { fullName: 'acme/docs', sourceUrl: docs.dir });
    const before = await getLiveReleaseId(db.pool, repo.id, '2');
    const install = readFileSync(join(docs.dir, 'topics/install.dita'), 'utf8');
    const sha = docs.commit({
      'topics/install.dita': install.replace(
        '<xref href="configure.dita"/>',
        '<xref href="gone.dita"/>',
      ),
    });
    const job = await enqueueJob(db.pool, { repoId: repo.id, ref: 'main', sha });
    reported.length = 0;
    expect(await processNext(deps())).toBe('failed');

    const failed = await getJob(db.pool, job.id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: '1 error: topics/install.dita:31 broken-link',
    });
    expect(failed!.diagnostics[0]).toMatchObject({
      code: 'broken-link',
      file: 'topics/install.dita',
    });
    expect(await getLiveReleaseId(db.pool, repo.id, '2')).toBe(before);
    expect(reported[1]).toBe(
      `${sha.slice(0, 7)} failure 1 error: topics/install.dita:31 broken-link`,
    );
  });

  it('keeps release lines apart: a v1 branch goes live beside v2', async () => {
    const repo = await upsertRepo(db.pool, {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['main', 'v*'],
    });
    const config = readFileSync(join(docs.dir, 'opend.config.yaml'), 'utf8');
    const sha = docs.commit({
      'opend.config.yaml': config.replace(/^release: .*$/m, 'release: "1.4"'),
      'topics/install.dita': readFileSync(join(STARTER, 'topics/install.dita'), 'utf8'),
    });
    await enqueueJob(db.pool, { repoId: repo.id, ref: 'v1', sha });
    expect(await processNext(deps())).toBe('published');
    expect(
      (await listLiveReleases(db.pool, repo.id)).map((l) => [l.releaseLine, l.release]),
    ).toEqual([
      ['1', '1.4'],
      ['2', '2.1'],
    ]);
  });

  it('retries when the source cannot be fetched', async () => {
    const repo = await upsertRepo(db.pool, {
      fullName: 'acme/missing',
      sourceUrl: join(tmpdir(), 'no-such-repo'),
    });
    const job = await enqueueJob(db.pool, { repoId: repo.id, ref: 'main', sha: 'a'.repeat(40) });
    expect(await processNext(deps())).toBe('retrying');
    expect(await getJob(db.pool, job.id)).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('returns null when the queue is empty', async () => {
    await db.pool.query("update build_jobs set status = 'failed' where status = 'queued'");
    expect(await processNext(deps())).toBeNull();
  });
});
