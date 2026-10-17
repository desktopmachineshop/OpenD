import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ReaderContext } from '@opend/model';
import { escapeHtml } from '@opend/render-html';
import { FsBlobStore, enqueueJob, testDatabaseUrl, upsertRepo } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { MARKERS } from '../../cli/test/markers.js';
import { PAGE_HEADERS, applySeed, readerRelease } from '../src/index.js';
import { STARTER, devLogin, startHarness, type Harness } from './helpers.js';

const url = testDatabaseUrl();

const preview = parse(readFileSync(join(STARTER, 'preview-contexts.yaml'), 'utf8')) as {
  contexts: Record<string, { products?: string[]; features?: string[]; version: string }>;
};
const READERS: [string, ReaderContext][] = [
  ...Object.entries(preview.contexts).map(([name, c]): [string, ReaderContext] => [
    name,
    { products: c.products ?? [], features: c.features ?? [], version: c.version },
  ]),
  ['nobody-v2', { products: [], features: [], version: '2.1' }],
  ['sso-only-v1', { products: ['widget'], features: ['sso'], version: '1.2' }],
];
const email = (name: string) => `${name}@readers.example`;

/** Words from the leak markers and a few more that hit conditional content. */
const QUERIES = [
  ...new Set(
    MARKERS.flatMap(([phrase]) => phrase.toLowerCase().split(/[^a-z0-9.]+/)).filter(
      (w) => w.length >= 2,
    ),
  ),
  'pair',
  'sso',
  'installer',
  'audit',
  'release',
  'edition',
  'escalation',
  'internal',
];
const phraseQuery = (phrase: string) => `"${phrase.replace(/[^\p{L}\p{N}.\s-]/gu, ' ').trim()}"`;

/** The results list of a search page: hit titles, links and snippets, without the query echo. */
const hitsOf = (html: string) => /<ol class="search-hits">.*?<\/ol>/s.exec(html)?.[0] ?? '';
const hrefsOf = (html: string) =>
  [...hitsOf(html).matchAll(/<a href="\/([^"]+)\.html">/g)].map((m) => m[1]!);

