import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FsBlobStore,
  createTestDatabase,
  getLiveReleaseId,
  listJobs,
  listPolledRefs,
  testDatabaseUrl,
  upsertRepo,
  type TestDatabase,
} from '@opend/store';
import {
  createDocsRepo,
  listRemoteRefs,
  pollOnce,
  processNext,
  releaseRefsToPoll,
  startPoller,
  type DocsRepo,
  type GitHubAccess,
  type RemoteRef,
} from '../src/index.js';

const STARTER = join(import.meta.dirname, '../../../templates/docs-starter');
const url = testDatabaseUrl();
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();

describe('releaseRefsToPoll', () => {
  const ref = (name: string, kind: RemoteRef['kind'] = 'branch'): RemoteRef => ({
    ref: name,
    sha: name.padEnd(40, '0').slice(0, 40),
    kind,
  });

  it('keeps matching refs, tags first in version order, branches last', () => {
    const refs = [
      ref('main'),
      ref('feature/x'),
      ref('v10.0', 'tag'),
      ref('v2.0', 'tag'),
      ref('v1', 'branch'),
      ref('v1', 'tag'),
    ];
    expect(releaseRefsToPoll(refs, ['main', 'v*']).map((r) => `${r.kind}:${r.ref}`)).toEqual([
      'tag:v2.0',
      'tag:v10.0',
      'branch:main',
      'branch:v1',
    ]);
  });
});

describe('listRemoteRefs', () => {
  let docs: DocsRepo;
  let bare: string;
  beforeAll(() => {
    docs = createDocsRepo(STARTER);
    docs.commit({ 'later.txt': 'x' });
    git(docs.dir, 'tag', '-a', 'v2.1', '-m', 'annotated', 'HEAD~1');
    git(docs.dir, 'tag', 'light', 'HEAD');
    docs.branch('v1');
    bare = mkdtempSync(join(tmpdir(), 'opend-bare-'));
    git(bare, 'clone', '-q', '--bare', docs.dir, '.');
  });
  afterAll(() => {
    docs.remove();
    rmSync(bare, { recursive: true, force: true });
  });

  it('lists branches and tags of a bare repository, peeling annotated tags', async () => {
    const refs = await listRemoteRefs(bare);
    const head = docs.head();
    const parent = git(docs.dir, 'rev-parse', 'HEAD~1');
    expect(refs.sort((a, b) => a.ref.localeCompare(b.ref))).toEqual([
      { ref: 'light', sha: head, kind: 'tag' },
      { ref: 'main', sha: head, kind: 'branch' },
      { ref: 'v1', sha: head, kind: 'branch' },
      { ref: 'v2.1', sha: parent, kind: 'tag' },
    ]);
  });

  it('never treats a source URL as a git option', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opend-inject-'));
    const marker = join(dir, 'pwned');
    try {
      await listRemoteRefs(`--upload-pack=touch ${marker};`).catch(() => []);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports failures without leaking the token', async () => {
    const missing = join(tmpdir(), 'opend-no-such-remote');
    await expect(listRemoteRefs(missing, 'secret-token')).rejects.toThrow(/^listing refs failed/);
    await expect(listRemoteRefs(missing, 'secret-token')).rejects.not.toThrow(/secret-token/);
  });
});

