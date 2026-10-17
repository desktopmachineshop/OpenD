import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeGitHub } from '@opend/editor';
import { FsBlobStore, SETTING, listAudit, testDatabaseUrl } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import {
  createApp,
  loadConfig,
  signManifestState,
  verifyManifestState,
  type OpendApp,
} from '../src/index.js';
import {
  STARTER,
  admin,
  cookiesFrom,
  devLogin,
  pushPayload,
  startHarness,
  webhook,
  type Harness,
} from './helpers.js';

const url = testDatabaseUrl();

const csrfOf = (res: LightMyRequestResponse) =>
  /name="_csrf" value="([^"]+)"/.exec(res.body)?.[1] ?? '';

/** Every state-changing route of the console. */
const POSTS = [
  '/admin/site/access',
  '/admin/source',
  '/admin/source/rebuild',
  '/admin/people/orgs',
  '/admin/people/orgs/delete',
  '/admin/people/readers',
  '/admin/people/readers/staff',
  '/admin/people/readers/delete',
  '/admin/sign-in/oidc',
  '/admin/sign-in/oidc/delete',
  '/admin/sign-in/options',
  '/admin/github/disconnect',
  '/admin/editor',
  '/admin/editor/users',
  '/admin/editor/users/disable',
];
const PAGES = [
  '/admin',
  '/admin/site',
  '/admin/source',
  '/admin/people',
  '/admin/sign-in',
  '/admin/github',
  '/admin/integrations',
  '/admin/editor',
];

function client(h: { app: OpendApp['app'] }) {
  const get = (path: string, cookie = '') =>
    h.app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });
  const post = (
    path: string,
    form: Record<string, string>,
    cookie = '',
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method: 'POST',
      url: path,
      payload: new URLSearchParams(form).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
    });
  return { get, post };
}

/** Signs in through a one-time setup link minted with the admin token. */
async function setupStaff(h: Harness, email: string): Promise<string> {
  const minted = await admin(h.app, 'POST', '/setup-links', {});
  expect(minted.statusCode).toBe(201);
  const link = new URL((minted.json() as { url: string }).url);
  const { post } = client(h);
  const res = await post('/admin/setup', {
    token: link.searchParams.get('token')!,
    email,
    name: 'Olive Owner',
  });
  expect(res.statusCode).toBe(303);
  expect(res.headers.location).toBe('/admin?done=welcome');
  return cookiesFrom(res);
}

