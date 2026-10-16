import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entitlementKey } from '@opend/model';
import type { PdfRenderer } from '@opend/pdf';
import { FsBlobStore, enqueueJob, testDatabaseUrl, upsertRepo } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { applySeed, pdfKey } from '../src/index.js';
import { STARTER, devLogin, startHarness, type Harness } from './helpers.js';

const url = testDatabaseUrl();
const hasBrowser = existsSync(process.env.OPEND_CHROMIUM_PATH || chromium.executablePath());

const SEED = `
orgs:
  - { slug: acme, name: Acme, entitlements: { products: [widget], version: "1.4" }, readers: [ann@acme.example] }
  - { slug: globex, name: Globex, entitlements: { products: [widget, gadget], features: [sso, audit-log], version: "2.1" }, readers: [gus@globex.example] }
  - { slug: umbrella, name: Umbrella, entitlements: { products: [gadget, widget], features: [audit-log, sso], version: "2.1" }, readers: [uma@umbrella.example] }
`;

/** A second publication only SSO customers see anything of; the overview (with an image) sits under it. */
const SSO_GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE bookmap PUBLIC "-//OASIS//DTD DITA BookMap//EN" "bookmap.dtd">
<bookmap>
  <booktitle><mainbooktitle>Single Sign-On Guide</mainbooktitle></booktitle>
  <keydef keys="common" href="../reuse/common.dita"/>
  <chapter href="../topics/configure-sso.dita" feature="sso">
    <topicref href="../topics/overview.dita"/>
  </chapter>