describe.skipIf(!url)('pollOnce', () => {
  let db: TestDatabase;
  let docs: DocsRepo;
  let bare: string;
  let blobDir: string;
  const quiet = { log: () => {} };

  beforeAll(async () => {
    db = await createTestDatabase(url!);
    docs = createDocsRepo(STARTER);
    bare = mkdtempSync(join(tmpdir(), 'opend-bare-'));
    git(bare, 'clone', '-q', '--bare', docs.dir, '.');
    blobDir = mkdtempSync(join(tmpdir(), 'opend-poll-blobs-'));
  });
  afterAll(async () => {
    await db?.drop();
    docs?.remove();
    rmSync(bare, { recursive: true, force: true });
    rmSync(blobDir, { recursive: true, force: true });
  });

  it('queues a build for a new head, publishes it, and does not queue it again', async () => {
    const repo = await upsertRepo(db.pool, {
      fullName: 'acme/docs',
      sourceUrl: bare,
      releaseRefs: ['main', 'v*'],
    });
    git(bare, 'branch', 'feature', 'main'); // not a release ref
    const first = await pollOnce({ pool: db.pool, ...quiet });
    expect(first.errors).toEqual([]);
    expect(first.queued.map((j) => [j.ref, j.sha])).toEqual([['main', docs.head()]]);

    // Several workers polling at once queue nothing more.
    const again = await Promise.all([1, 2, 3].map(() => pollOnce({ pool: db.pool, ...quiet })));
    expect(again.flatMap((s) => s.queued)).toEqual([]);

    expect(await processNext({ pool: db.pool, blobs: new FsBlobStore(blobDir), ...quiet })).toBe(
      'published',
    );
    expect(await getLiveReleaseId(db.pool, repo.id, '2')).not.toBeNull();
  });

  it('queues a build when a release ref moves or appears', async () => {
    const sha = docs.commit({ 'notes.txt': 'new' });
    git(bare, 'fetch', '-q', docs.dir, 'main:main');
    git(bare, 'tag', 'v2.2', sha);
    const summary = await pollOnce({ pool: db.pool, ...quiet });
    expect(summary.queued.map((j) => [j.ref, j.sha])).toEqual([
      ['v2.2', sha],
      ['main', sha],
    ]);
    const repoId = summary.queued[0]!.repoId;
    expect((await listPolledRefs(db.pool, repoId)).map((r) => r.ref)).toEqual(['main', 'v2.2']);

    git(bare, 'tag', '-d', 'v2.2');
    await pollOnce({ pool: db.pool, ...quiet });
    expect((await listPolledRefs(db.pool, repoId)).map((r) => r.ref)).toEqual(['main']);
  });

  it('uses the installation token and carries on past a failing repo', async () => {
    await upsertRepo(db.pool, {
      fullName: 'acme/private',
      sourceUrl: 'https://github.example/acme/private.git',
      installationId: 42,
    });
    await upsertRepo(db.pool, {
      fullName: 'acme/broken',
      sourceUrl: join(tmpdir(), 'opend-no-such-remote'),
    });
    const tokens: (string | undefined)[] = [];
    const github = {
      repoToken: async (repo: { installationId: number | null }) =>
        repo.installationId === null ? undefined : `token-${repo.installationId}`,
    } as unknown as GitHubAccess;
    const before = (await listJobs(db.pool)).length;
    const summary = await pollOnce({
      pool: db.pool,
      github,
      ...quiet,
      listRefs: async (source, token) => {
        if (source.startsWith('https://github.example/')) {
          tokens.push(token);
          return [{ ref: 'main', sha: 'c'.repeat(40), kind: 'branch' }];
        }
        return listRemoteRefs(source, token);
      },
    });
    expect(tokens).toEqual(['token-42']);
    expect(summary.queued.map((j) => j.sha)).toEqual(['c'.repeat(40)]);
    expect(summary.errors).toEqual([
      { repo: 'acme/broken', error: expect.stringMatching(/^listing refs failed/) },
    ]);
    expect((await listJobs(db.pool)).length).toBe(before + 1);
  });

  it('runs beforePoll first, so a repository it registers is polled at once', async () => {
    const order: string[] = [];
    const summary = await pollOnce({
      pool: db.pool,
      ...quiet,
      beforePoll: async () => {
        order.push('before');
        await upsertRepo(db.pool, { fullName: 'acme/auto', sourceUrl: bare });
      },
      listRefs: async (source) => {
        order.push(source === bare ? 'poll' : 'other');
        return source === bare ? [{ ref: 'main', sha: 'd'.repeat(40), kind: 'branch' }] : [];
      },
    });
    expect(order[0]).toBe('before');
    expect(summary.queued.map((j) => j.sha)).toContain('d'.repeat(40));
    // A failing hook is logged and polling goes on.
    const failing = await pollOnce({
      pool: db.pool,
      ...quiet,
      beforePoll: async () => {
        throw new Error('broker down');
      },
      listRefs: async () => [],
    });
    expect(failing.repos).toBeGreaterThan(0);
  });

  it('polls on an interval until stopped', async () => {
    let calls = 0;
    const poller = startPoller({
      pool: db.pool,
      intervalMs: 10,
      ...quiet,
      listRefs: async () => {
        calls++;
        return [];
      },
    });
    await expect.poll(() => calls, { timeout: 2000 }).toBeGreaterThanOrEqual(6);
    await poller.stop();
    const stoppedAt = calls;
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(stoppedAt);
  });
});
