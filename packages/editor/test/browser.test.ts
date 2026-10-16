import { existsSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEditorSession, testDatabaseUrl, upsertEditorUser } from '@opend/store';
import { EDITOR_COOKIE } from '../src/index.js';
import { REPO, startEditor, type Harness } from './helpers.js';

/** The editor page in a real browser: live preview while typing, save, and no CSP violations. */
const url = testDatabaseUrl();
const hasBrowser = existsSync(chromium.executablePath());

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe.skipIf(!url || !hasBrowser)('web editor in a browser', () => {
  let h: Harness;
  let browser: Browser;
  let origin: string;

  beforeAll(async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    h = await startEditor(url!, { config: { publicUrl: origin } });
    await h.app.listen({ port, host: '127.0.0.1' });
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('previews while typing and saves without a reload', async () => {
    const user = await upsertEditorUser(h.db.pool, {
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    });
    const session = await createEditorSession(h.db.pool, user.id, 'oidc', 1);
    const context = await browser.newContext();
    await context.addCookies([
      { name: EDITOR_COOKIE, value: h.app.signCookie(session.id), url: origin, httpOnly: true },
    ]);
    const page = await context.newPage();
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
    });
    await page.goto(`${origin}/edit?path=topics/install.dita`);
    const source = page.locator('#ed-source');
    await expect.poll(() => source.inputValue()).toContain('<task id="install">');
    const text = await source.inputValue();
    await source.fill(text.replace('<shortdesc>', '<shortdesc>BROWSER-MARKER '));
    const frame = page.frameLocator('#ed-preview');
    await expect
      .poll(() => frame.locator('body').innerText(), { timeout: 10_000 })
      .toContain('BROWSER-MARKER');
    await expect
      .poll(() => page.locator('#ed-diagnostics').innerText())
      .toContain('No problems found.');

    await page.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() => page.locator('#ed-save-status').innerText(), { timeout: 10_000 })
      .toMatch(/Saved as [0-9a-f]{7}/);
    const branch = await page.locator('input[name="branch"]').inputValue();
    expect(branch).toMatch(/^editor\/1\//);
    expect(h.gh.readFile(REPO, branch, 'topics/install.dita')).toContain('BROWSER-MARKER');

    // A broken edit shows diagnostics live, and the save is refused.
    await source.fill('<task id="install"><title>Broken</task>');
    await expect
      .poll(() => page.locator('#ed-diagnostics').innerText(), { timeout: 10_000 })
      .toContain('xml-syntax');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() => page.locator('#ed-save-status').innerText())
      .toContain('not well-formed');
    expect(violations).toEqual([]);
    await context.close();
  });
});