describe.skipIf(!url)('site search page', () => {
  let h: Harness;
  let docs: DocsRepo;
  const cookies = new Map<string, string>();

  const get = async (path: string, reader?: string, headers: Record<string, string> = {}) => {
    const res = await h.app.inject({
      method: 'GET',
      url: path,
      headers: reader ? { cookie: cookies.get(reader)!, ...headers } : headers,
    });
    await h.ctx.analytics.flush();
    return res;
  };
  const search = (q: string, reader: string, headers: Record<string, string> = {}) =>
    get(`/search?q=${encodeURIComponent(q)}`, reader, headers);
  const searches = async () => {
    await h.ctx.analytics.flush();
    const { rows } = await h.db.pool.query<{
      surface: string;
      org_slug: string;
      release_line: string;
      query: string;
      result_count: number;
    }>(
      "select surface, org_slug, release_line, query, result_count from analytics_events where kind = 'search' order by id",
    );
    return rows;
  };

  beforeAll(async () => {
    h = await startHarness(url!);
    docs = createDocsRepo(STARTER);
    const repo = await upsertRepo(h.db.pool, {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['main', 'v*'],
    });
    await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'main', sha: docs.head() });
    const config = readFileSync(join(docs.dir, 'opend.config.yaml'), 'utf8');
    const v1 = docs.commit({
      'opend.config.yaml': config.replace(/^release: .*$/m, 'release: "1.4"'),
    });
    await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'v1', sha: v1 });
    const deps = { pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} };
    expect(await processNext(deps)).toBe('published');
    expect(await processNext(deps)).toBe('published');
    const orgs = READERS.map(
      ([name, c]) =>
        `  - slug: ${name}\n    name: ${name}\n    entitlements: ${JSON.stringify(c)}\n    readers: [${email(name)}]`,
    );
    await applySeed(h.db.pool, `orgs:\n${orgs.join('\n')}\n`);
    for (const [name] of READERS) cookies.set(name, await devLogin(h.app, email(name)));
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('shows the search box on topic pages and finds topics for the reader', async () => {
    const page = await get('/topics/install.html', 'v2-pro');
    expect(page.body).toContain(
      '<form class="site-search" role="search" method="get" action="/search">',
    );
    const res = await search('wizard', 'v2-pro');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(hrefsOf(res.body)[0]).toBe('topics/install');
    expect(hitsOf(res.body)).toContain('Install the Widget Platform');
    expect(hitsOf(res.body)).toContain('setup wizard');
    expect(res.body).toMatch(/\d+ results? for <q>wizard<\/q>/);
    expect(res.body).toContain('value="wizard"');
    expect(res.body).toContain(
      '<span class="opend-visually-hidden">Signed in as </span>v2-pro@readers.example',
    );
  });

  it('searches the release line the reader would read', async () => {
    // v1 readers get the 1.4 release, which has the legacy installer instead of the wizard.
    const v1 = await search('installer', 'v1-basic');
    expect(hrefsOf(v1.body)).toContain('topics/install');
    expect(hitsOf(v1.body)).toContain('legacy installer');
    expect(hitsOf((await search('wizard', 'v1-basic')).body)).toBe('');
    expect((await search('wizard', 'v1-basic')).body).toContain('No topics match <q>wizard</q>.');
  });

  describe.each(READERS)('leak markers through the search page: %s', (name, context) => {
    let pages: string[];
    let visible: (id: string) => boolean;
    beforeAll(async () => {
      const r = await readerRelease(h.ctx, context);
      if (typeof r === 'string') throw new Error(r);
      visible = (id) => r.view.isVisible(id);
      pages = await Promise.all(QUERIES.map(async (q) => (await search(q, name)).body));
    });

    it('links only to topics the reader can see', () => {
      const ids = pages.flatMap(hrefsOf);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(visible(id)).toBe(true);
    });

    it.each(MARKERS.filter(([phrase]) => phrase !== '>Gadget<'))('%s', async (phrase, rule) => {
      const shown = rule(context);
      const hits = pages.map(hitsOf).join('\n');
      if (!shown) expect(hits).not.toContain(escapeHtml(phrase));
      const found = await search(phraseQuery(phrase), name);
      expect(found.statusCode).toBe(200);
      if (shown) expect(hrefsOf(found.body).length).toBeGreaterThan(0);
      else {
        expect(hitsOf(found.body)).toBe('');
        expect(found.body).toContain('No topics match');
      }
    });
  });

  it('echoes the query and renders snippets escaped', async () => {
    const xss = '"><script>alert(1)</script><img src=x onerror=alert(2)> wizard';
    const res = await search(xss, 'v2-pro');
    expect(res.body).not.toMatch(/<script|<img/);
    expect(res.body).toContain(escapeHtml(xss));
    // A query cannot inject the per-request markers: the account controls appear
    // exactly once in the header and once in the menu.
    const marker = await search('<!--opend-account--><!--opend-menu-account--> wizard', 'v2-pro');
    expect(marker.body.match(/class="site-account"/g)).toHaveLength(1);
    expect(marker.body.match(/class="site-menu-account"/g)).toHaveLength(1);
    expect(marker.body).toContain('&lt;!--opend-account--&gt;');
  });

  it('handles empty, missing, repeated and overlong queries', async () => {
    for (const path of ['/search', '/search?q=', '/search?q=%20%20']) {
      const res = await get(path, 'v2-basic');
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Enter one or more words');
      expect(res.body).not.toContain('class="search-hits"');
    }
    const repeated = await get('/search?q=wizard&q=installer', 'v2-basic');
    expect(repeated.body).toContain('<q>wizard</q>');
    const long = `wizard ${'x'.repeat(500)}`;
    const res = await search(long, 'v2-basic');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`value="${long.slice(0, 200)}"`);
    expect(res.body).not.toContain(long.slice(0, 201));
  });

  it('sends the sign-in redirect when signed out, like other site pages', async () => {
    const page = await get('/topics/install.html');
    const res = await get('/search?q=wizard');
    expect(res.statusCode).toBe(page.statusCode);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `/auth/login?returnTo=${encodeURIComponent('/search?q=wizard')}`,
    );
  });

  it('is never cached: private, no-store, rendered per request and reader', async () => {
    const before = h.ctx.caches.pages.size;
    const pro = await search('single sign-on', 'v2-pro');
    const basic = await search('single sign-on', 'v2-basic');
    for (const res of [pro, basic]) {
      for (const [k, v] of Object.entries(PAGE_HEADERS)) expect(res.headers[k]).toBe(v);
    }
    expect(hrefsOf(pro.body)).toContain('topics/configure-sso');
    expect(hrefsOf(basic.body)).not.toContain('topics/configure-sso');
    expect(h.ctx.caches.pages.size).toBe(before);
    // The cached topic pages keep an empty search box, whatever was searched before.
    expect((await get('/topics/install.html', 'v2-pro')).body).toContain('name="q" value=""');
  });

  it('records site searches, but not empty ones or with DNT', async () => {
    await h.db.pool.query('truncate analytics_events');
    const first = await search('Wizard', 'v2-pro');
    const count = hrefsOf(first.body).length;
    expect(count).toBeGreaterThan(0);
    await search('zzzz nothing', 'v1-basic');
    await search('', 'v2-pro');
    await search('wizard', 'v2-pro', { dnt: '1' });
    await search('wizard', 'v2-pro', { 'sec-gpc': '1' });
    await search(`wizard ${'y'.repeat(400)}`, 'v2-basic');
    const rows = await searches();
    expect(rows.slice(0, 2)).toEqual([
      {
        surface: 'site',
        org_slug: 'v2-pro',
        release_line: '2',
        query: 'wizard',
        result_count: count,
      },
      {
        surface: 'site',
        org_slug: 'v1-basic',
        release_line: '1',
        query: 'zzzz nothing',
        result_count: 0,
      },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[2]!.query.length).toBeLessThanOrEqual(200);
    expect(rows[2]!.org_slug).toBe('v2-basic');
  });
});
