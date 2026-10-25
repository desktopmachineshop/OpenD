import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeGitHub } from '@opend/editor';
import type { ReaderContext } from '@opend/model';
import {
  FsBlobStore,
  SECRET,
  SETTING,
  listAudit,
  listJobs,
  putSecret,
  putSetting,
  testDatabaseUrl,
  type Repo,
} from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { MARKERS } from '../../cli/test/markers.js';
import { applySeed, autoConnect } from '../src/index.js';
import {
  STARTER,
  admin,
  devLogin,
  pushPayload,
  startHarness,
  webhook,
  type Harness,
} from './helpers.js';

const url = testDatabaseUrl();

/** The OpenV case: docs in manual/, one branch per minor version, public, live picker. */
const SITE = `
site:
  releaseRefs: ['docs/*']
  releaseLines: minor
  access: public
  publicEntitlements: { products: [widget], version: latest }
  versionPicker: { mode: live }
`;
const STARTER_CONFIG = readFileSync(join(STARTER, 'opend.config.yaml'), 'utf8');
const config = (release: string, extra = SITE) =>
  `${STARTER_CONFIG.replace(/^release: .*$/m, `release: '${release}'`)}${extra}`;

const STAFF_SEED = `orgs:
  - slug: docs-team
    name: Docs team
    readers: [{ email: owner@docs.example, staff: true }]
`;

/**
 * A local git repository with the starter docs in `manual/` and branches
 * docs/0.22 and docs/0.23, and git told to fetch `cloneUrl` from it, as if
 * from GitHub.
 */
function manualRepo(cloneUrl: string): DocsRepo {
  const seed = mkdtempSync(join(tmpdir(), 'opend-manual-'));
  cpSync(STARTER, join(seed, 'manual'), { recursive: true });
  writeFileSync(join(seed, 'README.md'), '# The product\n');
  writeFileSync(join(seed, 'manual/opend.config.yaml'), config('0.22'));
  const docs = createDocsRepo(seed);
  rmSync(seed, { recursive: true, force: true });
  docs.branch('docs/0.22');
  docs.commit({ 'manual/opend.config.yaml': config('0.23') });
  docs.branch('docs/0.23');
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${docs.dir}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = cloneUrl;
  return docs;
}

const anonymous = { products: ['widget'], features: [], version: '0.23' } satisfies ReaderContext;
const TOPICS = [
  'topics/overview',
  'topics/install',
  'topics/gadget-pairing',
  'topics/configure-sso',
];