describe.skipIf(!url)('the admin console', () => {
  let h: Harness;
  let docs: DocsRepo;
  const gh = new FakeGitHub();
  const logs: string[] = [];
  let owner = '';
  const { get, post } = client({
    get app() {
      return h.app;
    },
  });
  const worker = () =>
    processNext({ pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} });
  /** POSTs a console form with the session's CSRF token, read from `page`. */
  const submit = async (
    page: string,
    path: string,
    form: Record<string, string>,
    cookie = owner,
  ) => {
    const csrf = csrfOf(await get(page, cookie));
    expect(csrf).not.toBe('');
    return post(path, { ...form, _csrf: csrf }, cookie);
  };

  beforeAll(async () => {
    h = await startHarness(url!, {
      githubFetch: gh.fetch,
      config: {
        webhookSecret: undefined,
        githubWebUrl: gh.webUrl,
        githubApiUrl: gh.apiUrl,
      },
    });
    h.ctx.log = (entry) => logs.push(JSON.stringify(entry));
    docs = createDocsRepo(STARTER);
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  describe('the first staff reader', () => {
    it('cannot be made without a valid one-time link', async () => {
      expect((await get('/admin/setup')).statusCode).toBe(404);
      expect((await get('/admin/setup?token=nope')).statusCode).toBe(404);
      const forged = await post('/admin/setup', {
        token: 'x'.repeat(43),
        email: 'eve@evil.example',
      });
      expect(forged.statusCode).toBe(404);
      expect(forged.headers['set-cookie']).toBeUndefined();
    });

    it('signs the visitor in as a new staff reader, once', async () => {
      const minted = await admin(h.app, 'POST', '/setup-links', { minutes: 10 });
      const token = new URL((minted.json() as { url: string }).url).searchParams.get('token')!;
      const page = await get(`/admin/setup?token=${token}`);
      expect(page.statusCode).toBe(200);
      expect(page.headers['referrer-policy']).toBe('same-origin');
      expect(page.body).toContain('Become the first administrator');
      // As a browser sends it: with this site's Origin.
      const res = await post(
        '/admin/setup',
        { token, email: 'owner@docs.example', name: 'Olive' },
        '',
        { origin: 'http://docs.test' },
      );
      expect(res.statusCode).toBe(303);
      owner = cookiesFrom(res);
      const home = await get('/admin?done=welcome', owner);
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain('Welcome. You are a staff reader');
      // Used up, and no second link while a staff reader exists.
      expect((await get(`/admin/setup?token=${token}`)).statusCode).toBe(404);
      const again = await post('/admin/setup', { token, email: 'eve@evil.example' });
      expect(again.statusCode).toBe(404);
      expect((await admin(h.app, 'POST', '/setup-links', {})).statusCode).toBe(409);
      const readers = (await admin(h.app, 'GET', '/readers')).json() as {
        email: string;
        staff: boolean;
        orgSlug: string;
      }[];
      expect(readers).toEqual([
        expect.objectContaining({ email: 'owner@docs.example', staff: true, orgSlug: 'staff' }),
      ]);
      expect((await listAudit(h.db.pool)).map((a) => a.action)).toEqual(
        expect.arrayContaining(['admin.setup-link', 'admin.setup']),
      );
    });
  });

  describe('access', () => {
    let reader = '';
    beforeAll(async () => {
      await admin(h.app, 'POST', '/orgs', {
        slug: 'acme',
        name: 'Acme',
        entitlements: { products: ['widget'], version: '1.4' },
      });
      await admin(h.app, 'POST', '/readers', { orgSlug: 'acme', email: 'ann@acme.example' });
      reader = await devLogin(h.app, 'ann@acme.example');
    });

    it.each(PAGES)('sends anonymous visitors of %s to sign in', async (path) => {
      const res = await get(path);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/auth/login?returnTo=${encodeURIComponent(path)}`);
    });

    it.each(PAGES)('answers 404 to a reader who is not staff on %s', async (path) => {
      const res = await get(path, reader);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('Admin');
      expect(res.body).not.toContain('_csrf');
    });

    it.each(POSTS)('answers 404 to POST %s from anyone but staff', async (path) => {
      expect((await post(path, {})).statusCode).toBe(404);
      expect((await post(path, { _csrf: 'x' }, reader)).statusCode).toBe(404);
    });

    it('does not accept the embed session, even for staff', async () => {
      const readers = (await admin(h.app, 'GET', '/readers')).json() as {
        id: number;
        email: string;
      }[];
      const id = readers.find((r) => r.email === 'owner@docs.example')!.id;
      const value = h.app.signCookie(
        JSON.stringify({ r: id, e: Math.floor(Date.now() / 1000) + 600 }),
      );
      const res = await get('/admin', `opend_embed=${encodeURIComponent(value)}`);
      expect(res.statusCode).not.toBe(200);
    });

    it.each(PAGES)(
      'serves %s to staff without scripts, cached nowhere, unframeable',
      async (path) => {
        const res = await get(path, owner);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
        expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
        expect(res.body).not.toMatch(/<script|\son[a-z]+=|\sstyle="/i);
        expect(res.body.match(/<h1[\s>]/g)).toHaveLength(1);
        expect(res.body).toContain('class="opend-skip"');
      },
    );

    it.each(POSTS)(
      'refuses POST %s without the CSRF token or from another origin',
      async (path) => {
        expect((await post(path, {}, owner)).statusCode).toBe(403);
        expect((await post(path, { _csrf: 'forged' }, owner)).statusCode).toBe(403);
        const csrf = csrfOf(await get('/admin', owner));
        const cross = await post(path, { _csrf: csrf }, owner, { origin: 'https://evil.example' });
        expect(cross.statusCode).toBe(403);
      },
    );

    it('binds the CSRF token to the session', async () => {
      await admin(h.app, 'POST', '/readers', {
        orgSlug: 'staff',
        email: 'second@docs.example',
        staff: true,
      });
      const other = await devLogin(h.app, 'second@docs.example');
      const csrf = csrfOf(await get('/admin', owner));
      expect(csrfOf(await get('/admin', other))).not.toBe(csrf);
      expect((await post('/admin/sign-in/options', { _csrf: csrf }, other)).statusCode).toBe(403);
    });
  });

  describe('docs source, builds and access', () => {
    it('registers a repository by URL and builds it now', async () => {
      const res = await submit('/admin/source', '/admin/source', {
        from: 'url',
        fullName: 'acme/docs',
        sourceUrl: docs.dir,
        releaseRefs: 'main, v*',
        docsPath: '.',
        build: '1',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/admin/source?done=repo-build');
      expect(await worker()).toBe('published');
      const overview = await get('/admin', owner);
      expect(overview.body).toContain('Live releases');
      expect(overview.body).toMatch(/succeeded/);
      const repos = (await admin(h.app, 'GET', '/repos')).json() as { releaseRefs: string[] }[];
      expect(repos[0]!.releaseRefs).toEqual(['main', 'v*']);
      // Staff find the console from the docs; other readers see no trace of it.
      const first = String((await get('/', owner)).headers.location);
      expect((await get(first, owner)).body).toContain('<a href="/admin">Admin</a>');
      const ann = await devLogin(h.app, 'ann@acme.example');
      const page = await get(String((await get('/', ann)).headers.location), ann);
      expect(page.body).not.toContain('href="/admin"');
    });

    it('rebuilds on request, and shows failed builds with their diagnostics', async () => {
      docs.commit({ 'topics/overview.dita': '<topic id="x"><title>Broken' });
      const res = await submit('/admin/source', '/admin/source/rebuild', { repoId: '1' });
      expect(res.headers.location).toBe('/admin/source?done=build');
      expect(await worker()).toBe('failed');
      const page = await get('/admin/source', owner);
      expect(page.body).toContain('failed');
      expect(page.body).toMatch(/problem\(s\)/);
    });

    it('refuses a repository URL the worker may not fetch', async () => {
      const res = await submit('/admin/source', '/admin/source', {
        from: 'url',
        fullName: 'acme/docs',
        sourceUrl: 'ssh://git@example.com/acme/docs',
        releaseRefs: 'main',
        docsPath: '.',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Check the repository');
    });

    it('offers the declared products and features, and makes the site public', async () => {
      const page = await get('/admin/site', owner);
      expect(page.body).toContain('name="product:widget"');
      expect(page.body).toContain('name="product:gadget"');
      const res = await submit('/admin/site', '/admin/site/access', {
        access: 'public',
        'product:widget': '1',
        'product:<script>': '1',
        version: '2.1',
      });
      expect(res.statusCode).toBe(303);
      const repos = (await admin(h.app, 'GET', '/repos')).json() as object[];
      expect(repos[0]).toMatchObject({
        access: 'public',
        publicEntitlements: { products: ['widget'], features: [], version: '2.1' },
      });
      // Anonymous visitors now get pages.
      expect((await get('/')).statusCode).toBe(302);
      expect((await get('/')).headers.location).toMatch(/\.html$/);
      const entry = (await listAudit(h.db.pool, 50)).find((a) => a.action === 'repo.access');
      expect(entry?.actor).toBe('staff:owner@docs.example');
      // And back to private.
      await submit('/admin/site', '/admin/site/access', { access: 'private', version: '' });
      expect((await get('/')).headers.location).toMatch(/^\/auth\/login/);
    });
  });

  describe('people', () => {
    it('adds orgs with entitlements and readers, and toggles staff', async () => {
      let res = await submit('/admin/people', '/admin/people/orgs', {
        slug: 'globex',
        name: 'Globex',
        'product:gadget': '1',
        version: '2.1',
      });
      expect(res.statusCode).toBe(303);
      res = await submit('/admin/people', '/admin/people/readers', {
        email: 'gus@globex.example',
        orgSlug: 'globex',
      });
      expect(res.statusCode).toBe(303);
      const orgs = (await admin(h.app, 'GET', '/orgs')).json() as object[];
      expect(orgs).toContainEqual(
        expect.objectContaining({ slug: 'globex', products: ['gadget'], version: '2.1' }),
      );
      const readers = (await admin(h.app, 'GET', '/readers')).json() as {
        id: number;
        email: string;
        staff: boolean;
      }[];
      const gus = readers.find((r) => r.email === 'gus@globex.example')!;
      res = await submit('/admin/people', '/admin/people/readers/staff', {
        id: String(gus.id),
        staff: '1',
      });
      expect(res.statusCode).toBe(303);
      const after = (await admin(h.app, 'GET', '/readers')).json() as typeof readers;
      expect(after.find((r) => r.id === gus.id)!.staff).toBe(true);
    });

    it('stops staff locking themselves out', async () => {
      const readers = (await admin(h.app, 'GET', '/readers')).json() as {
        id: number;
        email: string;
      }[];
      const me = readers.find((r) => r.email === 'owner@docs.example')!;
      let res = await submit('/admin/people', '/admin/people/readers/staff', {
        id: String(me.id),
        staff: '0',
      });
      expect(res.statusCode).toBe(400);
      res = await submit('/admin/people', '/admin/people/readers/delete', { id: String(me.id) });
      expect(res.statusCode).toBe(400);
      res = await submit('/admin/people', '/admin/people/orgs/delete', { slug: 'staff' });
      expect(res.statusCode).toBe(400);
    });

    it('revokes console access at once when staff is removed', async () => {
      const gusCookie = await devLogin(h.app, 'gus@globex.example');
      expect((await get('/admin', gusCookie)).statusCode).toBe(200);
      const readers = (await admin(h.app, 'GET', '/readers')).json() as {
        id: number;
        email: string;
      }[];
      const gus = readers.find((r) => r.email === 'gus@globex.example')!;
      await submit('/admin/people', '/admin/people/readers/staff', {
        id: String(gus.id),
        staff: '0',
      });
      expect((await get('/admin', gusCookie)).statusCode).toBe(404);
    });
  });

  describe('sign-in settings', () => {
    const SECRET = 'oidc-client-secret-do-not-show';

    it('stores the OIDC client secret encrypted and never shows, returns or logs it', async () => {
      const res = await submit('/admin/sign-in', '/admin/sign-in/oidc', {
        issuer: 'https://login.acme.example',
        clientId: 'docs',
        clientSecret: SECRET,
        displayName: 'Acme SSO',
        icon: 'key',
      });
      expect(res.statusCode).toBe(303);
      expect(h.ctx.config.oidc).toMatchObject({
        issuer: 'https://login.acme.example',
        clientSecret: SECRET,
      });
      const page = await get('/admin/sign-in', owner);
      expect(page.body).toContain('login.acme.example');
      expect(page.body).toContain('Set — leave empty to keep it');
      expect(page.body).not.toContain(SECRET);
      const api = await admin(h.app, 'GET', '/settings');
      expect(api.body).not.toContain(SECRET);
      expect(api.json()).toMatchObject({ secrets: { 'oidc.clientSecret': 'set' } });
      const rows = await h.db.pool.query('select * from secrets');
      expect(JSON.stringify(rows.rows)).not.toContain(SECRET);
      expect(JSON.stringify(await listAudit(h.db.pool, 100))).not.toContain(SECRET);
      expect(logs.join('\n')).not.toContain(SECRET);
      // The sign-in page offers it without a restart.
      const login = await get('/auth/login');
      expect(login.body).toContain('Sign in with Acme SSO');
    });

    it('keeps the stored secret when the form leaves it empty', async () => {
      await submit('/admin/sign-in', '/admin/sign-in/oidc', {
        issuer: 'https://login.acme.example',
        clientId: 'docs2',
        clientSecret: '',
        displayName: 'GitHub',
        icon: 'github',
      });
      expect(h.ctx.config.oidc).toMatchObject({
        clientId: 'docs2',
        clientSecret: SECRET,
        icon: 'github',
      });
      // The managed-hosting look: "Sign in with GitHub" with GitHub's mark, through OIDC.
      const login = await get('/auth/login');
      expect(login.body).toMatch(
        /href="\/auth\/oidc[^"]*"><svg viewBox="0 0 16 16"[^>]*><path d="M8 0C3\.58/,
      );
    });

    it('turns demo readers off, which only the environment can allow', async () => {
      expect((await get('/auth/login')).body).toContain('Demo readers');
      await submit('/admin/sign-in', '/admin/sign-in/options', {});
      expect((await get('/auth/login')).body).not.toContain('Demo readers');
      expect((await post('/auth/dev', { readerId: '1' })).statusCode).toBe(404);
      await submit('/admin/sign-in', '/admin/sign-in/options', { devLogin: '1' });
      expect((await get('/auth/login')).body).toContain('Demo readers');
    });

    it('removes company sign-in', async () => {
      await submit('/admin/sign-in', '/admin/sign-in/oidc/delete', {});
      expect(h.ctx.config.oidc).toBeUndefined();
      expect((await h.db.pool.query('select * from secrets')).rowCount).toBe(0);
    });
  });

  describe('editor settings', () => {
    it('sets the editor address and the page links', async () => {
      let res = await submit('/admin/editor', '/admin/editor', {
        url: 'http://docs.test/',
        editLinks: '1',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('its own host');
      res = await submit('/admin/editor', '/admin/editor', {
        url: 'http://editor.test/x',
        editLinks: '1',
      });
      expect(res.statusCode).toBe(303);
      expect(h.ctx.config.editorUrl).toBe('http://editor.test');
      expect(h.ctx.config.editLinks).toBe(true);
      await submit('/admin/editor', '/admin/editor', { url: 'http://editor.test' });
      expect(h.ctx.config.editLinks).toBe(false);
    });

    it('registers authors', async () => {
      const res = await submit('/admin/editor', '/admin/editor/users', {
        email: 'writer@acme.example',
        name: 'Wren Writer',
        github: '@wren',
      });
      expect(res.statusCode).toBe(303);
      const page = await get('/admin/editor', owner);
      expect(page.body).toContain('writer@acme.example');
      expect(page.body).toContain('@wren');
    });
  });

  describe('Connect GitHub', () => {
    let state = '';

    it('renders a visible "Continue to GitHub" form posting the manifest', async () => {
      const intro = await get('/admin/github', owner);
      expect(intro.body).toContain('Connect GitHub');
      const res = await get('/admin/github/connect?name=Acme+docs&owner=acme', owner);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toContain(`form-action 'self' ${gh.webUrl}`);
      const action = /<form method="post" action="(https?:\/\/[^"]+)">/
        .exec(res.body)![1]!
        .replaceAll('&amp;', '&');
      const target = new URL(action);
      expect(`${target.origin}${target.pathname}`).toBe(
        `${gh.webUrl}/organizations/acme/settings/apps/new`,
      );
      state = target.searchParams.get('state')!;
      const manifest = JSON.parse(
        /name="manifest" value="([^"]+)"/
          .exec(res.body)![1]!
          .replaceAll('&quot;', '"')
          .replaceAll('&amp;', '&'),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        name: 'Acme docs',
        url: 'http://docs.test',
        hook_attributes: { url: 'http://docs.test/webhooks/github', active: true },
        redirect_url: 'http://docs.test/admin/github/manifest-callback',
        callback_urls: [
          'http://docs.test/auth/github/callback',
          'http://editor.test/auth/github/callback',
        ],
        setup_url: 'http://docs.test/admin/github/installed',
        public: false,
        request_oauth_on_install: false,
        default_events: ['push'],
        default_permissions: {
          contents: 'write',
          pull_requests: 'write',
          administration: 'read',
          checks: 'read',
          statuses: 'write',
          metadata: 'read',
        },
      });
      expect(res.body).toContain('Continue to GitHub');
      expect(res.body).not.toMatch(/<script/i);
    });

    it('refuses callbacks without a valid state bound to this session', async () => {
      gh.addManifestCode('code-1', { name: 'Acme docs', owner: 'acme' });
      const cb = (s: string, cookie = owner) =>
        get(`/admin/github/manifest-callback?code=code-1&state=${encodeURIComponent(s)}`, cookie);
      expect((await cb('')).statusCode).toBe(400);
      expect((await cb(`${state}x`)).statusCode).toBe(400);
      const [payload] = state.split('.');
      expect((await cb(`${payload}.${'A'.repeat(43)}`)).statusCode).toBe(400);
      // Another staff session cannot complete it.
      const other = await devLogin(h.app, 'second@docs.example');
      expect((await cb(state, other)).statusCode).toBe(400);
      // Nor anyone who is not staff.
      expect((await cb(state, '')).statusCode).toBe(302);
      expect(h.ctx.github.mode()).toBe('none');
    });

    it('expires the state after an hour', () => {
      const cookie = 'session-cookie-value';
      const old = signManifestState(h.ctx, cookie, Date.now() - 61 * 60_000);
      expect(verifyManifestState(h.ctx, old, cookie)).toBe(false);
      const fresh = signManifestState(h.ctx, cookie);
      expect(verifyManifestState(h.ctx, fresh, cookie)).toBe(true);
      expect(verifyManifestState(h.ctx, fresh, 'another-session')).toBe(false);
    });

    it('exchanges the code, stores the app encrypted and sends the owner to install it', async () => {
      const res = await get(
        `/admin/github/manifest-callback?code=code-1&state=${encodeURIComponent(state)}`,
        owner,
      );
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`${gh.webUrl}/apps/acme-docs/installations/new`);
      expect(h.ctx.github.mode()).toBe('stored');
      const created = [...gh.apps.values()][0]!;
      const rows = JSON.stringify((await h.db.pool.query('select * from secrets')).rows);
      expect(rows).not.toContain('PRIVATE KEY');
      expect(rows).not.toContain(created.webhookSecret);
      const api = (await admin(h.app, 'GET', '/settings')).body;
      expect(api).not.toContain('PRIVATE KEY');
      expect(api).not.toContain(created.webhookSecret);
      const page = await get('/admin/github', owner);
      expect(page.body).toContain('Install the app');
      // The manifest can't ask for the account-level email permission; the page says how to add it.
      expect(page.body).toContain('Email addresses');
      expect(page.body).toContain('/settings/apps/');
      expect(page.body).not.toContain(created.webhookSecret);
      expect(logs.join('\n')).not.toContain(created.webhookSecret);
      expect(logs.join('\n')).not.toContain('PRIVATE KEY');
      // GitHub sign-in is offered with the new app's client id.
      expect((await get('/auth/login')).body).toContain('Sign in with GitHub');
      expect(h.ctx.config.githubOAuth?.clientId).toBe('Iv1.acme-docs');
      // The code works once.
      const again = await get(
        `/admin/github/manifest-callback?code=code-1&state=${encodeURIComponent(state)}`,
        owner,
      );
      expect(again.statusCode).toBe(400);
    });

    it('verifies the installation id with GitHub before storing it', async () => {
      const appId = [...gh.apps.keys()][0]!;
      gh.addInstallation(55, 'acme', ['acme/docs', 'acme/handbook'], appId);
      gh.addInstallation(66, 'someone-else', ['evil/repo'], appId + 1);
      expect((await get('/admin/github/installed?installation_id=66', owner)).statusCode).toBe(400);
      expect((await get('/admin/github/installed?installation_id=99', owner)).statusCode).toBe(400);
      expect((await get('/admin/github/installed?installation_id=abc', owner)).statusCode).toBe(
        400,
      );
      const res = await get(
        '/admin/github/installed?installation_id=55&setup_action=install',
        owner,
      );
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/admin/source?done=installed');
      const page = await get('/admin/source?done=installed', owner);
      expect(page.body).toMatch(/<option\s+value="acme\/docs"/);
      expect(page.body).toContain('acme/handbook');
    });

    it('registers a picked repository with its installation, never a posted one', async () => {
      let res = await submit('/admin/source', '/admin/source', {
        from: 'github',
        repo: 'evil/repo',
        releaseRefs: 'main',
        docsPath: '.',
      });
      expect(res.statusCode).toBe(400);
      res = await submit('/admin/source', '/admin/source', {
        from: 'github',
        repo: 'acme/docs',
        installationId: '66',
        releaseRefs: 'main',
        docsPath: '.',
      });
      expect(res.statusCode).toBe(303);
      const repos = (await admin(h.app, 'GET', '/repos')).json() as object[];
      expect(repos).toEqual([
        expect.objectContaining({
          fullName: 'acme/docs',
          sourceUrl: `${gh.webUrl}/acme/docs.git`,
          installationId: 55,
        }),
      ]);
    });

    it('verifies webhooks with the stored secret', async () => {
      const secret = [...gh.apps.values()][0]!.webhookSecret;
      const body = pushPayload('acme/docs', 'refs/heads/main', 'e'.repeat(40));
      expect((await webhook(h.app, body, { secret: 'wrong' })).statusCode).toBe(401);
      const res = await webhook(h.app, body, { secret });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ status: 'queued' });
    });

    it('mints installation tokens for builds from the stored app', async () => {
      const repos = (await admin(h.app, 'GET', '/repos')).json() as {
        fullName: string;
        sourceUrl: string;
        installationId: number;
      }[];
      const token = await h.ctx.github.repoToken(repos[0]!, 'read');
      expect(token).toMatch(/^ghs_/);
    });

    it('disconnects', async () => {
      const res = await submit('/admin/github', '/admin/github/disconnect', {});
      expect(res.statusCode).toBe(303);
      expect(h.ctx.github.mode()).toBe('none');
      expect(h.ctx.config.githubOAuth).toBeUndefined();
      expect(h.ctx.config.webhookSecret).toBeUndefined();
      expect((await h.db.pool.query('select * from secrets')).rowCount).toBe(0);
    });
  });

  describe('settings across processes', () => {
    let second: OpendApp;
    beforeAll(async () => {
      second = await createApp(h.ctx.env, {
        pool: h.db.pool,
        blobs: new FsBlobStore(h.blobDir),
        log: () => {},
      });
      await second.app.ready();
    });
    afterAll(async () => second?.app.close());

    it('reloads on NOTIFY without a restart', async () => {
      await submit('/admin/editor', '/admin/editor', {
        url: 'http://edit-two.test',
        editLinks: '1',
      });
      await expect
        .poll(() => second.ctx.config.editorUrl, { timeout: 15_000 })
        .toBe('http://edit-two.test');
    });
  });
});

describe.skipIf(!url)('environment variables over console settings', () => {
  let h: Harness;
  let owner = '';
  const { get, post } = client({
    get app() {
      return h.app;
    },
  });
  beforeAll(async () => {
    h = await startHarness(url!, {
      config: {
        oidc: {
          issuer: 'https://env-idp.example',
          clientId: 'env',
          clientSecret: 'env-secret',
          scopes: 'openid email',
          displayName: 'Env SSO',
        },
        editorUrl: 'https://edit.env.example',
      },
    });
    owner = await setupStaff(h, 'owner@docs.example');
  });
  afterAll(async () => h?.close());

  it('uses the environment and shows it read-only', async () => {
    // Even a stored setting (say, from before the variable was set) loses to the variable.
    await h.db.pool.query(
      `insert into settings (key, value, updated_by) values ($1, $2, 'test'), ($3, $4, 'test')`,
      [
        SETTING.oidc,
        JSON.stringify({ issuer: 'https://db-idp.example', clientId: 'db' }),
        SETTING.editor,
        JSON.stringify({ url: 'https://edit.db.example', editLinks: false }),
      ],
    );
    await h.ctx.reloadSettings();
    expect(h.ctx.config.oidc?.issuer).toBe('https://env-idp.example');
    expect(h.ctx.config.editorUrl).toBe('https://edit.env.example');
    // Settings without a variable still apply.
    expect(h.ctx.config.editLinks).toBe(false);
    const page = await get('/admin/sign-in', owner);
    expect(page.body).toContain('Set by environment');
    expect(page.body).toMatch(/name="issuer"[^>]*disabled/);
    const csrf = csrfOf(page);
    const res = await post(
      '/admin/sign-in/oidc',
      { _csrf: csrf, issuer: 'https://x.example', clientId: 'x', clientSecret: 'y' },
      owner,
    );
    expect(res.statusCode).toBe(400);
    expect((await get('/auth/login')).body).toContain('Sign in with Env SSO');
  });
});

describe.skipIf(!url)('managed hosting (token broker)', () => {
  let h: Harness;
  let owner = '';
  const BROKER = 'https://control.test/broker/v1';
  const brokerCalls: string[] = [];
  const brokerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    brokerCalls.push(u.pathname);
    if (new Headers(init?.headers).get('authorization') !== 'Bearer broker-secret-0123456789')
      return new Response('{}', { status: 401 });
    if (u.pathname === '/broker/v1/repos')
      return Response.json({
        repos: [
          { fullName: 'acme/docs', private: true, defaultBranch: 'main', installationId: 4242 },
        ],
      });
    if (u.pathname === '/broker/v1/token') {
      const body = JSON.parse(String(init?.body)) as { repo: string; permissions: string };
      if (body.repo !== 'acme/docs') return new Response('{}', { status: 404 });
      return Response.json({
        token: `ghs_broker_${body.permissions}`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const { get, post } = client({
    get app() {
      return h.app;
    },
  });

  beforeAll(async () => {
    h = await startHarness(url!, {
      githubFetch: brokerFetch,
      config: {
        broker: {
          url: BROKER,
          secret: 'broker-secret-0123456789',
          installUrl: 'https://github.com/apps/opend/installations/new',
        },
      },
    });
    owner = await setupStaff(h, 'owner@docs.example');
  });
  afterAll(async () => h?.close());

  it('shows "Managed by your hosting provider" with the install link, and no manifest flow', async () => {
    expect(h.ctx.github.mode()).toBe('broker');
    const page = await get('/admin/github', owner);
    expect(page.body).toContain('Managed by your hosting provider');
    expect(page.body).toContain('href="https://github.com/apps/opend/installations/new"');
    expect(page.body).toContain('<code>acme/docs</code>');
    expect(page.body).not.toContain('/admin/github/connect');
    const connect = await get('/admin/github/connect?name=x', owner);
    expect(connect.statusCode).toBe(302);
    expect(connect.headers.location).toBe('/admin/github');
  });

  it('welcomes the owner back from the control plane at /admin/integrations?github=connected', async () => {
    const page = await get('/admin/integrations?github=connected', owner);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('GitHub connected. Choose the docs repository below.');
    expect(page.body).toMatch(/<option\s+value="acme\/docs"/);
    expect(page.body).toContain('action="/admin/source"');
    // The install URL carries the provider's signed state: linked exactly as given.
    expect(page.body).toContain('href="https://github.com/apps/opend/installations/new"');
  });

  it('posts no commit statuses in broker mode', async () => {
    const before = brokerCalls.length;
    await h.ctx.github.report(
      {
        fullName: 'acme/docs',
        installationId: null,
        sourceUrl: 'https://github.com/acme/docs.git',
      },
      'a'.repeat(40),
      'success',
      'Published',
    );
    expect(brokerCalls.length).toBe(before);
  });

  it('picks the docs repository from the broker’s list', async () => {
    const page = await get('/admin/source', owner);
    expect(page.body).toMatch(/<option\s+value="acme\/docs"/);
    const res = await post(
      '/admin/source',
      {
        _csrf: csrfOf(page),
        from: 'github',
        repo: 'acme/docs',
        releaseRefs: 'main',
        docsPath: 'docs',
      },
      owner,
    );
    expect(res.statusCode).toBe(303);
    const repos = (await admin(h.app, 'GET', '/repos')).json() as object[];
    expect(repos).toEqual([
      expect.objectContaining({
        fullName: 'acme/docs',
        sourceUrl: 'https://github.com/acme/docs.git',
        docsPath: 'docs',
      }),
    ]);
    expect(
      await h.ctx.github.repoToken(
        {
          fullName: 'acme/docs',
          installationId: null,
          sourceUrl: 'https://github.com/acme/docs.git',
        },
        'read',
      ),
    ).toBe('ghs_broker_read');
  });

  it('accepts a push the control plane forwarded and re-signed, trusting only the repository name', async () => {
    await h.db.pool.query('update repos set installation_id = null');
    const sha = 'f'.repeat(40);
    // A forwarded delivery: GitHub's body (with GitHub's installation id), re-signed with this
    // instance's GITHUB_WEBHOOK_SECRET, X-GitHub-Event and X-GitHub-Delivery preserved.
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: sha,
      deleted: false,
      repository: { full_name: 'acme/docs' },
      installation: { id: 999_999 },
    });
    const res = await webhook(h.app, body, { delivery: 'gh-delivery-1' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'queued' });
    // The payload's installation id changed nothing.
    const repos = (await admin(h.app, 'GET', '/repos')).json() as { installationId: unknown }[];
    expect(repos[0]!.installationId).toBeNull();
    // A push naming our installation but a repository this site does not serve is ignored.
    const other = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      deleted: false,
      repository: { full_name: 'other/repo' },
      installation: { id: 4242 },
    });
    expect((await webhook(h.app, other)).json()).toMatchObject({ status: 'ignored' });
    // The same delivery forwarded twice is a duplicate.
    expect((await webhook(h.app, body, { delivery: 'gh-delivery-1' })).json()).toMatchObject({
      status: 'duplicate',
    });
  });
});

describe('configuration', () => {
  const env = {
    DATABASE_URL: 'postgres://x/y',
    SESSION_SECRET: 's'.repeat(32),
  };

  it('reads the broker and the OIDC icon', () => {
    const config = loadConfig({
      ...env,
      OPEND_GITHUB_BROKER_URL: 'https://control.example/broker/v1',
      OPEND_GITHUB_BROKER_SECRET: 'b'.repeat(32),
      OPEND_GITHUB_INSTALL_URL: 'https://github.com/apps/opend/installations/new',
      OIDC_ISSUER: 'https://control.example',
      OIDC_CLIENT_ID: 'tenant',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_DISPLAY_NAME: 'GitHub',
    });
    expect(config.broker).toEqual({
      url: 'https://control.example/broker/v1',
      secret: 'b'.repeat(32),
      installUrl: 'https://github.com/apps/opend/installations/new',
    });
    expect(config.oidc?.icon).toBe('github');
    expect(
      loadConfig({
        ...env,
        OIDC_ISSUER: 'https://idp.example',
        OIDC_CLIENT_ID: 'x',
        OIDC_CLIENT_SECRET: 'y',
        OIDC_ICON: 'github',
      }).oidc?.icon,
    ).toBe('github');
  });

  it('refuses a broker without its secret, or alongside an own GitHub App', () => {
    expect(() =>
      loadConfig({ ...env, OPEND_GITHUB_BROKER_URL: 'https://control.example/broker/v1' }),
    ).toThrow(/OPEND_GITHUB_BROKER_SECRET/);
    expect(() =>
      loadConfig({
        ...env,
        OPEND_GITHUB_BROKER_URL: 'https://control.example/broker/v1',
        OPEND_GITHUB_BROKER_SECRET: 'b'.repeat(32),
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'k',
      }),
    ).toThrow(/not both/);
    expect(() => loadConfig({ ...env, OPEND_SECRET_KEY: 'short' })).toThrow(/OPEND_SECRET_KEY/);
  });
});
