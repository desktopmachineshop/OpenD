import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { chromium, type Browser, type Frame, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsBlobStore, enqueueJob, testDatabaseUrl, upsertRepo } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { applySeed } from '../src/index.js';
import { STARTER, startHarness, type Harness } from './helpers.js';

/**
 * The widget in a real browser: a host app on one origin embeds help from the
 * docs server on another (localhost vs 127.0.0.1 are different sites, so the
 * help frame is third-party and its session cookie is partitioned).
 */
const url = testDatabaseUrl();
const hasBrowser = existsSync(chromium.executablePath());
const SECRET = 'browser-test-embed-secret-0123456789abcdef';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe.skipIf(!url || !hasBrowser)('embedded help widget in a browser', () => {
  let h: Harness;
  let docs: DocsRepo;
  let host: Server;
  let evil: Server;
  let browser: Browser;
  let docsUrl: string;
  let hostUrl: string;
  let evilUrl: string;

  beforeAll(async () => {
    const [docsPort, hostPort, evilPort] = await Promise.all([freePort(), freePort(), freePort()]);
    docsUrl = `http://localhost:${docsPort}`;
    hostUrl = `http://127.0.0.1:${hostPort}`;
    evilUrl = `http://127.0.0.1:${evilPort}`;

    h = await startHarness(url!, {
      config: { publicUrl: docsUrl, embed: { secret: SECRET, origins: [hostUrl] } },
    });
    docs = createDocsRepo(STARTER);
    const repo = await upsertRepo(h.db.pool, {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['main', 'v*'],
    });
    await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'main', sha: docs.head() });
    const config = readFileSync(join(docs.dir, 'opend.config.yaml'), 'utf8');
    await enqueueJob(h.db.pool, {
      repoId: repo.id,
      ref: 'v1',
      sha: docs.commit({ 'opend.config.yaml': config.replace(/^release: .*$/m, 'release: "1.4"') }),
    });
    const deps = { pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} };
    await processNext(deps);
    await processNext(deps);
    await applySeed(
      h.db.pool,
      `orgs:
  - { slug: acme, name: Acme, entitlements: { products: [widget], version: "1.4" }, readers: [ann@acme.example] }
  - { slug: globex, name: Globex, entitlements: { products: [widget, gadget], features: [sso, audit-log], version: "2.1" }, readers: [gus@globex.example] }
`,
    );
    await h.app.listen({ port: docsPort, host: '127.0.0.1' });

    // The host app: its backend mints embed tokens for the signed-in user (?user=).
    host = createServer((req, res) => {
      const u = new URL(req.url ?? '/', hostUrl);
      if (u.pathname === '/token') {
        const users: Record<string, [string, string]> = {
          gus: ['gus@globex.example', 'globex'],
          ann: ['ann@acme.example', 'acme'],
        };
        const [email, org] = users[u.searchParams.get('user') ?? ''] ?? ['nobody@x.example', 'x'];
        void new SignJWT({ email, org })
          .setProtectedHeader({ alg: 'HS256' })
          .setAudience(docsUrl)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(new TextEncoder().encode(SECRET))
          .then((t) => res.end(t));
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html><body>
<h1>Host app</h1>
<button id="before">Focus me</button>
<opend-help-button key="settings.sso"></opend-help-button>
<script src="${docsUrl}/embed/opend-help.js"></script>
<script>
  const user = new URLSearchParams(location.search).get('user');
  OpenDHelp.init({
    docsUrl: ${JSON.stringify(docsUrl)},
    app: 'console',
    getToken: () => fetch('/token?user=' + user).then((r) => r.text()),
    onNavigate: (t) => { window.lastTopic = t.topicId; },
  });
</script></body></html>`);
    });
    // A site that is not allowed to embed the help.
    evil = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<iframe id="f" src="${docsUrl}/embed/context?app=console&key=overview&host=${encodeURIComponent(hostUrl)}"></iframe>`,
      );
    });
    await Promise.all([
      new Promise<void>((r) => host.listen(hostPort, '127.0.0.1', () => r())),
      new Promise<void>((r) => evil.listen(evilPort, '127.0.0.1', () => r())),
    ]);
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => (host ? host.close(() => r()) : r()));
    await new Promise<void>((r) => (evil ? evil.close(() => r()) : r()));
    await h?.close();
    docs?.remove();
  });

  async function helpFrame(page: Page): Promise<Frame> {
    await expect
      .poll(() => page.frames().some((f) => f.url().startsWith(docsUrl)), { timeout: 10_000 })
      .toBe(true);
    return page.frames().find((f) => f.url().startsWith(docsUrl))!;
  }

  async function frameText(page: Page): Promise<string> {
    const frame = page.frames().find((f) => f.url().startsWith(docsUrl));
    return frame ? ((await frame.textContent('body').catch(() => '')) ?? '') : '';
  }

  it('opens context help, follows route changes, searches and closes', async () => {
    const page = await browser.newPage();
    await page.goto(`${hostUrl}/?user=gus`);
    await page.click('#before');
    await page.locator('opend-help-button').locator('button').click();

    // The frame asks for a token, gets a partitioned session, then shows the topic.
    await expect
      .poll(() => frameText(page), { timeout: 10_000 })
      .toContain('Configure single sign-on');
    expect(
      await page.evaluate(() =>
        (window as unknown as { OpenDHelp: { isOpen(): boolean } }).OpenDHelp.isOpen(),
      ),
    ).toBe(true);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { lastTopic?: string }).lastTopic))
      .toBe('topics/configure-sso');

    // SPA route change: the host tells the widget its new path.
    await page.evaluate(() =>
      (window as unknown as { OpenDHelp: { setContext(c: object): void } }).OpenDHelp.setContext({
        path: '/whats-new',
      }),
    );
    await expect.poll(() => frameText(page)).toContain('Release notes for 2.x');

    // Search inside the panel and open a result.
    const frame = await helpFrame(page);
    await frame.fill('input[name=q]', 'pair');
    await frame.press('input[name=q]', 'Enter');
    await expect.poll(() => frameText(page)).toContain('Pair a Gadget');
    await (await helpFrame(page)).click('.embed-hits a');
    await expect.poll(() => frameText(page)).toContain('Hold the Gadget pairing button');

    // Escape inside the frame closes the panel and returns focus to the host page.
    await (await helpFrame(page)).press('body', 'Escape');
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { OpenDHelp: { isOpen(): boolean } }).OpenDHelp.isOpen(),
        ),
      )
      .toBe(false);
    expect(await page.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe(
      'opend-help-button',
    );
    await page.close();
  });

  it('shows each reader only their help', async () => {
    const page = await browser.newPage();
    await page.goto(`${hostUrl}/?user=ann`);
    await page.locator('opend-help-button').locator('button').click();
    // Ann has no SSO: settings.sso falls back to its parent topic.
    await expect.poll(() => frameText(page), { timeout: 10_000 }).toContain('Configure the hub');
    expect(await frameText(page)).not.toContain('single sign-on');
    await page.close();
  });

  it('refuses to be framed by a site that is not allowed', async () => {
    const page = await browser.newPage();
    const blocked: string[] = [];
    page.on('console', (m) => blocked.push(m.text()));
    await page.goto(evilUrl);
    await page.waitForTimeout(1000);
    expect(await frameText(page)).not.toContain('Loading help');
    expect(blocked.join('\n')).toMatch(/frame-ancestors/);
    await page.close();
  });
});