describe.skipIf(!url)('auto-connect with a stored GitHub App installation', () => {
  let h: Harness;
  let docs: DocsRepo;
  let owner = '';
  const gh = new FakeGitHub();
  const get = (path: string, cookie = '') =>
    h.app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });
  const worker = () =>
    processNext({ pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} });
  const repos = async () => (await admin(h.app, 'GET', '/repos')).json() as Repo[];
  /** Points the stored installation at `id`, as GitHub's setup URL does, and returns the redirect. */
  const install = async (id: number) => {
    const res = await get(`/admin/github/installed?installation_id=${id}`, owner);
    expect(res.statusCode).toBe(303);
    return res.headers.location;
  };

  beforeAll(async () => {
    h = await startHarness(url!, {
      githubFetch: gh.fetch,
      config: { githubWebUrl: gh.webUrl, githubApiUrl: gh.apiUrl },
    });
    docs = manualRepo(`${gh.webUrl}/acme/manual.git`);
    // Connect GitHub's result: a stored app (the fake accepts any app's JWT for an
    // installation without an app id).
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString();
    await putSetting(
      h.db.pool,
      SETTING.githubApp,
      {
        appId: '1000',
        slug: 'acme-docs',
        name: 'Acme docs',
        clientId: 'Iv1.acme-docs',
        htmlUrl: `${gh.webUrl}/apps/acme-docs`,
        owner: 'acme',
        webUrl: gh.webUrl,
        apiUrl: gh.apiUrl,
        createdAt: new Date().toISOString(),
      },
      'test',
    );
    await putSecret(h.db.pool, h.ctx.settings.secretBox!, SECRET.githubPrivateKey, pem, 'test');
    await h.ctx.reloadSettings();
    expect(h.ctx.github.mode()).toBe('stored');
    await applySeed(h.db.pool, STAFF_SEED);
    owner = await devLogin(h.app, 'owner@docs.example');

    gh.createRepo('acme/one', { 'opend.config.yaml': config('1.0', '') });
    gh.createRepo('acme/two', { 'opend.config.yaml': config('1.0', '') });
    gh.createRepo('acme/ambiguous', {
      'README.md': 'x',
      'docs/opend.config.yaml': config('1.0', ''),
      'examples/starter/opend.config.yaml': config('1.0', ''),
    });
    gh.createRepo('acme/manual', {
      'README.md': '# The product\n',
      'manual/opend.config.yaml': config('0.23'),
      'examples/starter/opend.config.yaml': config('1.0', ''),
      '.github/fixtures/opend.config.yaml': config('1.0', SITE),
      'manual/topics/overview.dita': '<topic id="overview"><title>Overview</title></topic>',
    });
    gh.addInstallation(54, 'acme', [], null);
    gh.addInstallation(55, 'acme', ['acme/one', 'acme/two'], null);
    gh.addInstallation(56, 'acme', ['acme/ambiguous'], null);
    gh.addInstallation(57, 'acme', ['acme/manual'], null);
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
    delete process.env.GIT_CONFIG_COUNT;
  });

  it('does nothing while the installation has no repository', async () => {
    expect(await install(54)).toBe('/admin/source?done=installed');
    expect(await autoConnect(h.ctx)).toEqual({ status: 'idle' });
    expect(await repos()).toEqual([]);
  });

  it('leaves two repositories to the picker, and says why on the overview', async () => {
    expect(await install(55)).toBe('/admin/source?done=installed');
    expect(await repos()).toEqual([]);
    const overview = await get('/admin', owner);
    expect(overview.body).toContain(
      'Automatic setup did not connect one: the GitHub App can access 2 repositories',
    );
    const source = await get('/admin/source', owner);
    expect(source.body).toMatch(/<option\s+value="acme\/one"/);
    expect(source.body).toMatch(/<option\s+value="acme\/two"/);
  });

  it('leaves a repository with several docs folders and no site: block to the console', async () => {
    expect(await install(56)).toBe('/admin/source?done=installed');
    expect(await repos()).toEqual([]);
    const overview = await get('/admin', owner);
    expect(overview.body).toContain('several opend.config.yaml files and none has a site: block');
    expect(overview.body).toContain('docs/opend.config.yaml, examples/starter/opend.config.yaml');
  });

  it('connects the one repository from its opend.config.yaml and queues its builds', async () => {
    expect(await install(57)).toBe('/admin?done=auto-connected');
    expect(await repos()).toEqual([
      expect.objectContaining({
        fullName: 'acme/manual',
        sourceUrl: `${gh.webUrl}/acme/manual.git`,
        installationId: 57,
        docsPath: 'manual',
        releaseRefs: ['docs/*'],
      }),
    ]);
    const jobs = await listJobs(h.db.pool);
    expect(jobs.map((j) => [j.ref, j.status]).sort()).toEqual([
      ['docs/0.22', 'queued'],
      ['docs/0.23', 'queued'],
    ]);
    const audit = await listAudit(h.db.pool, 20);
    expect(audit.filter((a) => a.actor === 'github:auto-connect').map((a) => a.action)).toEqual(
      expect.arrayContaining(['repo.upsert', 'build.request']),
    );
    const overview = await get('/admin?done=auto-connected', owner);
    expect(overview.body).toContain('GitHub connected, and the docs repository with it');
    // Already connected: nothing more happens.
    expect(await autoConnect(h.ctx)).toEqual({ status: 'idle' });
  });

  it('builds into a public site with minor lines and the live picker, filtered for the public set', async () => {
    expect(await worker()).toBe('published');
    expect(await worker()).toBe('published');
    expect((await repos())[0]).toMatchObject({
      access: 'public',
      releaseLines: 'minor',
      publicEntitlements: { products: ['widget'], version: 'latest' },
      versionPicker: { mode: 'live' },
      declared: { ref: 'docs/0.23' },
    });
    expect((await admin(h.app, 'GET', '/repos/1/releases')).json()).toEqual([
      expect.objectContaining({ releaseLine: '0.22' }),
      expect.objectContaining({ releaseLine: '0.23' }),
    ]);
    await vi.waitFor(async () => expect((await get('/topics/install.html')).statusCode).toBe(200), {
      timeout: 5000,
    });
    const html = (await Promise.all(TOPICS.map((t) => get(`/${t}.html`))))
      .map((r) => r.body)
      .join('\n');
    for (const [phrase, rule] of MARKERS)
      if (TOPICS.some((t) => readFileSync(join(STARTER, `${t}.dita`), 'utf8').includes(phrase)))
        expect({ phrase, shown: html.includes(phrase) }).toEqual({
          phrase,
          shown: rule(anonymous),
        });
    expect((await get('/topics/gadget-pairing.html')).statusCode).toBe(404);
    // The picker offers both live lines.
    const page = (await get('/topics/install.html')).body;
    expect(page).toContain('/_version?v=0.22');
    expect(page).toContain('/_version?v=0.23');
  });
});

