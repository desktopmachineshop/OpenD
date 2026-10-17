import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReaderContext } from '@opend/model';
import { FakeGitHub } from '@opend/editor';
import type { PdfRenderer } from '@opend/pdf';
import { FsBlobStore, testDatabaseUrl } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { MARKERS } from '../../cli/test/markers.js';
import { applySeed } from '../src/index.js';
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

const SEED = `
orgs:
  - slug: acme
    name: Acme
    entitlements: { products: [widget], version: "1.4" }
    readers: [ann@acme.example]
  - slug: globex
    name: Globex
    entitlements: { products: [widget, gadget], features: [sso, audit-log], version: "2.1" }
    readers: [{ email: gus@globex.example, name: Gus }]
  - slug: gadgetco
    name: Gadget Co
    entitlements: { products: [gadget], version: "2.0" }
    readers: [gia@gadget.example]
  - slug: newco
    name: Newco
    readers: [nia@newco.example]
  - slug: docs-team
    name: Docs team
    readers: [{ email: owner@docs.example, name: Olive Owner, staff: true }]
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

const PUBLIC: ReaderContext = { products: ['widget'], features: [], version: '2.1' };
const CONTEXTS: Record<string, ReaderContext> = {
  ann: { products: ['widget'], features: [], version: '1.4' },
  gus: { products: ['widget', 'gadget'], features: ['sso', 'audit-log'], version: '2.1' },
  gia: { products: ['gadget'], features: [], version: '2.0' },
};
/** Visible to a reader with no products or features, on any release: not gated at all. */
const ungated = (rule: (c: ReaderContext) => boolean) =>
  ['1.0', '2.0', '3.0'].every((version) => rule({ products: [], features: [], version }));

describe.skipIf(!url)('public and private sites, sign-in and staff', () => {
  let h: Harness;
  let docs: DocsRepo;
  const gh = new FakeGitHub();
  const printed: string[] = [];
  const pdf: PdfRenderer = {
    render: async (html) => {
      printed.push(html);
      return Buffer.from(`%PDF-1.7 ${html.length}`);
    },
    close: async () => {},
  };
  const worker = () =>
    processNext({ pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} });
  const get = (path: string, cookie = '') =>
    h.app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });
  const post = (path: string, form: Record<string, string>, cookie = '') =>
    h.app.inject({
      method: 'POST',
      url: path,
      payload: new URLSearchParams(form).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie } : {}),
      },
    });
  const pages = async (cookie = '') =>
    (await Promise.all(TOPICS.map((t) => get(`/${t}.html`, cookie)))).map((p) => p.body).join('\n');
  const setAccess = (body: object) => admin(h.app, 'PUT', '/repos/1/access', body);
  const csrfOf = (res: LightMyRequestResponse) =>
    /name="_csrf" value="([^"]+)"/.exec(res.body)?.[1] ?? '';
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    h = await startHarness(url!, {
      pdf,
      githubFetch: gh.fetch,
      config: {
        githubOAuth: {
          clientId: 'Iv1.docs',
          clientSecret: 'github-secret',
          webUrl: gh.webUrl,
          apiUrl: gh.apiUrl,
          collaboratorOrg: 'docs-team',
          collaboratorStaff: true,
        },
        github: { appId: '1', privateKey, apiUrl: gh.apiUrl },
        editorUrl: 'http://editor.test',
        sourceLinks: true,
      },
    });
    gh.createRepo('acme/docs', { 'README.md': 'docs' });
    gh.setCollaborator('acme/docs', 'octo-owner', 'admin');
    gh.setCollaborator('acme/docs', 'octo-reader', 'read');
    docs = createDocsRepo(STARTER);
    const pairing = readFileSync(join(STARTER, 'topics/gadget-pairing.dita'), 'utf8');
    const main = docs.commit({
      'opend.config.yaml': `${readFileSync(join(STARTER, 'opend.config.yaml'), 'utf8')}logo: images/logo.svg\n`,
      'images/gadget.svg':
        '<svg xmlns="http://www.w3.org/2000/svg"><text>GADGET-ONLY-IMAGE</text></svg>',
      'topics/gadget-pairing.dita': pairing.replace(
        '<shortdesc>',
        '<prolog/><shortdesc><image href="../images/gadget.svg"><alt>Gadget</alt></image> ',
      ),
    });
    await applySeed(h.db.pool, SEED);
    expect(
      (
        await admin(h.app, 'POST', '/repos', {
          fullName: 'acme/docs',
          sourceUrl: docs.dir,
          releaseRefs: ['main', 'v*'],
        })
      ).statusCode,
    ).toBe(201);
    await webhook(h.app, pushPayload('acme/docs', 'refs/heads/main', main));
    expect(await worker()).toBe('published');
    const config = readFileSync(join(docs.dir, 'opend.config.yaml'), 'utf8');
    const v1 = docs.commit({
      'opend.config.yaml': config.replace(/^release: .*$/m, 'release: "1.4"'),
    });
    await webhook(h.app, pushPayload('acme/docs', 'refs/heads/v1', v1));
    expect(await worker()).toBe('published');
    // As if cloned from GitHub through the App (source links, collaborator checks).
    await h.db.pool.query(
      "update repos set source_url = 'https://github.com/acme/docs.git', installation_id = 7",
    );
    h.ctx.caches.releaseChanged();
    for (const [name, email] of [
      ['ann', 'ann@acme.example'],
      ['gus', 'gus@globex.example'],
      ['gia', 'gia@gadget.example'],
      ['nia', 'nia@newco.example'],
      ['owner', 'owner@docs.example'],
    ] as const)
      cookies[name] = await devLogin(h.app, email);
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  describe('private (the default)', () => {
    it.each([
      '/',
      '/topics/overview.html',
      '/search?q=widget',
      '/_logo.svg',
      '/pdf/admin-guide.pdf',
    ])('sends anonymous requests for %s to sign in', async (path) => {
      const res = await get(path);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/auth/login?returnTo=${encodeURIComponent(path)}`);
    });

    it('lists repos as private with no public entitlements', async () => {
      const repos = (await admin(h.app, 'GET', '/repos')).json() as object[];
      expect(repos[0]).toMatchObject({ access: 'private', publicEntitlements: null });
    });
  });

  describe('public without public entitlements (fail-closed)', () => {
    beforeAll(async () => {
      const res = await setAccess({ access: 'public' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ access: 'public', publicEntitlements: null });
    });

    it('serves anonymous visitors only unconditioned content', async () => {
      const home = await get('/');
      expect(String(home.headers.location ?? '')).not.toContain('/auth/login');
      const html = await pages();
      for (const [phrase, rule] of MARKERS)
        if (html.includes(phrase))
          expect({ phrase, ungated: ungated(rule) }).toMatchObject({
            ungated: true,
          });
      // Unconditioned topics are served; everything gated is not.
      const overview = await get('/topics/overview.html');
      expect(overview.statusCode).toBe(200);
      expect(overview.body).toContain('collects readings from your widgets');
      expect((await get('/topics/gadget-pairing.html')).statusCode).toBe(404);
      expect((await get('/topics/configure-sso.html')).statusCode).toBe(404);
      expect(html).not.toContain('Run the legacy installer');
      expect(html).not.toContain('Run the setup wizard');
      expect((await get('/_assets/images/gadget.svg')).statusCode).toBe(404);
    });
  });

  describe('public with public entitlements', () => {
    beforeAll(async () => {
      const res = await setAccess({ access: 'public', publicEntitlements: PUBLIC });
      expect(res.json()).toMatchObject({ access: 'public', publicEntitlements: PUBLIC });
    });

    it.each(MARKERS)('anonymous: %s', async (phrase, rule) => {
      expect((await pages()).includes(phrase)).toBe(rule(PUBLIC));
    });

    it('offers anonymous visitors "Sign in" back to the page, and nothing personal', async () => {
      const page = await get('/topics/install.html');
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('private, no-store');
      expect(page.body).toContain(
        '<a class="site-account site-signin" href="/auth/login?returnTo=%2Ftopics%2Finstall.html">Sign in</a>',
      );
      expect(page.body).toContain('<a class="site-menu-signin"');
      expect(page.body).not.toContain('action="/auth/logout"');
      expect(page.body).not.toContain('Edit this page</a>');
      expect(page.body).not.toContain('action="/_opend/feedback"');
      expect(page.body).not.toContain('<!--opend-');
      // Source links are on for this site and name only the page shown.
      expect(page.body).toContain('https://github.com/acme/docs/blob/');
      expect(page.body).toContain('/topics/install.dita"');
    });

    it('filters assets, the logo, search and PDFs for anonymous visitors', async () => {
      expect((await get('/_logo.svg')).statusCode).toBe(200);
      expect((await get('/_assets/images/logo.svg')).statusCode).toBe(200);
      expect((await get('/_assets/images/gadget.svg')).statusCode).toBe(404);
      const search = await get('/search?q=gadget');
      expect(search.statusCode).toBe(200);
      expect(search.body).not.toContain('Pair a Gadget');
      const wizard = await get('/search?q=wizard');
      expect(wizard.body).toContain('/topics/install.html');
      printed.length = 0;
      const res = await get('/pdf/admin-guide.pdf');
      expect(res.statusCode).toBe(200);
      expect(printed.join('')).not.toContain('Pair the Gadget');
    });

    it('records anonymous views without an org, and refuses anonymous feedback', async () => {
      await get('/topics/configure.html');
      await h.ctx.analytics.flush();
      const { rows } = await h.db.pool.query(
        "select org_slug from analytics_events where topic_id = 'topics/configure' and kind = 'view'",
      );
      expect(rows.some((r: { org_slug: string | null }) => r.org_slug === null)).toBe(true);
      const res = await post('/_opend/feedback', {
        topic: 'topics/configure',
        helpful: 'yes',
        _csrf: 'x',
      });
      expect(res.statusCode).toBe(401);
    });

    it('gives a signed-in reader the union with the public set on the same release line', async () => {
      // Gia holds only the Gadget on 2.0; the site's public set adds the Widget on 2.x.
      const union: ReaderContext = { ...CONTEXTS.gia!, products: ['gadget', 'widget'] };
      const html = await pages(cookies.gia);
      for (const [phrase, rule] of MARKERS)
        expect([phrase, html.includes(phrase)]).toEqual([phrase, rule(union)]);
    });

    it('keeps a reader on another release line to their own entitlements', async () => {
      const html = await pages(cookies.ann);
      for (const [phrase, rule] of MARKERS)
        expect([phrase, html.includes(phrase)]).toEqual([phrase, rule(CONTEXTS.ann!)]);
    });

    it('gives a reader whose org has no entitlements the public view', async () => {
      const html = await pages(cookies.nia);
      for (const [phrase, rule] of MARKERS)
        expect([phrase, html.includes(phrase)]).toEqual([phrase, rule(PUBLIC)]);
    });

    it('shows signed-in readers their name, "Sign out" and "Edit this page"', async () => {
      const page = await get('/topics/install.html', cookies.gus);
      expect(page.body).toContain('Signed in as </span>Gus');
      expect(page.body).toContain('Signed in as <strong>Gus</strong> (gus@globex.example)');
      expect(page.body.match(/action="\/auth\/logout"/g)).toHaveLength(2);
      expect(page.body).toContain('<a href="http://editor.test/edit?path=topics%2Finstall.dita">');
      expect(page.body).not.toContain('class="site-account site-signin"');
      // Missing and hidden pages have no edit link to give a path away.
      const hidden = await get('/topics/configure-sso.html', cookies.nia);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.body).not.toContain('configure-sso.dita');
      expect(hidden.body).not.toContain('Edit this page</a>');
    });
  });

  it('puts a reader name with replacement patterns into the page literally', async () => {
    await admin(h.app, 'POST', '/readers', {
      orgSlug: 'globex',
      email: 'dee@globex.example',
      name: "Dee $' $& $`",
    });
    const page = await get('/topics/install.html', await devLogin(h.app, 'dee@globex.example'));
    expect(page.body).toContain('Signed in as </span>Dee $&#39; $&amp; $`</span>');
    expect(page.body.match(/<!doctype html>/g)).toHaveLength(1);
  });

  describe('staff', () => {
    it('sees the unfiltered staff view of the newest line, conditions marked', async () => {
      const html = await pages(cookies.owner);
      for (const [phrase, rule] of MARKERS) {
        // Build-time filtering (internal content) still applies to staff.
        const expected = !['INTERNAL:', 'Escalation procedure', 'staff paging tool'].includes(
          phrase,
        );
        // Not on the 2.x line; and the staff view badges the Gadget heading.
        if (['Run the legacy installer', 'Release notes for 1.x', '>Gadget<'].includes(phrase))
          continue;
        expect([phrase, html.includes(phrase)]).toEqual([phrase, expected || rule(CONTEXTS.gus!)]);
      }
      expect(html).toContain('data-applies=');
      expect(html).toContain('Release 2.1');
      expect(html).toContain('(staff view)');
    });

    it('never shares cached pages between staff and readers', async () => {
      const staff = await get('/topics/gadget-pairing.html', cookies.owner);
      const reader = await get('/topics/gadget-pairing.html', cookies.gus);
      const anonymous = await get('/topics/install.html');
      expect(staff.body).toContain('data-applies=');
      expect(reader.body).not.toContain('data-applies=');
      expect(anonymous.body).not.toContain('data-applies=');
      expect([...h.ctx.caches.pages.keys()].some((k) => k.includes('|staff|'))).toBe(true);
      expect([...h.ctx.caches.pages.keys()].some((k) => k.includes('|public|'))).toBe(true);
    });

    it('cannot be granted by readers, by sync or by a session', async () => {
      const readers = (await admin(h.app, 'GET', '/readers')).json() as {
        id: number;
        email: string;
        staff: boolean;
      }[];
      const gus = readers.find((r) => r.email === 'gus@globex.example')!;
      expect(gus.staff).toBe(false);
      const asReader = await h.app.inject({
        method: 'PUT',
        url: `/admin/api/readers/${gus.id}/staff`,
        payload: { staff: true },
        headers: { cookie: cookies.gus! },
      });
      expect(asReader.statusCode).toBe(401);
      // Entitlement sync has no staff field: it is ignored, and existing staff stay staff.
      const sync = await admin(h.app, 'PUT', '/entitlements/sync', {
        orgs: [
          {
            slug: 'globex',
            name: 'Globex',
            readers: [{ email: 'gus@globex.example', name: 'Gus', staff: true }],
          },
          { slug: 'docs-team', name: 'Docs team', readers: ['owner@docs.example'] },
        ],
      });
      expect(sync.statusCode).toBe(200);
      const after = (await admin(h.app, 'GET', '/readers')).json() as typeof readers;
      expect(after.find((r) => r.email === 'gus@globex.example')!.staff).toBe(false);
      expect(after.find((r) => r.email === 'owner@docs.example')!.staff).toBe(true);
      expect((await get('/topics/gadget-pairing.html', cookies.gus)).body).not.toContain(
        'data-applies=',
      );
    });

    it('is granted and revoked through the admin API, effective at once', async () => {
      const readers = (await admin(h.app, 'GET', '/readers')).json() as {
        id: number;
        email: string;
      }[];
      const gus = readers.find((r) => r.email === 'gus@globex.example')!;
      expect(
        (await admin(h.app, 'PUT', `/readers/${gus.id}/staff`, { staff: 'yes' })).statusCode,
      ).toBe(400);
      expect((await admin(h.app, 'PUT', '/readers/99999/staff', { staff: true })).statusCode).toBe(
        404,
      );
      const grant = await admin(h.app, 'PUT', `/readers/${gus.id}/staff`, { staff: true });
      expect(grant.json()).toMatchObject({ staff: true });
      expect((await get('/topics/gadget-pairing.html', cookies.gus)).body).toContain(
        'data-applies=',
      );
      await admin(h.app, 'PUT', `/readers/${gus.id}/staff`, { staff: false });
      expect((await get('/topics/gadget-pairing.html', cookies.gus)).body).not.toContain(
        'data-applies=',
      );
      const actions = ((await admin(h.app, 'GET', '/audit')).json() as { action: string }[]).map(
        (a) => a.action,
      );
      expect(actions).toContain('reader.staff');
      expect(actions).toContain('repo.access');
    });
  });

  describe('switching modes', () => {
    it('validates the access body', async () => {
      expect((await setAccess({ access: 'open' })).statusCode).toBe(400);
      expect(
        (await setAccess({ access: 'public', publicEntitlements: { products: ['a b'] } }))
          .statusCode,
      ).toBe(400);
      expect(
        (await admin(h.app, 'PUT', '/repos/999/access', { access: 'public' })).statusCode,
      ).toBe(404);
    });

    it('drops cached anonymous pages at once when the site goes private', async () => {
      expect((await get('/topics/install.html')).statusCode).toBe(200);
      const res = await setAccess({ access: 'private' });
      expect(res.json()).toMatchObject({ access: 'private', publicEntitlements: PUBLIC });
      expect((await get('/topics/install.html')).statusCode).toBe(302);
      expect((await get('/_logo.svg')).statusCode).toBe(302);
      expect((await get('/topics/install.html', cookies.gus)).statusCode).toBe(200);
      expect((await get('/', cookies.nia)).statusCode).toBe(403);
    });

    it('drops anonymous pages when the public set changes', async () => {
      await setAccess({ access: 'public' });
      expect((await get('/topics/gadget-pairing.html')).statusCode).toBe(404);
      await setAccess({
        access: 'public',
        publicEntitlements: { products: ['widget', 'gadget'], features: [], version: '2.1' },
      });
      expect((await get('/topics/gadget-pairing.html')).statusCode).toBe(200);
      expect((await get('/_assets/images/gadget.svg')).statusCode).toBe(200);
    });

    it('picks up a change made by another replica through NOTIFY', async () => {
      expect((await get('/topics/install.html')).statusCode).toBe(200);
      await h.db.pool.query("update repos set access = 'private'");
      await h.db.pool.query("select pg_notify('opend_release_changed', '1')");
      await expect.poll(async () => (await get('/topics/install.html')).statusCode).toBe(302);
      await setAccess({ access: 'public', publicEntitlements: PUBLIC });
    });
  });

  describe('sign-in page', () => {
    it('lists GitHub and the demo readers, returning to the page', async () => {
      const res = await get('/auth/login?returnTo=%2Ftopics%2Finstall.html');
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('href="/auth/github?returnTo=%2Ftopics%2Finstall.html"');
      expect(res.body).toContain('Sign in with GitHub');
      expect(res.body).toContain('Demo readers');
      expect(res.body).toContain('name="returnTo" value="/topics/install.html"');
      // Public site: its title, and a way back without signing in.
      expect(res.body).toContain('Widget Platform Docs');
      expect(res.body).toContain('Continue without signing in');
      expect(res.body).not.toMatch(/<script|style="/);
    });

    it.each([
      'https://evil.example/',
      '//evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
    ])('never returns off-site: %s', async (returnTo) => {
      const page = await get(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
      expect(page.body).toContain('href="/auth/github?returnTo=%2F"');
      expect(page.body).toContain('name="returnTo" value="/"');
      const dev = await post('/auth/dev', { readerId: '1', returnTo });
      expect(dev.statusCode).toBe(302);
      expect(dev.headers.location).toBe('/');
      const github = await get(`/auth/github?returnTo=${encodeURIComponent(returnTo)}`);
      const authorize = new URL(String(github.headers.location));
      const code = `ret-${createHash('sha1').update(returnTo).digest('hex')}`;
      gh.addOAuthCode(code, { id: 5, login: 'nia-gh', name: null, email: 'nia@newco.example' });
      const callback = await get(
        `/auth/github/callback?code=${code}&state=${authorize.searchParams.get('state')}`,
        cookiesFrom(github),
      );
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/');
    });

    it('signs out only with a POST carrying the session token', async () => {
      const cookie = await devLogin(h.app, 'ann@acme.example');
      const ask = await get('/auth/logout', cookie);
      expect(ask.statusCode).toBe(200);
      expect(ask.headers['set-cookie']).toBeUndefined();
      expect((await post('/auth/logout', {}, cookie)).statusCode).toBe(403);
      expect((await post('/auth/logout', { _csrf: 'forged' }, cookie)).statusCode).toBe(403);
      const page = await get('/topics/overview.html', cookie);
      const out = await post('/auth/logout', { _csrf: csrfOf(page) }, cookie);
      expect(out.statusCode).toBe(200);
      expect(String(out.headers['set-cookie'])).toMatch(/opend_session=;/);
    });
  });

  describe('GitHub sign-in', () => {
    async function begin(returnTo = '/topics/install.html') {
      const res = await get(`/auth/github?returnTo=${encodeURIComponent(returnTo)}`);
      expect(res.statusCode).toBe(302);
      return { authorize: new URL(String(res.headers.location)), cookie: cookiesFrom(res) };
    }
    const callback = (code: string, state: string, cookie: string) =>
      get(`/auth/github/callback?code=${code}&state=${encodeURIComponent(state)}`, cookie);
    let n = 0;
    const user = (fields: Partial<Parameters<FakeGitHub['addOAuthCode']>[1]>) => ({
      id: 1000 + ++n,
      login: `user${n}`,
      name: null,
      email: null,
      ...fields,
    });

    it('redirects to GitHub with state, PKCE (S256) and minimal scopes', async () => {
      const { authorize, cookie } = await begin();
      expect(authorize.origin + authorize.pathname).toBe(`${gh.webUrl}/login/oauth/authorize`);
      expect(authorize.searchParams.get('client_id')).toBe('Iv1.docs');
      expect(authorize.searchParams.get('redirect_uri')).toBe(
        'http://docs.test/auth/github/callback',
      );
      expect(authorize.searchParams.get('scope')).toBe('read:user user:email');
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorize.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
      expect(authorize.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32);
      expect(cookie).toContain('opend_github=');
    });

    it('signs in a reader by verified email, with PKCE checked', async () => {
      const { authorize, cookie } = await begin();
      gh.addOAuthCode(
        'good',
        user({ email: 'gus@globex.example' }),
        authorize.searchParams.get('code_challenge')!,
      );
      const res = await callback('good', authorize.searchParams.get('state')!, cookie);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/topics/install.html');
      const page = await get('/topics/install.html', cookiesFrom(res));
      expect(page.body).toContain('Signed in as </span>Gus');
    });

    it('falls back to the public profile email when the app lacks the email permission', async () => {
      gh.noEmailPermission = true;
      try {
        const { authorize, cookie } = await begin();
        gh.addOAuthCode(
          'no-email-permission',
          user({ email: 'dee@globex.example' }),
          authorize.searchParams.get('code_challenge')!,
        );
        const res = await callback(
          'no-email-permission',
          authorize.searchParams.get('state')!,
          cookie,
        );
        expect(res.statusCode).toBe(302);
        const page = await get('/topics/install.html', cookiesFrom(res));
        expect(page.body).toContain('Sign out');
        expect(page.body).not.toContain('href="/auth/login');
        // No public email and no permission: nothing to match, so no sign-in.
        const next = await begin();
        gh.addOAuthCode(
          'no-email-at-all',
          user({ email: null }),
          next.authorize.searchParams.get('code_challenge')!,
        );
        expect(
          (
            await callback(
              'no-email-at-all',
              next.authorize.searchParams.get('state')!,
              next.cookie,
            )
          ).statusCode,
        ).toBe(403);
      } finally {
        gh.noEmailPermission = false;
      }
    });

    it('matches a secondary verified email, never an unverified one', async () => {
      let { authorize, cookie } = await begin();
      gh.addOAuthCode(
        'unverified',
        user({ email: 'ann@acme.example', verified: false }),
        authorize.searchParams.get('code_challenge')!,
      );
      expect(
        (await callback('unverified', authorize.searchParams.get('state')!, cookie)).statusCode,
      ).toBe(403);
      ({ authorize, cookie } = await begin());
      gh.addOAuthCode(
        'secondary',
        user({
          email: 'someone@personal.example',
          otherEmails: [
            { email: 'gia@unverified.example', verified: false },
            { email: 'ann@acme.example', verified: true },
          ],
        }),
        authorize.searchParams.get('code_challenge')!,
      );
      const res = await callback('secondary', authorize.searchParams.get('state')!, cookie);
      expect(res.statusCode).toBe(302);
      expect((await get('/topics/overview.html', cookiesFrom(res))).body).toContain('Release 1.4');
    });

    it('keeps a linked GitHub account on its reader when its email changes', async () => {
      const id = 777;
      let { authorize, cookie } = await begin();
      gh.addOAuthCode('link', { id, login: 'linky', name: null, email: 'gia@gadget.example' });
      expect(
        (await callback('link', authorize.searchParams.get('state')!, cookie)).statusCode,
      ).toBe(302);
      ({ authorize, cookie } = await begin());
      gh.addOAuthCode('relink', { id, login: 'linky', name: null, email: 'new@elsewhere.example' });
      const res = await callback('relink', authorize.searchParams.get('state')!, cookie);
      expect(res.statusCode).toBe(302);
      // Another GitHub account with Gia's email cannot take over her reader.
      ({ authorize, cookie } = await begin());
      gh.addOAuthCode('takeover', {
        id: 778,
        login: 'other',
        name: null,
        email: 'gia@gadget.example',
      });
      expect(
        (await callback('takeover', authorize.searchParams.get('state')!, cookie)).statusCode,
      ).toBe(403);
    });

    it('rejects a wrong state, a missing cookie, a wrong verifier and a forged code', async () => {
      const { authorize, cookie } = await begin();
      const state = authorize.searchParams.get('state')!;
      gh.addOAuthCode('s1', user({ email: 'gus@globex.example' }));
      expect((await callback('s1', 'wrong', cookie)).statusCode).toBe(400);
      gh.addOAuthCode('s2', user({ email: 'gus@globex.example' }));
      expect((await callback('s2', state, '')).statusCode).toBe(400);
      const second = await begin();
      gh.addOAuthCode('s3', user({ email: 'gus@globex.example' }), 'not-this-challenge');
      expect(
        (await callback('s3', second.authorize.searchParams.get('state')!, second.cookie))
          .statusCode,
      ).toBe(400);
      const third = await begin();
      expect(
        (await callback('forged', third.authorize.searchParams.get('state')!, third.cookie))
          .statusCode,
      ).toBe(400);
    });

    it('adds repository collaborators with push access to the configured org, as staff', async () => {
      let { authorize, cookie } = await begin();
      gh.addOAuthCode('reader', {
        id: 900,
        login: 'octo-reader',
        name: null,
        email: 'r@octo.example',
      });
      expect(
        (await callback('reader', authorize.searchParams.get('state')!, cookie)).statusCode,
      ).toBe(403);
      ({ authorize, cookie } = await begin());
      gh.addOAuthCode('stranger', {
        id: 901,
        login: 'nobody',
        name: null,
        email: 'n@octo.example',
      });
      expect(
        (await callback('stranger', authorize.searchParams.get('state')!, cookie)).statusCode,
      ).toBe(403);
      ({ authorize, cookie } = await begin());
      gh.addOAuthCode('owner', {
        id: 902,
        login: 'octo-owner',
        name: 'Octo Owner',
        email: 'octo@owner.example',
      });
      const res = await callback('owner', authorize.searchParams.get('state')!, cookie);
      expect(res.statusCode).toBe(302);
      const readers = (await admin(h.app, 'GET', '/readers')).json() as {
        email: string;
        orgSlug: string;
        staff: boolean;
      }[];
      expect(readers.find((r) => r.email === 'octo@owner.example')).toMatchObject({
        orgSlug: 'docs-team',
        staff: true,
      });
      expect(
        readers.some((r) => r.email === 'r@octo.example' || r.email === 'n@octo.example'),
      ).toBe(false);
      expect((await get('/topics/gadget-pairing.html', cookiesFrom(res))).body).toContain(
        'data-applies=',
      );
    });
  });
});