</bookmap>
`;

/** Publishes the starter (plus the SSO guide) as release 2.1 and a 1.4 branch. */
async function publish(h: Harness): Promise<DocsRepo> {
  const docs = createDocsRepo(STARTER);
  const config = readFileSync(join(docs.dir, 'opend.config.yaml'), 'utf8').replace(
    '  - maps/admin-guide.bookmap',
    '  - maps/admin-guide.bookmap\n  - maps/sso-guide.bookmap',
  );
  const main = docs.commit({ 'opend.config.yaml': config, 'maps/sso-guide.bookmap': SSO_GUIDE });
  const repo = await upsertRepo(h.db.pool, {
    fullName: 'acme/docs',
    sourceUrl: docs.dir,
    releaseRefs: ['main', 'v*'],
  });
  await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'main', sha: main });
  await enqueueJob(h.db.pool, {
    repoId: repo.id,
    ref: 'v1',
    sha: docs.commit({ 'opend.config.yaml': config.replace(/^release: .*$/m, 'release: "1.4"') }),
  });
  const deps = { pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} };
  expect(await processNext(deps)).toBe('published');
  expect(await processNext(deps)).toBe('published');
  await applySeed(h.db.pool, SEED);
  return docs;
}

describe.skipIf(!url)('PDF publications (hosted)', () => {
  let h: Harness;
  let docs: DocsRepo;
  const printed: string[] = [];
  let release: (() => void) | null = null;
  const pdf: PdfRenderer = {
    render: async (html) => {
      printed.push(html);
      // Held open while a test checks that concurrent requests share one render.
      if (release) await new Promise<void>((resolve) => (release = resolve));
      return Buffer.from(`%PDF-1.7 render ${printed.length}`);
    },
    close: async () => {},
  };
  const cookies: Record<string, string> = {};
  const get = (path: string, cookie = '') =>
    h.app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });

  beforeAll(async () => {
    h = await startHarness(url!, { pdf });
    docs = await publish(h);
    for (const email of ['ann@acme.example', 'gus@globex.example', 'uma@umbrella.example'])
      cookies[email] = await devLogin(h.app, email);
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('requires sign-in', async () => {
    const res = await get('/pdf/admin-guide.pdf');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/auth\/login/);
  });

  it('prints the publication filtered for the reader', async () => {
    const res = await get('/pdf/admin-guide.pdf', cookies['ann@acme.example']);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="admin-guide.pdf"');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toBe('%PDF-1.7 render 1');
    const html = printed[0]!;
    expect(html).toContain('<h1>Widget Platform Administrator Guide</h1>');
    expect(html).toContain('Release 1.4');
    expect(html).toContain('Run the legacy installer');
    for (const hidden of ['Configure single sign-on', 'Audit log events', 'Pair the Gadget'])
      expect(html).not.toContain(hidden);
    // Shared renders never name an organization, and site links are absolute.
    expect(html).not.toContain('Acme');
    expect(html).toContain('href="http://docs.test/topics/configure.html"');
    expect(html).toContain('--opend-accent'); // the theme, inlined
  });

  it('serves repeat requests from the blob cache', async () => {
    h.ctx.caches.releaseChanged(); // memory caches only: the PDF itself lives in the blob store
    const res = await get('/pdf/admin-guide.pdf', cookies['ann@acme.example']);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('%PDF-1.7 render 1');
    expect(printed).toHaveLength(1);
    const hash = createHash('sha256')
      .update(entitlementKey({ products: ['widget'], features: [], version: '1.4' }))
      .digest('hex');
    const files = readdirSync(join(h.blobDir, 'pdf'), { recursive: true }).map(String);
    const key = files.find((f) => f.endsWith('admin-guide.pdf'))!;
    expect(key).toMatch(new RegExp(`^\\d+/${hash}/admin-guide\\.pdf$`));
    expect(
      pdfKey(
        Number(key.split('/')[0]),
        entitlementKey({ products: ['widget'], features: [], version: '1.4' }),
        'admin-guide',
      ),
    ).toBe(`pdf/${key}`);
  });

  it('renders once for concurrent requests and shares renders across equal entitlements', async () => {
    release = () => {};
    const both = Promise.all([
      get('/pdf/admin-guide.pdf', cookies['gus@globex.example']),
      get('/pdf/admin-guide.pdf', cookies['uma@umbrella.example']),
    ]);
    // Let both requests reach the renderer before releasing it.
    for (let i = 0; i < 50 && printed.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const finish = release;
    release = null;
    finish();
    const [gus, uma] = await both;
    expect(printed).toHaveLength(2);
    expect(gus.body).toBe('%PDF-1.7 render 2');
    expect(uma.body).toBe(gus.body);
    const html = printed[1]!;
    expect(html).toContain('Configure single sign-on');
    expect(html).toContain('Audit log events');
    expect(html).not.toContain('Run the legacy installer');
  });

  it('inlines images from the blob store', async () => {
    const res = await get('/pdf/sso-guide.pdf', cookies['gus@globex.example']);
    expect(res.statusCode).toBe(200);
    expect(printed.at(-1)).toContain('src="data:image/svg+xml;base64,');
  });

  it('404s publications that are missing or have nothing visible', async () => {
    const none = await get('/pdf/sso-guide.pdf', cookies['ann@acme.example']);
    expect(none.statusCode).toBe(404);
    const missing = await get('/pdf/user-guide.pdf', cookies['ann@acme.example']);
    expect(missing.statusCode).toBe(404);
    expect(none.body).toBe(missing.body);
    expect((await get('/pdf/admin-guide.html', cookies['ann@acme.example'])).statusCode).toBe(404);
  });

  it('links each visible publication from the docs site', async () => {
    const ann = (await get('/topics/install.html', cookies['ann@acme.example'])).body;
    expect(ann).toContain('href="/pdf/admin-guide.pdf"');
    expect(ann).not.toContain('/pdf/sso-guide.pdf');
    const gus = (await get('/topics/install.html', cookies['gus@globex.example'])).body;
    expect(gus).toContain('href="/pdf/admin-guide.pdf"');
    expect(gus).toContain('href="/pdf/sso-guide.pdf"');
  });
});

describe.skipIf(!url || !hasBrowser)('PDF publications in Chromium', () => {
  let h: Harness;
  let docs: DocsRepo;

  beforeAll(async () => {
    h = await startHarness(url!);
    docs = await publish(h);
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('serves a real PDF', async () => {
    const cookie = await devLogin(h.app, 'gus@globex.example');
    const res = await h.app.inject({
      method: 'GET',
      url: '/pdf/admin-guide.pdf',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(5000);
  });
});