describe.skipIf(!url)('auto-connect through the hosting provider’s broker', () => {
  let h: Harness;
  let docs: DocsRepo;
  let owner = '';
  const gh = new FakeGitHub();
  const BROKER = 'https://control.test/broker/v1';
  let exposed = ['acme/manual'];
  const brokerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.origin !== new URL(BROKER).origin) return gh.fetch(input, init);
    if (u.pathname === '/broker/v1/repos')
      return Response.json({
        repos: exposed.map((fullName) => ({
          fullName,
          private: true,
          defaultBranch: 'main',
          installationId: 4242,
        })),
      });
    if (u.pathname === '/broker/v1/token')
      return Response.json({
        token: gh.issueInstallationToken(4242),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const get = (path: string, cookie = '') =>
    h.app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });
  const repos = async () => (await admin(h.app, 'GET', '/repos')).json() as Repo[];

  beforeAll(async () => {
    h = await startHarness(url!, {
      githubFetch: brokerFetch,
      config: {
        githubWebUrl: gh.webUrl,
        githubApiUrl: gh.apiUrl,
        broker: {
          url: BROKER,
          secret: 'broker-secret-0123456789',
          apiUrl: gh.apiUrl,
          webUrl: gh.webUrl,
        },
      },
    });
    expect(h.ctx.github.mode()).toBe('broker');
    docs = manualRepo(`${gh.webUrl}/acme/manual.git`);
    gh.createRepo('acme/manual', {
      'README.md': '# The product\n',
      'manual/opend.config.yaml': config('0.23'),
    });
    gh.createRepo('acme/other', { 'opend.config.yaml': config('1.0', '') });
    await applySeed(h.db.pool, STAFF_SEED);
    owner = await devLogin(h.app, 'owner@docs.example');
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
    delete process.env.GIT_CONFIG_COUNT;
  });

  it('keeps the picker when the broker exposes two repositories', async () => {
    exposed = ['acme/manual', 'acme/other'];
    const page = await get('/admin/integrations?github=connected', owner);
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/<option\s+value="acme\/manual"/);
    expect(await repos()).toEqual([]);
  });

  it('connects on the first push from the one repository, with nobody in the console', async () => {
    exposed = ['acme/manual'];
    const res = await webhook(
      h.app,
      pushPayload('acme/manual', 'refs/heads/docs/0.23', docs.head()),
    );
    expect(res.json()).toMatchObject({ status: 'ignored', reason: 'repository not registered' });
    await vi.waitFor(async () => expect(await repos()).toHaveLength(1), { timeout: 10_000 });
    expect((await repos())[0]).toMatchObject({
      fullName: 'acme/manual',
      installationId: 4242,
      docsPath: 'manual',
      releaseRefs: ['docs/*'],
    });
    await vi.waitFor(async () => expect(await listJobs(h.db.pool)).toHaveLength(2), {
      timeout: 10_000,
    });
    // The provider's return page has nothing left to do.
    const page = await get('/admin/integrations?github=connected', owner);
    expect(page.statusCode).toBe(200);
    expect(await repos()).toHaveLength(1);
  });
});
