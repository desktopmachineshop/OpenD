import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReaderContext } from '@opend/model';
import { FsBlobStore, testDatabaseUrl } from '@opend/store';
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

const READERS: Record<string, { email: string; context: ReaderContext }> = {
  'v1-basic': {
    email: 'ann@acme.example',
    context: { products: ['widget'], features: [], version: '1.4' },
  },
  'v2-basic': {
    email: 'ivy@initech.example',
    context: { products: ['widget'], features: [], version: '2.1' },
  },
  'v2-pro': {
    email: 'gus@globex.example',
    context: { products: ['widget', 'gadget'], features: ['sso', 'audit-log'], version: '2.1' },
  },
};

const SEED = `
orgs:
  - slug: acme
    name: Acme
    entitlements: { products: [widget], version: "1.4" }
    readers: [ann@acme.example]
  - slug: initech
    name: Initech
    entitlements: { products: [widget], version: "2.1" }
    readers: [ivy@initech.example]
  - slug: globex
    name: Globex
    entitlements: { products: [widget, gadget], features: [sso, audit-log], version: "2.1" }
    readers: [{ email: gus@globex.example, name: Gus }]
  - slug: newco
    name: Newco
    readers: [nia@newco.example]
`;

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

describe.skipIf(!url)('push to publish', () => {
  let h: Harness;
  let docs: DocsRepo;
  let mainSha: string;
  const cookies: Record<string, string> = {};
  const worker = () =>
    processNext({ pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} });
  const get = (path: string, cookie = '') =>
    h.app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });

  beforeAll(async () => {
    h = await startHarness(url!);
    docs = createDocsRepo(STARTER);
    // A Gadget-only image, to check images are filtered per reader too.
    const pairing = readFileSync(join(STARTER, 'topics/gadget-pairing.dita'), 'utf8');
    mainSha = docs.commit({
      // A header logo, served at /_logo.svg.
      'opend.config.yaml': `${readFileSync(join(STARTER, 'opend.config.yaml'), 'utf8')}logo: images/logo.svg\n`,
      'images/gadget.svg':
        '<svg xmlns="http://www.w3.org/2000/svg"><text>GADGET-ONLY-IMAGE</text></svg>',
      'topics/gadget-pairing.dita': pairing.replace(
        '<shortdesc>',
        '<prolog/><shortdesc><image href="../images/gadget.svg"><alt>Gadget</alt></image> ',
      ),
    });
    await applySeed(h.db.pool, SEED);
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('registers the repo through the admin API', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/admin/api/repos' })).statusCode).toBe(401);
    const bad = await admin(h.app, 'POST', '/repos', { fullName: 'no-slash', sourceUrl: docs.dir });
    expect(bad.statusCode).toBe(400);
    const insecure = await admin(h.app, 'POST', '/repos', {
      fullName: 'acme/docs',
      sourceUrl: 'http://example.com/acme/docs.git',
    });
    expect(insecure.statusCode).toBe(400);
    expect(insecure.json().issues).toEqual([expect.stringMatching(/^sourceUrl: /)]);
    const res = await admin(h.app, 'POST', '/repos', {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['main', 'v*'],
    });
    expect(res.statusCode).toBe(201);
  });

  it('verifies, de-duplicates and filters webhook deliveries', async () => {
    const body = pushPayload('acme/docs', 'refs/heads/main', mainSha);
    expect((await webhook(h.app, body, { secret: 'forged' })).statusCode).toBe(401);
    const first = await webhook(h.app, body, { delivery: 'delivery-1' });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: 'queued' });
    expect((await webhook(h.app, body, { delivery: 'delivery-1' })).json()).toEqual({
      status: 'duplicate',
    });
    expect(
      (await webhook(h.app, pushPayload('acme/docs', 'refs/heads/feature', mainSha))).json(),
    ).toMatchObject({ status: 'ignored' });
    expect(
      (await webhook(h.app, pushPayload('other/repo', 'refs/heads/main', mainSha))).json(),
    ).toMatchObject({ status: 'ignored' });
    expect((await webhook(h.app, '{}', { event: 'ping' })).json()).toEqual({ status: 'pong' });
  });

  it('builds and publishes both release lines', async () => {
    expect(await worker()).toBe('published');
    // The v1 branch documents release 1.4.
    const config = readFileSync(join(docs.dir, 'opend.config.yaml'), 'utf8');
    const v1Sha = docs.commit({
      'opend.config.yaml': config.replace(/^release: .*$/m, 'release: "1.4"'),
    });
    // The worker builds by commit, so main just moves on with the 2.1 config.
    docs.commit({ 'opend.config.yaml': config });
    expect(
      (await webhook(h.app, pushPayload('acme/docs', 'refs/heads/v1', v1Sha))).json(),
    ).toMatchObject({ status: 'queued' });
    expect(await worker()).toBe('published');
    const releases = (await admin(h.app, 'GET', '/repos/1/releases')).json() as {
      releaseLine: string;
      release: string;
    }[];
    expect(releases.map((r) => [r.releaseLine, r.release])).toEqual([
      ['1', '1.4'],
      ['2', '2.1'],
    ]);
  });

  it('never rolls a release line back when an old signed push is replayed', async () => {
    // GitHub signs the body, not X-GitHub-Delivery, so a captured push can be
    // resent under a fresh delivery id.
    const newer = docs.commit({ 'notes.txt': 'a newer commit on main' });
    expect(
      (await webhook(h.app, pushPayload('acme/docs', 'refs/heads/main', newer))).json(),
    ).toMatchObject({ status: 'queued' });
    expect(await worker()).toBe('published');

    const replay = await webhook(h.app, pushPayload('acme/docs', 'refs/heads/main', mainSha), {
      delivery: 'replayed-delivery',
    });
    expect(replay.json()).toEqual({ status: 'duplicate' });
    expect(await worker()).toBeNull();
    const live = (await admin(h.app, 'GET', '/repos/1/releases')).json() as {
      releaseLine: string;
      sha: string;
    }[];
    expect(live.find((r) => r.releaseLine === '2')?.sha).toBe(newer);
  });

  it('sends signed-out readers to sign in, and rejects tampered sessions', async () => {
    const res = await get('/topics/install.html');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/login?returnTo=%2Ftopics%2Finstall.html');
    // Development login and no provider: the sign-in page lists the demo readers.
    const login = await get('/auth/login?returnTo=%2Ftopics%2Finstall.html');
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('Demo readers');
    expect(login.body).toContain('ann@acme.example');
    expect(login.body).toContain('name="returnTo" value="/topics/install.html"');
    expect(login.body).not.toContain('Sign in with GitHub');

    const cookie = await devLogin(h.app, READERS['v1-basic']!.email);
    expect((await get('/topics/install.html', cookie)).statusCode).toBe(200);
    const tampered = cookie.replace(
      /opend_session=([^;]*)/,
      (_m, v: string) => `opend_session=${v.replace('%22r%22%3A', '%22r%22%3A9')}`,
    );
    expect((await get('/topics/install.html', tampered)).statusCode).toBe(302);
  });

  it('tells readers whose org has no entitlements that they have no access', async () => {
    const res = await get('/', await devLogin(h.app, 'nia@newco.example'));
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('no documentation entitlements');
  });

  describe.each(Object.entries(READERS))('%s', (name, reader) => {
    let html: string;
    beforeAll(async () => {
      cookies[name] = await devLogin(h.app, reader.email);
      const pages = await Promise.all(TOPICS.map((t) => get(`/${t}.html`, cookies[name])));
      html = pages.map((p) => p.body).join('\n');
    });

    it.each(MARKERS)('%s', (phrase, rule) => {
      expect(html.includes(phrase)).toBe(rule(reader.context));
    });

    it('serves the release line matching the reader version', async () => {
      const page = (await get('/topics/overview.html', cookies[name])).body;
      expect(page).toContain(`Release ${reader.context.version.startsWith('1') ? '1.4' : '2.1'}`);
      // The header shows the reader's name (or email), with the email as its title.
      expect(page).toContain(`title="${reader.email}"`);
      expect(page).toContain(`Signed in as </span>${name === 'v2-pro' ? 'Gus' : reader.email}`);
      expect(page).toContain('<form method="post" action="/auth/logout">');
    });

    it('serves images only when a visible topic references them', async () => {
      expect((await get('/_assets/images/logo.svg', cookies[name])).statusCode).toBe(200);
      const gadget = await get('/_assets/images/gadget.svg', cookies[name]);
      expect(gadget.statusCode).toBe(reader.context.products.includes('gadget') ? 200 : 404);
      expect((await get('/_assets/opend.config.yaml', cookies[name])).statusCode).toBe(404);
    });

    it('shows the project logo in the header and serves it sandboxed', async () => {
      const page = (await get('/topics/overview.html', cookies[name])).body;
      expect(page).toContain('<img class="site-logo" src="/_logo.svg" alt="">');
      expect(page).toContain('<details class="site-menu">');
      const logo = await get('/_logo.svg', cookies[name]);
      expect(logo.statusCode).toBe(200);
      expect(logo.headers['content-type']).toContain('image/svg+xml');
      expect(logo.headers['content-security-policy']).toContain('sandbox');
      expect((await get('/_logo.png', cookies[name])).statusCode).toBe(404);
      expect((await get('/_logo.svg')).statusCode).toBe(302);
    });

    it('sends hardening headers and never caches personalised pages', async () => {
      const res = await get('/topics/overview.html', cookies[name]);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const svg = await get('/_assets/images/logo.svg', cookies[name]);
      expect(svg.headers['content-security-policy']).toContain('sandbox');
    });
  });

  it('keeps the previous release live when a push fails validation', async () => {
    const install = readFileSync(join(docs.dir, 'topics/install.dita'), 'utf8');
    const broken = docs.commit({
      'topics/install.dita': install.replace(
        '<xref href="configure.dita"/>',
        '<xref href="gone.dita"/>',
      ),
    });
    const queued = (
      await webhook(h.app, pushPayload('acme/docs', 'refs/heads/main', broken))
    ).json() as { job: number };
    expect(await worker()).toBe('failed');

    const build = (await admin(h.app, 'GET', `/builds/${queued.job}`)).json() as {
      status: string;
      diagnostics: { code: string }[];
    };
    expect(build.status).toBe('failed');
    expect(build.diagnostics.map((d) => d.code)).toContain('broken-link');
    const page = await get('/topics/install.html', cookies['v2-pro']);
    expect(page.body).toContain('Configure the hub');
  });

  it('applies entitlement changes without waiting for the cache', async () => {
    expect((await get('/topics/configure-sso.html', cookies['v2-pro'])).statusCode).toBe(200);
    const res = await admin(h.app, 'PUT', '/orgs/globex/entitlements', {
      products: ['widget', 'gadget'],
      features: ['audit-log'],
      version: '2.1',
    });
    expect(res.statusCode).toBe(200);
    expect((await get('/topics/configure-sso.html', cookies['v2-pro'])).statusCode).toBe(404);
    const audit = (await admin(h.app, 'GET', '/audit')).json() as { action: string }[];
    expect(audit[0]?.action).toBe('entitlements.set');
  });

  it('picks up changes made by another replica through NOTIFY', async () => {
    // Change entitlements directly in the database, as another replica would.
    await h.db.pool.query(
      "update entitlements set features = '{sso,audit-log}' where org_id = (select id from orgs where slug = 'globex')",
    );
    await h.db.pool.query("select pg_notify('opend_entitlements_changed', '')");
    await expect
      .poll(async () => (await get('/topics/configure-sso.html', cookies['v2-pro'])).statusCode)
      .toBe(200);
  });

  it('takes a release line off the site and falls back to the next newest', async () => {
    expect((await admin(h.app, 'DELETE', '/repos/1/releases/2')).statusCode).toBe(204);
    expect((await admin(h.app, 'DELETE', '/repos/1/releases/2')).statusCode).toBe(404);
    const live = (await admin(h.app, 'GET', '/repos/1/releases')).json() as {
      releaseLine: string;
    }[];
    expect(live.map((r) => r.releaseLine)).toEqual(['1']);
    expect((await get('/topics/install.html', cookies['v2-basic'])).body).toContain(
      'No documentation has been published for release 2.x yet.',
    );
    expect((await get('/topics/install.html', cookies['v1-basic'])).statusCode).toBe(200);
    // The staff view, used by API keys without a version, now reads line 1.
    const key = (
      await admin(h.app, 'POST', '/api-keys', {
        name: 'fallback',
        scopes: ['read'],
        audience: 'staff',
      })
    ).json() as { token: string };
    const versions = await h.app.inject({
      method: 'GET',
      url: '/api/v1/versions',
      headers: { authorization: `Bearer ${key.token}` },
    });
    expect(versions.json()).toMatchObject({ current: '1' });
    const audit = (await admin(h.app, 'GET', '/audit')).json() as { action: string }[];
    expect(audit.map((a) => a.action)).toContain('release.retire');
  });

  it('reports health', async () => {
    expect((await get('/healthz')).json()).toEqual({ status: 'ok' });
  });
});
