import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPdfRenderer, type PdfRenderer } from '../src/index.js';

const executablePath = process.env.OPEND_CHROMIUM_PATH || chromium.executablePath();
const hasBrowser = existsSync(executablePath);

/** Pages in a PDF, counted from its page objects. Good enough for Chromium's output. */
function pageCount(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
}

describe.skipIf(!hasBrowser)('createPdfRenderer', () => {
  let renderer: PdfRenderer;
  let server: Server;
  let hits = 0;
  let origin = '';

  beforeAll(async () => {
    renderer = createPdfRenderer({ executablePath });
    server = createServer((_req, res) => {
      hits++;
      res.end('x');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await renderer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('prints a short document to a one-page PDF', async () => {
    const pdf = await renderer.render('<!doctype html><title>Short</title><p>Hello</p>');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(1);
  });

  it('paginates long content and reuses the browser across documents', async () => {
    const paragraphs = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i}</p>`).join('');
    const [a, b] = await Promise.all([
      renderer.render(`<!doctype html><title>Long</title><h1>Long</h1>${paragraphs}`),
      renderer.render(`<!doctype html><title>Other</title><h1>Other</h1>${paragraphs}`),
    ]);
    expect(pageCount(a)).toBeGreaterThan(1);
    expect(pageCount(b)).toBeGreaterThan(1);
  });

  it('runs no scripts and makes no network requests', async () => {
    const pdf = await renderer.render(
      `<!doctype html><title>T</title><img src="${origin}/img.png"><link rel="stylesheet" href="${origin}/x.css">` +
        `<script>fetch('${origin}/script')</script><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`,
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(hits).toBe(0);
  });

  it('relaunches after close', async () => {
    await renderer.close();
    const pdf = await renderer.render('<!doctype html><title>Again</title><p>Again</p>');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
