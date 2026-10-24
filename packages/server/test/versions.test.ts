import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReaderContext } from '@opend/model';
import type { PdfRenderer } from '@opend/pdf';
import { FsBlobStore, testDatabaseUrl } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { MARKERS } from '../../cli/test/markers.js';
import { applySeed } from '../src/index.js';
import { STARTER, admin, devLogin, startHarness, type Harness } from './helpers.js';

const url = testDatabaseUrl();

// Release lines by minor version (E3), labels, public lines and the version
// menu under /v/<line>/ (E4), and public help context links (E2).

const SEED = `
orgs:
  - slug: twenty
    name: Twenty
    entitlements: { products: [widget], version: "2.0" }
    readers: [tia@twenty.example]
  - slug: globex
    name: Globex
    entitlements: { products: [widget, gadget], features: [sso, audit-log], version: "2.1" }
    readers: [gus@globex.example]
  - slug: future
    name: Future
    entitlements: { products: [widget], version: "2.2" }
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

interface Lines {
  releaseLines: string;
  defaultLine: string | null;
  labels: Record<string, string>;
  lines: {
    line: string;
    live: boolean;
    release: string | null;
    labels: string[];
    public: boolean;
  }[];
}

describe.skipIf(!url)('release lines, public lines and the version menu', () => {
  let h: Harness;
  let docs: DocsRepo;
  const shas: Record<string, string> = {};
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
  const lines = async () => (await admin(h.app, 'GET', '/repos/1/lines')).json() as Lines;
  const live = async () =>
    (
      (await admin(h.app, 'GET', '/repos/1/releases')).json() as {
        releaseLine: string;
        release: string;
      }[]
    ).map((r) => [r.releaseLine, r.release]);
  const build = async (ref: string) => {
    expect(
      (await admin(h.app, 'POST', '/repos/1/builds', { ref, sha: shas[ref]! })).statusCode,
    ).toBe(202);
    expect(await worker()).toBe('published');
  };
  const releaseOf = (html: string) => /class="site-release">Release ([^<]+)</.exec(html)?.[1];

  beforeAll(async () => {
    h = await startHarness(url!, { pdf });
    docs = createDocsRepo(STARTER);
    const config = readFileSync(join(STARTER, 'opend.config.yaml'), 'utf8');
    const pairing = readFileSync(join(STARTER, 'topics/gadget-pairing.dita'), 'utf8');
    const release = (v: string) => config.replace(/^release: .*$/m, `release: "${v}"`);
    // A Gadget-only image, to check images under /v/ are filtered too.
    shas['docs/2.0'] = docs.commit({
      'opend.config.yaml': release('2.0'),
      'images/gadget.svg': '<svg xmlns="http://www.w3.org/2000/svg"><text>GADGET-ONLY</text></svg>',
      'topics/gadget-pairing.dita': pairing.replace(
        '<shortdesc>',
        '<prolog/><shortdesc><image href="../images/gadget.svg"><alt>Gadget</alt></image> ',
      ),
    });
    shas['main'] = docs.commit({ 'opend.config.yaml': release('2.1') });
    shas['docs/1.4'] = docs.commit({ 'opend.config.yaml': release('1.4') });
    await applySeed(h.db.pool, SEED);
    const res = await admin(h.app, 'POST', '/repos', {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['main', 'docs/*'],
    });
    expect(res.json()).toMatchObject({ releaseLines: 'major' });
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('keeps one live release per major line by default', async () => {
    await build('docs/2.0');
    await build('main');
    await build('docs/1.4');
    expect(await live()).toEqual([
      ['1', '1.4'],
      ['2', '2.1'],
    ]);
  });

  it('switches to lines by minor version, keeping what is live and nothing else', async () => {
    const bad = await admin(h.app, 'PUT', '/repos/1/release-lines', { releaseLines: 'patch' });
    expect(bad.statusCode).toBe(400);
    expect(
      (await admin(h.app, 'PUT', '/repos/9/release-lines', { releaseLines: 'minor' })).statusCode,
    ).toBe(404);
    const res = await admin(h.app, 'PUT', '/repos/1/release-lines', { releaseLines: 'minor' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Lines).releaseLines).toBe('minor');
    // 2.0 was replaced on line 2 by 2.1: it does not come back by itself.
    expect(await live()).toEqual([
      ['1.4', '1.4'],
      ['2.1', '2.1'],
    ]);
    const { rows } = await h.db.pool.query<{ release: string; release_line: string }>(
      'select release, release_line from releases order by id',
    );
    expect(rows.map((r) => [r.release, r.release_line])).toEqual([
      ['2.0', '2.0'],
      ['2.1', '2.1'],
      ['1.4', '1.4'],
    ]);
    // Its next build puts it back, on its own line.
    await build('docs/2.0');
    expect(await live()).toEqual([
      ['1.4', '1.4'],
      ['2.0', '2.0'],
      ['2.1', '2.1'],
    ]);
  });

  it('serves each reader the live release of their minor line', async () => {
    const tia = await devLogin(h.app, 'tia@twenty.example');
    expect(releaseOf((await get('/topics/overview.html', tia)).body)).toBe('2.0');
    const gus = await devLogin(h.app, 'gus@globex.example');
    expect(releaseOf((await get('/topics/overview.html', gus)).body)).toBe('2.1');
    // 2.2 is not published: the same answer as any line with nothing live.
    const fay = await get('/topics/overview.html', await devLogin(h.app, 'fay@future.example'));
    expect(fay.statusCode).toBe(404);
    expect(fay.body).toContain('No documentation has been published for release 2.2.x yet.');
    expect(fay.body).not.toContain('Widget Platform Docs');
  });

  it('labels and marks lines through the admin API', async () => {
    // Lines must be named as the repo's granularity names them.
    for (const line of ['2', '2.1.0', 'v2.1', 'latest'])
      expect(
        (await admin(h.app, 'PUT', `/repos/1/lines/${line}/label`, { label: 'latest' })).statusCode,
      ).toBe(400);
    expect(
      (await admin(h.app, 'PUT', '/repos/1/lines/2.1/label', { label: 'Not OK' })).statusCode,
    ).toBe(400);
    expect(
      (await admin(h.app, 'PUT', '/repos/1/lines/2.0/label', { label: 'latest' })).statusCode,
    ).toBe(200);
    // Each label is on one line at most: putting it on 2.1 moves it.
    await admin(h.app, 'PUT', '/repos/1/lines/2.1/label', { label: 'latest' });
    await admin(h.app, 'PUT', '/repos/1/lines/1.4/label', { label: 'stable' });
    // A line may be labelled and marked before its first build.
    await admin(h.app, 'PUT', '/repos/1/lines/2.3/label', { label: 'next' });
    await admin(h.app, 'PUT', '/repos/1/lines/1.4/public', { public: true });
    const info = await lines();
    expect(info.labels).toEqual({ latest: '2.1', next: '2.3', stable: '1.4' });
    expect(info.lines.map((l) => [l.line, l.live, l.labels, l.public])).toEqual([
      ['2.3', false, ['next'], false],
      ['2.1', true, ['latest'], false],
      ['2.0', true, [], false],
      ['1.4', true, ['stable'], false],
    ]);
    expect((await admin(h.app, 'DELETE', '/repos/1/lines/2.3/labels/next')).statusCode).toBe(204);
    expect((await admin(h.app, 'DELETE', '/repos/1/lines/2.3/labels/next')).statusCode).toBe(404);
  });

  it('has no /v/ pages, menu or context links while the site is private', async () => {
    const gus = await devLogin(h.app, 'gus@globex.example');
    const page = await get('/topics/overview.html', gus);
    expect(page.body).not.toContain('<details class="site-versions"');
    expect((await get('/v/2.1/topics/overview.html')).statusCode).toBe(302); // sign in, as any path
    expect((await get('/v/2.1/topics/overview.html', gus)).statusCode).toBe(404);
    expect((await get('/context/console/overview')).statusCode).toBe(404);
    expect((await get('/context/console/overview', gus)).statusCode).toBe(404);
  });

  describe('on a public site', () => {
    const PUBLIC_21: ReaderContext = { products: ['widget'], features: [], version: '2.1' };
    const PUBLIC_14: ReaderContext = { products: ['widget'], features: [], version: '1.4' };

    beforeAll(async () => {
      const res = await admin(h.app, 'PUT', '/repos/1/access', {
        access: 'public',
        publicEntitlements: { products: ['widget'], features: [], version: '2.1' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('lists the public lines with their labels, newest first', async () => {
      const info = await lines();
      expect(info.defaultLine).toBe('2.1');
      expect(info.lines.filter((l) => l.public).map((l) => l.line)).toEqual(['2.1', '1.4']);
      const page = (await get('/topics/overview.html')).body;
      const menu = /<details class="site-versions">.*?<\/details>/s.exec(page)?.[0] ?? '';
      expect(menu).toContain(
        '<a href="/v/2.1/topics/overview.html" aria-current="page">2.1 <span class="site-versions-label">(latest)</span></a>',
      );
      expect(menu).toContain(
        '<a href="/v/1.4/topics/overview.html">1.4 <span class="site-versions-label">(stable)</span></a>',
      );
      // 2.0 is live but not public: never listed.
      expect(menu).not.toContain('2.0');
    });

    it('links to the line home when the page is not in that line', async () => {
      const page = (await get('/topics/release-notes-2.html')).body;
      expect(page).toContain('<a href="/v/1.4/">1.4');
      expect(page).toContain('<a href="/v/2.1/topics/release-notes-2.html" aria-current="page">');
    });

    it('serves the public view of each public line under /v/<line>/', async () => {
      const v14 = await get('/v/1.4/topics/install.html');
      expect(v14.statusCode).toBe(200);
      expect(releaseOf(v14.body)).toBe('1.4');
      expect(v14.body).toContain('Run the legacy installer');
      // Links, search, assets and PDFs stay in the line.
      expect(v14.body).toContain('href="/v/1.4/topics/overview.html"');
      expect(v14.body).toContain('action="/v/1.4/search"');
      expect(v14.body).toContain('href="/v/1.4/_theme.css"');
      expect(v14.body).toContain('<a href="/v/1.4/topics/install.html" aria-current="page">1.4');
      // Only the default line's pages name / as their address.
      expect(v14.body).not.toContain('rel="canonical"');
      const v21 = await get('/v/2.1/topics/install.html');
      expect(v21.body).toContain(
        '<link rel="canonical" href="http://docs.test/topics/install.html">',
      );
      const home = await get('/v/1.4/');
      expect(home.statusCode).toBe(302);
      expect(home.headers.location).toBe('/v/1.4/topics/overview.html');
      expect((await get('/v/1.4')).headers.location).toBe('/v/1.4/');
      expect((await get('/v/1.4/_theme.css')).statusCode).toBe(200);
    });

    it('answers a line that is not public exactly as a page that does not exist', async () => {
      const hidden = await get('/v/2.0/topics/overview.html');
      const missing = await get('/v/9.9/topics/overview.html');
      expect(hidden.statusCode).toBe(404);
      // Equal but for the sign-in link's return address.
      expect(hidden.body.replaceAll('2.0', '9.9')).toBe(missing.body);
      expect(hidden.body).not.toContain('Release 2.0');
      for (const path of [
        '/v/2.0/',
        '/v/2.0',
        '/v/2.0/search?q=install',
        '/v/2.0/_theme.css',
        '/v/2.3/',
      ]) {
        const res = await get(path);
        expect(res.statusCode, path).toBe(404);
      }
      expect((await get('/v/2.0/pdf/admin-guide.pdf')).statusCode).toBe(404);
      expect((await get('/v/2.0/context/console/overview')).statusCode).toBe(404);
    });

    describe.each([
      ['anonymous', ''],
      ['signed in with more entitlements', 'gus@globex.example'],
    ])('never shows a reader’s own entitlements under /v/: %s', (_name, email) => {
      let html21 = '';
      let html14 = '';
      beforeAll(async () => {
        const cookie = email ? await devLogin(h.app, email) : '';
        const all = async (line: string) =>
          (
            await Promise.all([
              ...TOPICS.map((t) => get(`/v/${line}/${t}.html`, cookie)),
              ...['pair', 'sso', 'installer', 'audit', 'release'].map((q) =>
                get(`/v/${line}/search?q=${q}`, cookie),
              ),
            ])
          )
            .map((p) => p.body)
            .join('\n');
        html21 = await all('2.1');
        html14 = await all('1.4');
      });
      it.each(MARKERS)('%s', (phrase, rule) => {
        expect(html21.includes(phrase)).toBe(rule(PUBLIC_21));
        expect(html14.includes(phrase)).toBe(rule(PUBLIC_14));
      });
      it('never offers a hidden image, page or publication', async () => {
        const cookie = email ? await devLogin(h.app, email) : '';
        expect((await get('/v/2.1/topics/configure-sso.html', cookie)).statusCode).toBe(404);
        expect((await get('/v/2.1/_assets/images/gadget.svg', cookie)).statusCode).toBe(404);
        expect(html21).not.toContain('/v/2.0/');
      });
    });

    it('still serves a signed-in reader their own view at /', async () => {
      const gus = await devLogin(h.app, 'gus@globex.example');
      expect((await get('/topics/configure-sso.html', gus)).statusCode).toBe(200);
      expect((await get('/_assets/images/gadget.svg', gus)).statusCode).toBe(200);
    });

    it('prints a public line’s publications for that line', async () => {
      printed.length = 0;
      const res = await get('/v/1.4/pdf/admin-guide.pdf');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(printed.join('')).not.toContain('Configure single sign-on');
      expect((await get('/v/1.4/topics/overview.html')).body).toContain('href="/v/1.4/pdf/');
    });

    it('serves the latest line at / and follows the label when it moves', async () => {
      expect(releaseOf((await get('/topics/overview.html')).body)).toBe('2.1');
      await admin(h.app, 'PUT', '/repos/1/lines/1.4/label', { label: 'latest' });
      const page = await get('/topics/install.html');
      expect(releaseOf(page.body)).toBe('1.4');
      expect(page.body).toContain('Run the legacy installer');
      expect((await lines()).defaultLine).toBe('1.4');
      expect((await get('/v/1.4/topics/install.html')).body).toContain('rel="canonical"');
      expect((await get('/v/2.1/topics/install.html')).body).not.toContain('rel="canonical"');
      // A reader of another line keeps their own view, without the public set.
      const tia = await devLogin(h.app, 'tia@twenty.example');
      expect(releaseOf((await get('/topics/overview.html', tia)).body)).toBe('2.0');
      await admin(h.app, 'PUT', '/repos/1/lines/2.1/label', { label: 'latest' });
      expect(releaseOf((await get('/topics/overview.html')).body)).toBe('2.1');
    });

    it('redirects help context links to the public topic', async () => {
      const ctx = async (path: string) => {
        const res = await get(path);
        return res.statusCode === 302 ? res.headers.location : res.statusCode;
      };
      // settings.sso is gated on the sso feature: it falls back to its parent.
      expect(await ctx('/context/console/settings.sso')).toBe('/topics/configure.html');
      expect(await ctx('/context/console?path=/settings/sso')).toBe('/topics/configure.html');
      expect(await ctx('/context/console/whats-new')).toBe('/topics/release-notes-2.html');
      expect(await ctx('/v/1.4/context/console/whats-new')).toBe(
        '/v/1.4/topics/release-notes-1.html',
      );
      // devices.gadget points at a Gadget-only topic: the app default instead.
      expect(await ctx('/context/console/devices.gadget')).toBe('/topics/overview.html');
      expect(await ctx('/context/nope/overview')).toBe(404);
      expect(await ctx('/context/__proto__/overview')).toBe(404);
      // A signed-in reader with sso still gets the public view's answer.
      const gus = await devLogin(h.app, 'gus@globex.example');
      const res = await get('/context/console/settings.sso', gus);
      expect(res.headers.location).toBe('/topics/configure.html');
    });
  });

  it('clears labels and merges lines when switching back to major lines', async () => {
    await admin(h.app, 'PUT', '/repos/1/release-lines', { releaseLines: 'major' });
    // Line 2 keeps the newest build of 2.0 and 2.1: the rebuilt 2.0.
    expect(await live()).toEqual([
      ['1', '1.4'],
      ['2', '2.0'],
    ]);
    expect((await lines()).labels).toEqual({});
    expect((await get('/v/1.4/topics/overview.html')).statusCode).toBe(404);
    expect((await get('/topics/overview.html')).body).not.toContain(
      '<details class="site-versions"',
    );
  });

  it('sets release lines from a seed file', async () => {
    await applySeed(
      h.db.pool,
      `repos:\n  - { fullName: acme/docs, sourceUrl: ${docs.dir}, releaseRefs: [main, "docs/*"], releaseLines: minor }\n`,
    );
    expect((await lines()).releaseLines).toBe('minor');
  });
});
