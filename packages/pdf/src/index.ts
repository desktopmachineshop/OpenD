import { chromium, type Browser } from 'playwright-core';

/** Prints self-contained HTML documents to PDF. */
export interface PdfRenderer {
  /**
   * Renders one document. It must be self-contained: scripts are disabled and
   * every network request is refused, so images must be inlined as data URIs.
   * The document `<title>` is printed in the page header.
   */
  render(html: string): Promise<Buffer>;
  /** Closes the browser. A later `render` launches a new one. */
  close(): Promise<void>;
}

export interface PdfRendererOptions {
  /**
   * Chromium binary. Default: `OPEND_CHROMIUM_PATH`, else the browser
   * Playwright installed (`playwright-core install chromium`).
   */
  executablePath?: string;
  /**
   * Run Chromium's own sandbox. Default: `OPEND_CHROMIUM_SANDBOX=1`. Off by
   * default because unprivileged containers usually cannot create the
   * namespaces it needs; see ADR 0006 for what contains the renderer instead.
   */
  sandbox?: boolean;
  /** Documents printed at once; others wait. Default 2. */
  concurrency?: number;
  /** Per-document limit for loading and printing, in milliseconds. Default 60 s. */
  timeoutMs?: number;
}

const HEADER = `<div style="width:100%;margin:0 18mm;font:8px system-ui,sans-serif;color:#6b7280;"><span class="title"></span></div>`;
const FOOTER = `<div style="width:100%;margin:0 18mm;font:8px system-ui,sans-serif;color:#6b7280;text-align:right;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`;

/**
 * A renderer that launches one headless Chromium on first use and reuses it
 * for every document, relaunching it if it exits.
 */
export function createPdfRenderer(options: PdfRendererOptions = {}): PdfRenderer {
  const executablePath = options.executablePath ?? (process.env.OPEND_CHROMIUM_PATH || undefined);
  const sandbox = options.sandbox ?? process.env.OPEND_CHROMIUM_SANDBOX === '1';
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const timeout = options.timeoutMs ?? 60_000;

  let browser: Promise<Browser> | null = null;
  let active = 0;
  const waiting: (() => void)[] = [];

  const launch = (): Promise<Browser> => {
    if (!browser) {
      const launched = chromium.launch({
        headless: true,
        chromiumSandbox: sandbox,
        // Containers often have a tiny /dev/shm; use /tmp for shared memory instead.
        args: ['--disable-dev-shm-usage'],
        ...(executablePath ? { executablePath } : {}),
      });
      browser = launched;
      launched.then(
        (b) =>
          b.on('disconnected', () => {
            if (browser === launched) browser = null;
          }),
        () => {
          if (browser === launched) browser = null;
        },
      );
    }
    return browser;
  };

  const acquire = async () => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
  };
  const release = () => {
    active--;
    waiting.shift()?.();
  };

  return {
    async render(html) {
      await acquire();
      try {
        const context = await (await launch()).newContext({ javaScriptEnabled: false });
        try {
          // The document is self-contained: refuse every request it would make.
          await context.route('**/*', (route) =>
            route.request().url().startsWith('data:') ? route.continue() : route.abort(),
          );
          const page = await context.newPage();
          page.setDefaultTimeout(timeout);
          await page.emulateMedia({ media: 'print', colorScheme: 'light' });
          await page.setContent(html, { waitUntil: 'load', timeout });
          return await page.pdf({
            format: 'A4',
            preferCSSPageSize: true,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: HEADER,
            footerTemplate: FOOTER,
            margin: { top: '20mm', bottom: '18mm', left: '18mm', right: '18mm' },
            outline: true,
            tagged: true,
          });
        } finally {
          await context.close().catch(() => {});
        }
      } finally {
        release();
      }
    },
    async close() {
      const current = browser;
      browser = null;
      if (current) await (await current.catch(() => null))?.close();
    },
  };
}
