import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReaderContext } from '@opend/model';
import { FsBlobStore, testDatabaseUrl } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { MARKERS } from '../../cli/test/markers.js';
import { applySeed } from '../src/index.js';
import { STARTER, admin, devLogin, startHarness, type Harness } from './helpers.js';

const url = testDatabaseUrl();

// The help JSON API's anonymous answers on a public site, the version picker
// that follows the live release lines, and a public default of `latest`.
// Embedding is not configured: the anonymous API must not need it.

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
const CONTEXT_KEYS = [
  'overview',
  'setup.install',
  'settings',
  'settings.sso',
  'settings.audit',
  'devices.gadget',
  'whats-new',
];
const SEARCHES = ['pair', 'sso', 'installer', 'audit', 'release', 'gadget', 'escalation'];

const PUBLIC = (version: string): ReaderContext => ({
  products: ['widget'],
  features: [],
  version,
});

describe.skipIf(!url)('anonymous help API and live version lines', () => {
  let h: Harness;
  let docs: DocsRepo;
  const shas: Record<string, string> = {};
  let config = '';
  const worker = () =>
    processNext({ pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} });
  const get = (path: string, headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'GET', url: path, headers });
  const commit = (line: string, release: string) =>
    (shas[line] = docs.commit({
      'opend.config.yaml': config
        .replace(/^release: .*$/m, `release: "${release}"`)
        .replace(/^title: .*$/m, `title: Widget Docs ${line}`),
    }));
  const build = async (line: string) => {
    const res = await admin(h.app, 'POST', '/repos/1/builds', {
      ref: `docs/${line}`,
      sha: shas[line]!,
    });
    expect(res.statusCode).toBe(202);
    expect(await worker()).toBe('published');
  };
  const builtFrom = (html: string) => /Widget Docs (0\.\d+)/.exec(html)?.[1];
  /** The version menu's options, in order. */
  const menu = (html: string) => {
    const details = /<details class="site-version">.*?<\/details>/s.exec(html)?.[0] ?? '';
    return [...details.matchAll(/v=([\d.]+)&/g)].map((m) => m[1]);
  };
  const choose = async (version: string) => {
    const res = await get(`/_version?v=${version}&returnTo=%2Ftopics%2Foverview.html`);
    return String(res.headers['set-cookie'] ?? '').split(';')[0]!;
  };
  /** The release line a help API answer says it came from. */
  const lineOf = async (path: string, headers: Record<string, string> = {}) => {
    const res = await get(path, headers);
    expect(res.statusCode, path).toBe(200);
    return res.headers['opend-release-line'];
  };

  beforeAll(async () => {
    h = await startHarness(url!);
    expect(h.ctx.config.embed).toBeUndefined();
    docs = createDocsRepo(STARTER);
    config = readFileSync(join(STARTER, 'opend.config.yaml'), 'utf8');
    commit('0.21', '0.21.4');
    commit('0.22', '0.22.1');
    commit('0.23', '0.23.0');
    await applySeed(
      h.db.pool,
      `orgs:
  - slug: globex
    name: Globex
    entitlements: { products: [widget, gadget], features: [sso, audit-log], version: "0.22.3" }
    readers: [gus@globex.example]
`,
    );
    const res = await admin(h.app, 'POST', '/repos', {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['docs/*'],
      releaseLines: 'minor',
    });
    expect(res.statusCode).toBe(201);
    for (const line of ['0.21', '0.22', '0.23']) await build(line);
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('answers nothing anonymously while the site is private', async () => {
    for (const path of [
      '/api/v1/help/nav',
      '/api/v1/help/context?app=console&key=overview',
      '/api/v1/help/topics/topics/overview',
      '/api/v1/help/search?q=install',
      '/api/v1/help/nav?version=0.22',
    ]) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(401);
      expect(res.headers['opend-release'], path).toBeUndefined();
      expect(res.headers['cache-control'], path).toBe('private, no-store');
      expect(res.body).not.toContain('Widget');
    }
    // Without OPEND_EMBED_SECRET no token is valid.
    expect((await get('/api/v1/help/nav', { authorization: 'Bearer x.y.z' })).statusCode).toBe(401);
  });

  it('accepts live and latest from the admin API, and nothing else', async () => {
    const bad = [
      { access: 'public', publicEntitlements: { products: [], version: 'newest' } },
      { access: 'public', publicEntitlements: { products: [], version: 'Latest' } },
    ];
    for (const body of bad)
      expect((await admin(h.app, 'PUT', '/repos/1/access', body)).statusCode).toBe(400);
    expect((await admin(h.app, 'PUT', '/repos/1/versions', { mode: 'live' })).statusCode).toBe(200);
    // Org entitlements name a real version: `latest` is the public set's only.
    expect(
      (
        await admin(h.app, 'PUT', '/orgs/globex/entitlements', {
          products: ['widget'],
          version: 'latest',
        })
      ).statusCode,
    ).toBe(400);
    const access = await admin(h.app, 'PUT', '/repos/1/access', {
      access: 'public',
      publicEntitlements: { products: ['widget'], features: [], version: 'latest' },
    });
    expect(access.statusCode).toBe(200);
    expect(access.json()).toMatchObject({
      publicEntitlements: { version: 'latest' },
      versionPicker: { mode: 'live' },
    });
  });

  it('serves the newest live line by default, with every live line in the menu', async () => {
    const root = await get('/');
    expect(root.statusCode).toBe(302);
    const page = await get(root.headers.location!);
    expect(builtFrom(page.body)).toBe('0.23');
    expect(page.body).toContain('<summary>Version 0.23</summary>');
    expect(menu(page.body)).toEqual(['0.23', '0.22', '0.21']);
    expect(
      builtFrom((await get('/topics/overview.html', { cookie: await choose('0.21') })).body),
    ).toBe('0.21');
    // A version on a live line is matched by its line; anything else falls back.
    expect(
      builtFrom((await get('/topics/overview.html', { cookie: await choose('0.22.1') })).body),
    ).toBe('0.22');
    expect(
      builtFrom((await get('/topics/overview.html', { cookie: await choose('0.19') })).body),
    ).toBe('0.23');
  });

  it('starts a signed-in reader on their own line, at their own version', async () => {
    const gus = await devLogin(h.app, 'gus@globex.example');
    const page = await get('/topics/overview.html', { cookie: gus });
    expect(builtFrom(page.body)).toBe('0.22');
    expect(page.body).toContain('<summary>Version 0.22</summary>');
    expect(menu(page.body)).toEqual(['0.23', '0.22', '0.21']);
  });

  describe('the help API, anonymously', () => {
    it('answers for the public view, cacheable, with the release it came from', async () => {
      const res = await get('/api/v1/help/nav', { origin: 'https://anywhere.example' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['opend-release']).toBe('0.23.0');
      expect(res.headers['opend-release-line']).toBe('0.23');
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(String(res.headers['access-control-expose-headers'])).toContain('OpenD-Release-Line');
      expect(String(res.headers.vary)).toContain('Authorization');
      expect(res.json()).toMatchObject({
        title: 'Widget Docs 0.23',
        release: '0.23.0',
        line: '0.23',
      });
      // Server to server: no Origin at all.
      expect(await lineOf('/api/v1/help/context?app=console&key=overview')).toBe('0.23');
    });

    it('serves an offered version, and the default for anything else', async () => {
      expect(await lineOf('/api/v1/help/nav?version=0.22')).toBe('0.22');
      expect(await lineOf('/api/v1/help/nav?version=0.22.1')).toBe('0.22');
      expect(await lineOf('/api/v1/help/topics/topics/overview?version=0.21')).toBe('0.21');
      const fallback = (await get('/api/v1/help/nav')).body;
      for (const v of ['0.19', '0.24', '1.0', 'latest', 'x', '0.22; drop', '9'.repeat(40)]) {
        const res = await get(`/api/v1/help/nav?version=${encodeURIComponent(v)}`);
        expect(res.statusCode, v).toBe(200);
        expect(res.headers['opend-release-line'], v).toBe('0.23');
        // Nothing tells a version that is not offered from one that does not exist.
        expect(res.body, v).toBe(fallback);
      }
      const twice = await get('/api/v1/help/nav?version=0.21&version=0.22');
      expect(twice.headers['opend-release-line']).toBe('0.23');
    });

    it('resolves context keys in the public view', async () => {
      const ctx = async (key: string, version = '') =>
        (
          (await get(`/api/v1/help/context?app=console&key=${key}${version}`)).json() as {
            topicId?: string;
            error?: string;
          }
        ).topicId ?? 'none';
      // settings.sso is gated on the sso feature: its parent instead.
      expect(await ctx('settings.sso')).toBe('topics/configure');
      expect(await ctx('devices.gadget')).toBe('topics/overview');
      expect(await ctx('settings.sso', '&version=0.21')).toBe('topics/configure');
      expect((await get('/api/v1/help/topics/topics/configure-sso')).statusCode).toBe(404);
    });

    it('ignores the site’s version cookie: only the version parameter counts', async () => {
      expect(await lineOf('/api/v1/help/nav', { cookie: await choose('0.21') })).toBe('0.23');
    });

    it('keeps token requests as they were: no anonymous fallback for a bad token', async () => {
      const res = await get('/api/v1/help/nav', { authorization: 'Bearer nope' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['opend-release']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('private, no-store');
      const evil = await get('/api/v1/help/nav', {
        authorization: 'Bearer nope',
        origin: 'https://evil.example',
      });
      expect(evil.statusCode).toBe(403);
    });

    describe.each([
      ['0.23', ''],
      ['0.22', '0.22'],
      ['0.21', '0.21'],
      ['0.23', '0.20'],
    ])('never answers more than the public set on %s (asked: %s)', (version, asked) => {
      let text = '';
      beforeAll(async () => {
        const v = asked ? `version=${asked}` : '';
        const paths = [
          `/api/v1/help/nav?${v}`,
          ...TOPICS.map((t) => `/api/v1/help/topics/${t}?${v}`),
          ...CONTEXT_KEYS.map((k) => `/api/v1/help/context?app=console&key=${k}&${v}`),
          ...SEARCHES.map((q) => `/api/v1/help/search?q=${q}&${v}`),
        ];
        const answers = await Promise.all(paths.map((p) => get(p)));
        for (const a of answers)
          if (a.statusCode === 200) expect(a.headers['opend-release-line']).toBe(version);
        text = answers.map((a) => a.body).join('\n');
      });
      it.each(MARKERS)('%s', (phrase, rule) => {
        expect(text.includes(phrase)).toBe(rule(PUBLIC(version)));
      });
      it('names no gated topic', () => {
        expect(text).not.toContain('topics/configure-sso');
        expect(text).not.toContain('topics/gadget-pairing');
        expect(text).not.toContain('topics/audit-log');
      });
    });
  });

  it('follows a new line as it goes live, with no admin call', async () => {
    commit('0.24', '0.24.0');
    await build('0.24');
    const page = await get('/topics/overview.html');
    expect(builtFrom(page.body)).toBe('0.24');
    expect(menu(page.body)).toEqual(['0.24', '0.23', '0.22', '0.21']);
    expect(await lineOf('/api/v1/help/nav')).toBe('0.24');
    expect(await lineOf('/api/v1/help/nav?version=0.23')).toBe('0.23');
  });

  it('drops a retired line from the menu and the API', async () => {
    expect((await admin(h.app, 'DELETE', '/repos/1/releases/0.22')).statusCode).toBe(204);
    const cookie = await choose('0.22');
    const page = await get('/topics/overview.html', { cookie });
    expect(builtFrom(page.body)).toBe('0.24');
    expect(menu(page.body)).toEqual(['0.24', '0.23', '0.21']);
    expect(await lineOf('/api/v1/help/nav?version=0.22')).toBe('0.24');
    // The reader on 0.22.3 is no longer on a live line: the newest instead.
    const gus = await devLogin(h.app, 'gus@globex.example');
    expect(builtFrom((await get('/topics/overview.html', { cookie: gus })).body)).toBe('0.24');
    // Retiring the newest line moves `latest` back.
    expect((await admin(h.app, 'DELETE', '/repos/1/releases/0.24')).statusCode).toBe(204);
    expect(builtFrom((await get('/topics/overview.html')).body)).toBe('0.23');
    expect(await lineOf('/api/v1/help/nav')).toBe('0.23');
  });

  it('honours a version only when the picker offers it', async () => {
    await admin(h.app, 'PUT', '/repos/1/versions', { mode: 'list', versions: ['0.21'] });
    expect(await lineOf('/api/v1/help/nav?version=0.21')).toBe('0.21');
    expect(await lineOf('/api/v1/help/nav?version=0.23')).toBe('0.23');
    await admin(h.app, 'PUT', '/repos/1/versions', { mode: 'off' });
    expect(await lineOf('/api/v1/help/nav?version=0.21')).toBe('0.23');
    await admin(h.app, 'PUT', '/repos/1/versions', { mode: 'fixed', version: '0.21' });
    expect(await lineOf('/api/v1/help/nav')).toBe('0.21');
    expect(await lineOf('/api/v1/help/nav?version=0.23')).toBe('0.21');
  });

  it('sets the live picker and a latest public set from a seed file', async () => {
    await applySeed(
      h.db.pool,
      `repos:
  - fullName: acme/docs
    sourceUrl: ${docs.dir}
    releaseRefs: ["docs/*"]
    access: public
    publicEntitlements: { products: [widget], version: latest }
    versionPicker: { mode: live }
`,
    );
    h.ctx.caches.releaseChanged();
    const repo = ((await admin(h.app, 'GET', '/repos')).json() as Record<string, unknown>[])[0];
    expect(repo).toMatchObject({
      versionPicker: { mode: 'live' },
      publicEntitlements: { version: 'latest' },
    });
    expect(menu((await get('/topics/overview.html')).body)).toEqual(['0.23', '0.21']);
  });

  it('answers 401 again once the site is private', async () => {
    await admin(h.app, 'PUT', '/repos/1/access', { access: 'private' });
    expect((await get('/api/v1/help/nav')).statusCode).toBe(401);
    expect((await get('/api/v1/help/search?q=install&version=0.23')).statusCode).toBe(401);
  });
});
