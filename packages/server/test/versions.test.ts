import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReaderContext } from '@opend/model';
import type { PdfRenderer } from '@opend/pdf';
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

const SEED = `
orgs:
  - slug: acme
    name: Acme
    entitlements: { products: [widget], version: "1.4" }
    readers: [ann@acme.example]
  - slug: globex
    name: Globex
    entitlements: { products: [widget, gadget], features: [sso, audit-log], version: "2.1" }
    readers: [gus@globex.example]
  - slug: docs-team
    name: Docs team
    readers: [{ email: owner@docs.example, staff: true }]
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

const ANN: ReaderContext = { products: ['widget'], features: [], version: '1.4' };
const GUS: ReaderContext = {
  products: ['widget', 'gadget'],
  features: ['sso', 'audit-log'],
  version: '2.1',
};

describe.skipIf(!url)('the version picker', () => {
  let h: Harness;
  let docs: DocsRepo;
  const printed: string[] = [];
  const pdf: PdfRenderer = {
    render: async (html) => {
      printed.push(html);
      return Buffer.from('%PDF-1.7');
    },
    close: async () => {},
  };
  const cookies: Record<string, string> = {};
  const worker = () =>
    processNext({ pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} });
  const get = (path: string, cookie = '') =>
    h.app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });
  const pages = async (cookie = '') =>
    (await Promise.all(TOPICS.map((t) => get(`/${t}.html`, cookie)))).map((p) => p.body).join('\n');
  const setPicker = (body: object) => admin(h.app, 'PUT', '/repos/1/versions', body);
  /** Follows a picker link and returns the reader's cookies with the version cookie set. */
  const choose = async (cookie: string, version: string) => {
    const res = await get(`/_version?v=${version}&returnTo=%2Ftopics%2Finstall.html`, cookie);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/topics/install.html');
    const set = String(res.headers['set-cookie'] ?? '').split(';')[0]!;
    return [cookie, set].filter(Boolean).join('; ');
  };
  const expectSees = (html: string, context: ReaderContext) => {
    for (const [phrase, rule] of MARKERS)
      expect([phrase, html.includes(phrase)]).toEqual([phrase, rule(context)]);
  };

  beforeAll(async () => {
    h = await startHarness(url!, { pdf });
    docs = createDocsRepo(STARTER);
    const main = docs.commit({ 'notes.txt': 'main' });
    await applySeed(h.db.pool, SEED);
    await admin(h.app, 'POST', '/repos', {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['main', 'v*'],
    });
    await webhook(h.app, pushPayload('acme/docs', 'refs/heads/main', main));
    expect(await worker()).toBe('published');
    const config = readFileSync(join(docs.dir, 'opend.config.yaml'), 'utf8');
    const v1 = docs.commit({
      'opend.config.yaml': config.replace(/^release: .*$/m, 'release: "1.4"'),
    });
    await webhook(h.app, pushPayload('acme/docs', 'refs/heads/v1', v1));
    expect(await worker()).toBe('published');
    for (const [name, email] of [
      ['ann', 'ann@acme.example'],
      ['gus', 'gus@globex.example'],
      ['owner', 'owner@docs.example'],
    ] as const)
      cookies[name] = await devLogin(h.app, email);
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('is off by default: the release label, and each reader on their own version', async () => {
    const repos = (await admin(h.app, 'GET', '/repos')).json() as object[];
    expect(repos[0]).toMatchObject({ versionPicker: { mode: 'off' } });
    const page = await get('/topics/install.html', cookies.ann);
    expect(page.body).toContain('<span class="site-release">Release 1.4</span>');
    expect(page.body).not.toContain('<details class="site-version"');
    expect(page.body).not.toContain('<!--opend-');
    // A version cookie does nothing while the picker is off.
    expectSees(await pages(await choose(cookies.ann!, '2.1')), ANN);
  });

  it('validates the picker body', async () => {
    expect((await setPicker({ mode: 'everything' })).statusCode).toBe(400);
    expect((await setPicker({ mode: 'fixed' })).statusCode).toBe(400);
    expect((await setPicker({ mode: 'fixed', version: 'latest' })).statusCode).toBe(400);
    expect((await setPicker({ mode: 'list', versions: [] })).statusCode).toBe(400);
    expect((await setPicker({ mode: 'list', versions: ['2.1', '<b>'] })).statusCode).toBe(400);
    expect((await admin(h.app, 'PUT', '/repos/999/versions', { mode: 'reader' })).statusCode).toBe(
      404,
    );
  });

  describe('reader', () => {
    beforeAll(async () => {
      const res = await setPicker({ mode: 'reader' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ versionPicker: { mode: 'reader' } });
    });

    it('shows each reader their own version, and serves it', async () => {
      const ann = await get('/topics/install.html', cookies.ann);
      expect(ann.body).toContain('<span class="site-release">Version 1.4</span>');
      expect(ann.body).toContain('<p class="site-menu-version">1.4</p>');
      expect(ann.body).not.toContain('/_version?');
      expect((await get('/topics/install.html', cookies.gus)).body).toContain('Version 2.1');
      expectSees(await pages(await choose(cookies.ann!, '2.1')), ANN);
    });
  });

  describe('list', () => {
    beforeAll(async () => {
      const res = await setPicker({ mode: 'list', versions: ['2.0', '2.1', '1.2', '2.0'] });
      expect(res.json()).toMatchObject({
        versionPicker: { mode: 'list', versions: ['2.0', '2.1', '1.2'] },
      });
    });

    it('offers the listed versions and the reader’s own, starting on their own', async () => {
      const page = await get('/topics/install.html', cookies.ann);
      expect(page.body).toContain('<details class="site-version"><summary>Version 1.4</summary>');
      const links = [
        ...page.body.matchAll(/<ul class="site-version-list"[^>]*>(.*?)<\/ul>/g),
      ][0]![1]!;
      expect([...links.matchAll(/>([\d.]+)<\/a>/g)].map((m) => m[1])).toEqual([
        '2.1',
        '2.0',
        '1.4',
        '1.2',
      ]);
      expect(links).toContain(
        '<a href="/_version?v=1.4&amp;returnTo=%2Ftopics%2Finstall.html" aria-current="true">1.4</a>',
      );
      expect(page.body).toContain('<nav class="site-menu-versions" aria-label="Version">');
      expectSees(await pages(cookies.ann), ANN);
    });

    it('serves the chosen version with the reader’s own products and features', async () => {
      const ann = await choose(cookies.ann!, '2.1');
      expectSees(await pages(ann), { ...ANN, version: '2.1' });
      const page = await get('/topics/install.html', ann);
      expect(page.body).toContain('<summary>Version 2.1</summary>');
      // Gus, on 2.1 with the gadget, never shares Ann's cached pages.
      expectSees(await pages(cookies.gus), GUS);
      // Search and PDFs follow the chosen version too.
      expect((await get('/search?q=wizard', ann)).body).toContain('/topics/install.html');
      expect((await get('/search?q=legacy', ann)).body).not.toContain('legacy installer');
      printed.length = 0;
      expect((await get('/pdf/admin-guide.pdf', ann)).statusCode).toBe(200);
      expect(printed.join('')).toContain('Run the setup wizard');
      expect(printed.join('')).not.toContain('Run the legacy installer');
    });

    it('ignores a version the list does not offer', async () => {
      expectSees(await pages(await choose(cookies.ann!, '3.0')), ANN);
      const gus = await choose(cookies.gus!, '1.4');
      expectSees(await pages(gus), GUS);
    });

    it('clears an invalid choice and only returns to same-site paths', async () => {
      const res = await get('/_version?v=not-a-version&returnTo=//evil.example/');
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/');
      expect(String(res.headers['set-cookie'])).toMatch(/^opend_version=;/);
    });

    it('moves the staff view to the chosen line', async () => {
      const owner = await choose(cookies.owner!, '1.2');
      const notes = await get('/topics/release-notes-1.html', owner);
      expect(notes.statusCode).toBe(200);
      expect((await get('/topics/install.html', owner)).body).toContain(
        '<summary>Version 1.2</summary>',
      );
    });

    it('lets anonymous visitors of a public site choose too, but not of a private one', async () => {
      expect((await get('/topics/install.html', await choose('', '2.1'))).statusCode).toBe(302);
      await admin(h.app, 'PUT', '/repos/1/access', {
        access: 'public',
        publicEntitlements: { products: ['widget'], features: [], version: '2.1' },
      });
      const anon = await choose('', '1.2');
      expectSees(await pages(anon), { products: ['widget'], features: [], version: '1.2' });
      expectSees(await pages(), { products: ['widget'], features: [], version: '2.1' });
      await admin(h.app, 'PUT', '/repos/1/access', { access: 'private' });
    });
  });

  describe('fixed', () => {
    beforeAll(async () => {
      expect((await setPicker({ mode: 'fixed', version: '2.0' })).statusCode).toBe(200);
    });

    it('serves every reader the fixed version, whatever they chose before', async () => {
      const ann = await choose(cookies.ann!, '1.4');
      expectSees(await pages(ann), { ...ANN, version: '2.0' });
      const page = await get('/topics/install.html', ann);
      expect(page.body).toContain('<span class="site-release">Version 2.0</span>');
      expect(page.body).not.toContain('/_version?');
      expectSees(await pages(cookies.gus), { ...GUS, version: '2.0' });
    });
  });

  it('drops back to each reader’s own version when switched off', async () => {
    await setPicker({ mode: 'off' });
    expectSees(await pages(cookies.ann), ANN);
    expect((await get('/topics/install.html', cookies.ann)).body).toContain('Release 1.4');
  });
});
