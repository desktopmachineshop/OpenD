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

// Release lines by minor version, how the version picker composes with them,
// and the public help context links.

const SEED = `
orgs:
  - slug: mid
    name: Mid
    entitlements: { products: [widget], version: "0.22" }
    readers: [mia@mid.example]
  - slug: globex
    name: Globex
    entitlements: { products: [widget, gadget], features: [sso, audit-log], version: "0.23.0" }
    readers: [gus@globex.example]
  - slug: future
    name: Future
    entitlements: { products: [widget], version: "0.24" }
    readers: [fay@future.example]
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

describe.skipIf(!url)('release lines by minor version', () => {
  let h: Harness;
  let docs: DocsRepo;
  const shas: Record<string, string> = {};
  const worker = () =>
    processNext({ pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} });
  const get = (path: string, cookie = '') =>
    h.app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });
  const live = async () =>
    (
      (await admin(h.app, 'GET', '/repos/1/releases')).json() as {
        releaseLine: string;
        release: string;
      }[]
    ).map((r) => [r.releaseLine, r.release]);
  const build = async (line: string) => {
    const ref = `docs/${line}`;
    expect(
      (await admin(h.app, 'POST', '/repos/1/builds', { ref, sha: shas[line]! })).statusCode,
    ).toBe(202);
    expect(await worker()).toBe('published');
  };
  /** Each build has its own site title, so a page tells which build served it. */
  const builtFrom = (html: string) => /Widget Docs (0\.\d+)/.exec(html)?.[1];
  /** Follows a version picker link and returns the cookie it sets. */
  const choose = async (version: string, cookie = '') => {
    const res = await get(`/_version?v=${version}&returnTo=%2Ftopics%2Foverview.html`, cookie);
    expect(res.statusCode).toBe(303);
    const set = String(res.headers['set-cookie'] ?? '').split(';')[0]!;
    return [cookie, set].filter(Boolean).join('; ');
  };

  beforeAll(async () => {
    h = await startHarness(url!);
    docs = createDocsRepo(STARTER);
    const config = readFileSync(join(STARTER, 'opend.config.yaml'), 'utf8');
    for (const [line, release] of [
      ['0.21', '0.21.4'],
      ['0.22', '0.22.1'],
      ['0.23', '0.23.0'],
    ])
      shas[line] = docs.commit({
        'opend.config.yaml': config
          .replace(/^release: .*$/m, `release: "${release}"`)
          .replace(/^title: .*$/m, `title: Widget Docs ${line}`),
      });
    await applySeed(h.db.pool, SEED);
    const res = await admin(h.app, 'POST', '/repos', {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['docs/*'],
    });
    expect(res.json()).toMatchObject({ releaseLines: 'major' });
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('keeps one live release for all of 0.x by default', async () => {
    for (const line of ['0.21', '0.22', '0.23']) await build(line);
    expect(await live()).toEqual([['0', '0.23.0']]);
  });

  it('switches to lines by minor version, keeping what is live and nothing else', async () => {
    expect(
      (await admin(h.app, 'PUT', '/repos/1/release-lines', { releaseLines: 'patch' })).statusCode,
    ).toBe(400);
    expect(
      (await admin(h.app, 'PUT', '/repos/9/release-lines', { releaseLines: 'minor' })).statusCode,
    ).toBe(404);
    const res = await admin(h.app, 'PUT', '/repos/1/release-lines', { releaseLines: 'minor' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 1, releaseLines: 'minor' });
    // 0.21 and 0.22 were replaced on line 0: they do not come back by themselves.
    expect(await live()).toEqual([['0.23', '0.23.0']]);
    const { rows } = await h.db.pool.query<{ release: string; release_line: string }>(
      'select release, release_line from releases order by id',
    );
    expect(rows.map((r) => [r.release, r.release_line])).toEqual([
      ['0.21.4', '0.21'],
      ['0.22.1', '0.22'],
      ['0.23.0', '0.23'],
    ]);
    // Their next builds put them back, each on its own line.
    await build('0.21');
    await build('0.22');
    expect(await live()).toEqual([
      ['0.21', '0.21.4'],
      ['0.22', '0.22.1'],
      ['0.23', '0.23.0'],
    ]);
  });

  it('serves each reader the live release of their minor line', async () => {
    const mia = await devLogin(h.app, 'mia@mid.example');
    expect(builtFrom((await get('/topics/overview.html', mia)).body)).toBe('0.22');
    const gus = await devLogin(h.app, 'gus@globex.example');
    expect(builtFrom((await get('/topics/overview.html', gus)).body)).toBe('0.23');
    // Nothing is live for 0.24: the usual answer, and no docs.
    const fay = await get('/topics/overview.html', await devLogin(h.app, 'fay@future.example'));
    expect(fay.statusCode).toBe(404);
    expect(fay.body).toContain('No documentation has been published for release 0.24.x yet.');
    expect(fay.body).not.toContain('Widget Docs');
  });

  it('lets a fixed version pick the minor line it belongs to', async () => {
    await admin(h.app, 'PUT', '/repos/1/versions', { mode: 'fixed', version: '0.21' });
    const mia = await devLogin(h.app, 'mia@mid.example');
    expect(builtFrom((await get('/topics/overview.html', mia)).body)).toBe('0.21');
    await admin(h.app, 'PUT', '/repos/1/versions', { mode: 'off' });
    expect(builtFrom((await get('/topics/overview.html', mia)).body)).toBe('0.22');
  });

  it('has no public context links while the site is private', async () => {
    expect((await get('/context/console/overview')).statusCode).toBe(404);
    const gus = await devLogin(h.app, 'gus@globex.example');
    expect((await get('/context/console/overview', gus)).statusCode).toBe(404);
    expect((await get('/context/console?path=/settings', gus)).statusCode).toBe(404);
  });

  // What OpenV's release workflow does when it ships 0.23.
  describe('a public site that defaults to the newest version, with a menu', () => {
    const PUBLIC = (version: string): ReaderContext => ({
      products: ['widget'],
      features: [],
      version,
    });

    beforeAll(async () => {
      const access = await admin(h.app, 'PUT', '/repos/1/access', {
        access: 'public',
        publicEntitlements: { products: ['widget'], features: [], version: '0.23' },
      });
      expect(access.statusCode).toBe(200);
      const picker = await admin(h.app, 'PUT', '/repos/1/versions', {
        mode: 'list',
        versions: ['0.23', '0.22', '0.21'],
      });
      expect(picker.statusCode).toBe(200);
    });

    it('serves anonymous visitors the public version, with the live versions in a menu', async () => {
      const page = await get('/topics/overview.html');
      expect(page.statusCode).toBe(200);
      expect(builtFrom(page.body)).toBe('0.23');
      const menu = /<details class="site-version">.*?<\/details>/s.exec(page.body)?.[0] ?? '';
      expect(menu).toContain('<summary>Version 0.23</summary>');
      expect([...menu.matchAll(/v=([\d.]+)&/g)].map((m) => m[1])).toEqual(['0.23', '0.22', '0.21']);
    });

    it('serves the build of the chosen version’s line', async () => {
      const cookie = await choose('0.21');
      const page = await get('/topics/overview.html', cookie);
      expect(builtFrom(page.body)).toBe('0.21');
      expect(page.body).toContain('<summary>Version 0.21</summary>');
      expect(builtFrom((await get('/topics/overview.html', await choose('0.22'))).body)).toBe(
        '0.22',
      );
    });

    it('falls back to the public version for a version that is not listed', async () => {
      for (const v of ['0.19', '0.24', '1.0']) {
        const page = await get('/topics/overview.html', await choose(v));
        expect(builtFrom(page.body), v).toBe('0.23');
      }
    });

    it('offers only listed versions whose line is live', async () => {
      await admin(h.app, 'PUT', '/repos/1/versions', {
        mode: 'list',
        versions: ['0.24', '0.23', '0.22', '0.21'],
      });
      const menu = (await get('/topics/overview.html')).body;
      expect(menu).toContain('v=0.21&');
      expect(menu).not.toContain('0.24');
      expect(builtFrom((await get('/topics/overview.html', await choose('0.24'))).body)).toBe(
        '0.23',
      );
      // A retired line leaves the menu, and a cookie for it falls back.
      expect((await admin(h.app, 'DELETE', '/repos/1/releases/0.22')).statusCode).toBe(204);
      const cookie = await choose('0.22');
      const page = await get('/topics/overview.html', cookie);
      expect(builtFrom(page.body)).toBe('0.23');
      expect(page.body).not.toContain('v=0.22&');
      await build('0.22');
      expect(builtFrom((await get('/topics/overview.html', cookie)).body)).toBe('0.22');
      await admin(h.app, 'PUT', '/repos/1/versions', {
        mode: 'list',
        versions: ['0.23', '0.22', '0.21'],
      });
    });

    describe.each([
      ['0.23', ''],
      ['0.21', '0.21'],
    ])('never shows more than the public set on %s', (version, chosen) => {
      let html = '';
      beforeAll(async () => {
        const cookie = chosen ? await choose(chosen) : '';
        html = (
          await Promise.all([
            ...TOPICS.map((t) => get(`/${t}.html`, cookie)),
            ...['pair', 'sso', 'installer', 'audit', 'release'].map((q) =>
              get(`/search?q=${q}`, cookie),
            ),
          ])
        )
          .map((p) => p.body)
          .join('\n');
      });
      it.each(MARKERS)('%s', (phrase, rule) => {
        expect(html.includes(phrase)).toBe(rule(PUBLIC(version)));
      });
    });

    it('redirects help context links to the topic anonymous visitors see', async () => {
      const ctx = async (path: string, cookie = '') => {
        const res = await get(path, cookie);
        return res.statusCode === 302 ? res.headers.location : res.statusCode;
      };
      // settings.sso is gated on the sso feature: it falls back to its parent.
      expect(await ctx('/context/console/settings.sso')).toBe('/topics/configure.html');
      expect(await ctx('/context/console?path=/settings/sso')).toBe('/topics/configure.html');
      expect(await ctx('/context/console/setup.install')).toBe('/topics/install.html');
      // devices.gadget points at a Gadget-only topic: never that, the app default instead.
      expect(await ctx('/context/console/devices.gadget')).toBe('/topics/overview.html');
      expect(await ctx('/context/console')).toBe('/topics/overview.html');
      expect(await ctx('/context/nope/overview')).toBe(404);
      expect(await ctx('/context/__proto__/overview')).toBe(404);
      // A signed-in reader with sso still gets the public view's answer.
      const gus = await devLogin(h.app, 'gus@globex.example');
      expect(await ctx('/context/console/settings.sso', gus)).toBe('/topics/configure.html');
      // At the version the request is served.
      expect(await ctx('/context/console/settings.sso', await choose('0.21'))).toBe(
        '/topics/configure.html',
      );
    });
  });

  it('merges lines, newest build first, when switching back to major lines', async () => {
    await admin(h.app, 'PUT', '/repos/1/release-lines', { releaseLines: 'major' });
    // 0.22 was rebuilt last.
    expect(await live()).toEqual([['0', '0.22.1']]);
    // Every listed version is on line 0 now.
    expect(builtFrom((await get('/topics/overview.html', await choose('0.21'))).body)).toBe('0.22');
  });

  it('sets release lines from a seed file', async () => {
    await applySeed(
      h.db.pool,
      `repos:\n  - { fullName: acme/docs, sourceUrl: ${docs.dir}, releaseRefs: ["docs/*"], releaseLines: minor }\n`,
    );
    const repos = (await admin(h.app, 'GET', '/repos')).json() as { releaseLines: string }[];
    expect(repos[0]!.releaseLines).toBe('minor');
    expect(await live()).toEqual([['0.22', '0.22.1']]);
  });
});
