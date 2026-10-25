import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, testDatabaseUrl, upsertRepo, type TestDatabase } from '@opend/store';
import {
  BrokerError,
  GitHubBroker,
  GitHubConnection,
  pollOnce,
  type BrokerRepo,
} from '../src/index.js';

const BROKER = 'https://control.test/broker/v1';
const SECRET = 'instance-secret-0123456789';

/** A fake control-plane broker implementing the contract in docs/managed-github.md. */
function fakeBroker(options: { repos?: BrokerRepo[]; ttlMs?: number } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let issued = 0;
  const repos = options.repos ?? [
    { fullName: 'acme/docs', private: true, defaultBranch: 'main', installationId: 77 },
  ];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, path: url.pathname, body });
    const auth = new Headers(init?.headers).get('authorization');
    if (url.origin === 'https://api.github.com') return new Response('{}', { status: 201 });
    if (auth !== `Bearer ${SECRET}`)
      return new Response('{"error":"unauthorized"}', { status: 401 });
    if (url.pathname === '/broker/v1/repos' && method === 'GET') return Response.json({ repos });
    if (url.pathname === '/broker/v1/token' && method === 'POST') {
      const { repo, permissions } = body as { repo: string; permissions: string };
      if (!repos.some((r) => r.fullName === repo)) return new Response('{}', { status: 404 });
      issued++;
      return Response.json({
        token: `ghs_${permissions}_${issued}`,
        expiresAt: new Date(Date.now() + (options.ttlMs ?? 3600_000)).toISOString(),
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

describe('GitHubBroker', () => {
  it('fetches tokens with the instance secret and caches them per repo and permission', async () => {
    const fake = fakeBroker();
    const broker = new GitHubBroker({ url: `${BROKER}/`, secret: SECRET }, fake.fetch);
    expect(await broker.token('acme/docs', 'read')).toBe('ghs_read_1');
    expect(await broker.token('acme/docs', 'read')).toBe('ghs_read_1');
    expect(await broker.token('Acme/Docs', 'read')).toBe('ghs_read_1');
    expect(await broker.token('acme/docs', 'write')).toBe('ghs_write_2');
    expect(fake.calls).toEqual([
      {
        method: 'POST',
        path: '/broker/v1/token',
        body: { repo: 'acme/docs', permissions: 'read' },
      },
      {
        method: 'POST',
        path: '/broker/v1/token',
        body: { repo: 'acme/docs', permissions: 'write' },
      },
    ]);
  });

  it('shares one request between concurrent callers', async () => {
    const fake = fakeBroker();
    const broker = new GitHubBroker({ url: BROKER, secret: SECRET }, fake.fetch);
    const tokens = await Promise.all([1, 2, 3].map(() => broker.token('acme/docs', 'read')));
    expect(new Set(tokens).size).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });

  it('asks again for a token within 60 seconds of its expiry', async () => {
    const fake = fakeBroker({ ttlMs: 59_000 });
    const broker = new GitHubBroker({ url: BROKER, secret: SECRET }, fake.fetch);
    expect(await broker.token('acme/docs', 'read')).toBe('ghs_read_1');
    expect(await broker.token('acme/docs', 'read')).toBe('ghs_read_2');
  });

  it('reports a repository outside the installation (404) and a bad secret (401)', async () => {
    const fake = fakeBroker();
    const broker = new GitHubBroker({ url: BROKER, secret: SECRET }, fake.fetch);
    const missing = await broker.token('acme/other', 'read').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(BrokerError);
    expect((missing as BrokerError).status).toBe(404);
    expect((missing as Error).message).toMatch(/not in this site's GitHub installation/);
    const wrong = new GitHubBroker({ url: BROKER, secret: 'wrong-secret-000000' }, fake.fetch);
    const refused = await wrong.token('acme/docs', 'read').catch((e: unknown) => e);
    expect((refused as BrokerError).status).toBe(401);
    expect((refused as Error).message).not.toContain('wrong-secret');
    await expect(wrong.repos()).rejects.toMatchObject({ status: 401 });
  });

  it('lists the installation repositories', async () => {
    const broker = new GitHubBroker({ url: BROKER, secret: SECRET }, fakeBroker().fetch);
    expect(await broker.repos()).toEqual([
      { fullName: 'acme/docs', private: true, defaultBranch: 'main', installationId: 77 },
    ]);
  });

  it('sends tokens only for sources on a GitHub host, whatever the installation id', async () => {
    const fake = fakeBroker();
    const broker = new GitHubBroker({ url: BROKER, secret: SECRET }, fake.fetch);
    expect(broker.gitHosts).toEqual(['github.com']);
    const repo = { fullName: 'acme/docs', installationId: null };
    expect(
      await broker.repoToken({ ...repo, sourceUrl: 'https://github.com/acme/docs.git' }, 'read'),
    ).toMatch(/^ghs_read/);
    expect(
      await broker.repoToken({ ...repo, sourceUrl: 'https://evil.example/acme/docs.git' }, 'read'),
    ).toBeUndefined();
    expect(
      new GitHubBroker({ url: BROKER, secret: SECRET, webUrl: 'https://ghe.example' }, fake.fetch)
        .gitHosts,
    ).toEqual(['ghe.example']);
  });

  it('posts no commit statuses (broker tokens have no statuses permission), saying so once', async () => {
    const fake = fakeBroker();
    const logs: unknown[] = [];
    const broker = new GitHubBroker({ url: BROKER, secret: SECRET }, fake.fetch, (e) =>
      logs.push(e),
    );
    const repo = {
      fullName: 'acme/docs',
      installationId: null,
      sourceUrl: 'https://github.com/acme/docs',
    };
    await broker.report(repo, 'a'.repeat(40), 'success', 'Published 1.0');
    await broker.report(repo, 'b'.repeat(40), 'failure', 'Broken');
    expect(fake.calls).toEqual([]);
    expect(logs).toHaveLength(1);
  });
});

describe('GitHubConnection', () => {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();

  it('prefers the environment app, then the broker, then the stored app', () => {
    let stored: { appId: string; privateKey: string } | null = null;
    const broker = { url: BROKER, secret: SECRET };
    expect(new GitHubConnection({ app: { appId: '1', privateKey }, broker }).mode()).toBe('env');
    expect(
      new GitHubConnection({ broker, stored: () => ({ appId: '2', privateKey }) }).mode(),
    ).toBe('broker');
    const connection = new GitHubConnection({ stored: () => stored });
    expect(connection.mode()).toBe('none');
    expect(connection.app()).toBeNull();
    stored = { appId: '3', privateKey };
    expect(connection.mode()).toBe('stored');
    expect(connection.app()?.appId).toBe('3');
    // A broken stored key reads as "not connected" instead of failing every build.
    stored = { appId: '4', privateKey: 'not a key' };
    expect(connection.mode()).toBe('none');
  });

  it('mints no token and refuses API calls when nothing is connected', async () => {
    const connection = new GitHubConnection();
    const repo = { fullName: 'acme/docs', installationId: 1 };
    expect(await connection.repoToken(repo, 'read')).toBeUndefined();
    await expect(connection.request(repo, 'GET', '/repos/acme/docs')).rejects.toThrow(
      /not connected/,
    );
    expect(connection.gitHosts).toEqual(['github.com']);
  });
});

const url = testDatabaseUrl();

describe.skipIf(!url)('polling in broker mode', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(url!);
  });
  afterAll(async () => db?.drop());

  it('asks the broker for read tokens by repository name', async () => {
    await upsertRepo(db.pool, {
      fullName: 'acme/docs',
      sourceUrl: 'https://github.com/acme/docs.git',
    });
    const fake = fakeBroker();
    const github = new GitHubConnection({
      broker: { url: BROKER, secret: SECRET },
      fetch: fake.fetch,
    });
    const seen: (string | undefined)[] = [];
    const summary = await pollOnce({
      pool: db.pool,
      github,
      log: () => {},
      listRefs: async (_source, token, hosts) => {
        seen.push(token);
        expect(hosts).toEqual(['github.com']);
        return [{ ref: 'main', sha: 'd'.repeat(40), kind: 'branch' }];
      },
    });
    expect(seen).toEqual(['ghs_read_1']);
    expect(summary.queued).toHaveLength(1);
    expect(fake.calls[0]!.body).toEqual({ repo: 'acme/docs', permissions: 'read' });
  });
});
