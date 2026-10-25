import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReaderContext } from '@opend/model';
import { FsBlobStore, listAudit, testDatabaseUrl, type Repo } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { MARKERS } from '../../cli/test/markers.js';
import { applySeed } from '../src/index.js';
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

const TOPICS = [
  'topics/overview',
  'topics/install',
  'topics/configure',
  'topics/gadget-pairing',
  'topics/configure-sso',
  'topics/audit-log',
  'topics/release-notes-1',
  'topics/release-notes-2',
];

/** What anonymous visitors hold once the repository makes the site public. */
const PUBLIC: ReaderContext = { products: ['widget'], features: [], version: '2.1' };

const SITE = `
site:
  releaseRefs: [main, 'v*', 'docs/*']
  releaseLines: minor
  access: public
  publicEntitlements: { products: [widget], version: latest }
  versionPicker: { mode: live }
`;

describe.skipIf(!url)('site settings declared in opend.config.yaml', () => {
  let h: Harness;
  let docs: DocsRepo;
  let base = '';
  let owner = '';
  const worker = () =>
    processNext({ pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} });
  const get = (path: string, cookie = '') =>
    h.app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });
  const post = (path: string, form: Record<string, string>, cookie: string) =>
    h.app.inject({
      method: 'POST',
      url: path,
      payload: new URLSearchParams(form).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    });
  const csrfOf = (res: LightMyRequestResponse) =>
    /name="_csrf" value="([^"]+)"/.exec(res.body)?.[1] ?? '';
  const repo = async () => ((await admin(h.app, 'GET', '/repos')).json() as Repo[])[0]!;
  const pages = async () =>
    (await Promise.all(TOPICS.map((t) => get(`/${t}.html`)))).map((p) => p.body).join('\n');
  /** Commits a config (the starter's, with `extra` appended) and builds it as `ref`. */
  const publish = async (ref: string, extra: string, release = '2.1') => {
    const sha = docs.commit({
      'opend.config.yaml': `${base.replace(/^release: .*$/m, `release: '${release}'`)}${extra}`,
    });
    expect(
      (await webhook(h.app, pushPayload('acme/docs', `refs/heads/${ref}`, sha))).json(),
    ).toMatchObject({
      status: 'queued',
    });
    expect(await worker()).toBe('published');
    return sha;
  };
  const anonymousIsPrivate = async () => {
    const res = await get('/topics/install.html');
    return res.statusCode === 302 && String(res.headers.location).startsWith('/auth/login');
  };

  beforeAll(async () => {
    h = await startHarness(url!);
    docs = createDocsRepo(STARTER);
    base = readFileSync(join(STARTER, 'opend.config.yaml'), 'utf8');
    await applySeed(
      h.db.pool,
      `orgs:
  - slug: docs-team
    name: Docs team
    readers: [{ email: owner@docs.example, staff: true }]
`,
    );
    const res = await admin(h.app, 'POST', '/repos', {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['main', 'v*'],
    });
    expect(res.statusCode).toBe(201);
    owner = await devLogin(h.app, 'owner@docs.example');
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('stays private while no build declares otherwise', async () => {
    expect(await anonymousIsPrivate()).toBe(true);
    expect((await get('/')).statusCode).toBe(302);
  });

  it('applies the site: block of the build live on the newest line, as repo:opend.config.yaml', async () => {
    const sha = await publish('main', SITE);
    expect(await repo()).toMatchObject({
      access: 'public',
      publicEntitlements: { products: ['widget'], features: [], version: 'latest' },
      versionPicker: { mode: 'live' },
      releaseLines: 'minor',
      releaseRefs: ['main', 'v*', 'docs/*'],
      declared: {
        settings: { access: 'public', versionPicker: { mode: 'live' } },
        ref: 'main',
        sha,
        release: '2.1',
      },
    });
    const entries = (await listAudit(h.db.pool, 50)).filter(
      (a) => a.actor === 'repo:opend.config.yaml',
    );
    expect(entries.map((a) => a.action).sort()).toEqual([
      'repo.access',
      'repo.release-lines',
      'repo.release-refs',
      'repo.versions',
    ]);
    // The live release moved to its minor line.
    expect((await admin(h.app, 'GET', '/repos/1/releases')).json()).toEqual([
      expect.objectContaining({ releaseLine: '2.1', release: '2.1' }),
    ]);
  });

  it('serves anonymous visitors exactly the public set, and nothing gated beyond it', async () => {
    // The worker's NOTIFY drops this replica's cached "private" repo.
    await vi.waitFor(async () => expect(await anonymousIsPrivate()).toBe(false), {
      timeout: 5000,
    });
    const html = await pages();
    for (const [phrase, rule] of MARKERS)
      expect({ phrase, shown: html.includes(phrase) }).toEqual({ phrase, shown: rule(PUBLIC) });
    expect((await get('/topics/gadget-pairing.html')).statusCode).toBe(404);
    expect((await get('/topics/configure-sso.html')).statusCode).toBe(404);
    expect((await get('/search?q=gadget')).body).not.toContain('Pair a Gadget');
    // The live picker offers the live line.
    expect((await get('/topics/install.html')).body).toContain('2.1');
  });

  it('ignores the site: block of a build on an older line', async () => {
    await publish('v1', SITE.replace('access: public', 'access: private'), '1.4');
    expect((await admin(h.app, 'GET', '/repos/1/releases')).json()).toEqual([
      expect.objectContaining({ releaseLine: '1.4' }),
      expect.objectContaining({ releaseLine: '2.1' }),
    ]);
    expect(await repo()).toMatchObject({ access: 'public', declared: { ref: 'main' } });
  });

  it('shows repository-declared settings read-only in the console', async () => {
    const page = await get('/admin/site', owner);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Set by opend.config.yaml');
    expect(page.body).toContain('<code>main</code>');
    expect(page.body.match(/<fieldset class="admin-fieldset"\s+disabled>/g)).toHaveLength(3);
    expect(page.body).not.toContain('Save access');
    expect(page.body).not.toContain('Save release lines');
    expect(page.body).not.toContain('Save version picker');
    expect(page.body).not.toMatch(/<script/i);
    const source = await get('/admin/source', owner);
    expect(source.body).toMatch(/name="releaseRefs"[^>]*disabled/);

    const csrf = csrfOf(page);
    const versions = await post('/admin/site/versions', { _csrf: csrf, mode: 'off' }, owner);
    expect(versions.statusCode).toBe(400);
    expect(versions.body).toContain('set by opend.config.yaml');
    const lines = await post(
      '/admin/site/release-lines',
      { _csrf: csrf, releaseLines: 'major' },
      owner,
    );
    expect(lines.statusCode).toBe(400);
    // A forged access form changes nothing the repository declares.
    const access = await post(
      '/admin/site/access',
      { _csrf: csrf, access: 'private', version: '1.4', 'product:gadget': '1' },
      owner,
    );
    expect(access.statusCode).toBe(303);
    // Re-saving the source keeps the declared release refs.
    const saved = await post(
      '/admin/source',
      { _csrf: csrf, from: 'url', fullName: 'acme/docs', sourceUrl: docs.dir, docsPath: '.' },
      owner,
    );
    expect(saved.statusCode).toBe(303);
    expect(await repo()).toMatchObject({
      access: 'public',
      publicEntitlements: { products: ['widget'], version: 'latest' },
      versionPicker: { mode: 'live' },
      releaseLines: 'minor',
      releaseRefs: ['main', 'v*', 'docs/*'],
    });
  });

  it('refuses admin API changes to declared settings with 409, and allows the rest', async () => {
    const conflict = await admin(h.app, 'PUT', '/repos/1/access', { access: 'private' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: expect.stringContaining('set by opend.config.yaml (site: access)'),
    });
    expect((await admin(h.app, 'PUT', '/repos/1/versions', { mode: 'off' })).statusCode).toBe(409);
    expect(
      (await admin(h.app, 'PUT', '/repos/1/release-lines', { releaseLines: 'major' })).statusCode,
    ).toBe(409);
    expect(
      (
        await admin(h.app, 'POST', '/repos', {
          fullName: 'acme/docs',
          sourceUrl: docs.dir,
          releaseRefs: ['main'],
        })
      ).statusCode,
    ).toBe(409);
    // Saying the same thing is no change.
    expect((await admin(h.app, 'PUT', '/repos/1/versions', { mode: 'live' })).statusCode).toBe(200);
    // Re-registering without refs keeps the declared ones.
    expect(
      (await admin(h.app, 'POST', '/repos', { fullName: 'acme/docs', sourceUrl: docs.dir }))
        .statusCode,
    ).toBe(201);
    expect((await repo()).releaseRefs).toEqual(['main', 'v*', 'docs/*']);
  });

  it('leaves declared settings alone in a seed file', async () => {
    await applySeed(
      h.db.pool,
      `repos:
  - fullName: acme/docs
    sourceUrl: ${docs.dir}
    access: private
    versionPicker: { mode: off }
    releaseLines: major
`,
    );
    expect(await repo()).toMatchObject({
      access: 'public',
      versionPicker: { mode: 'live' },
      releaseLines: 'minor',
      releaseRefs: ['main', 'v*', 'docs/*'],
    });
  });

  it('makes the site private again from the repository, dropping every cached public page', async () => {
    // Cached for anonymous visitors now.
    expect((await get('/topics/install.html')).statusCode).toBe(200);
    expect((await get('/search?q=wizard')).statusCode).toBe(200);
    await publish('main', SITE.replace('access: public', 'access: private'));
    expect(await repo()).toMatchObject({
      access: 'private',
      declared: { settings: { access: 'private' } },
    });
    await vi.waitFor(async () => expect(await anonymousIsPrivate()).toBe(true), { timeout: 5000 });
    for (const t of TOPICS) expect((await get(`/${t}.html`)).statusCode).toBe(302);
    expect((await get('/search?q=wizard')).statusCode).toBe(302);
    expect((await get('/_assets/images/logo.svg')).statusCode).not.toBe(200);
  });

  it('hands settings back to the console when the block is removed', async () => {
    await publish('main', '');
    const r = await repo();
    expect(r.declared).toBeNull();
    // What was applied stays until someone changes it.
    expect(r).toMatchObject({ access: 'private', versionPicker: { mode: 'live' } });
    const page = await get('/admin/site', owner);
    expect(page.body).not.toContain('Set by opend.config.yaml');
    expect(page.body).toContain('Save version picker');
    expect((await admin(h.app, 'PUT', '/repos/1/versions', { mode: 'off' })).statusCode).toBe(200);
  });
});
