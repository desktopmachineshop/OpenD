import { chromium, type Browser } from 'playwright-core';

/**
 * Page set-up for one document. Its page size and margins must match the
 * document's own `@page` rule, as the running header and footer are drawn
 * in the margins.
 */
export interface PrintLayout {
  /** Paper format, e.g. `A4`, `Letter`, `Legal` or `A5`. */
  format: string;
  landscape: boolean;
  /** CSS lengths, e.g. `20mm`. */
  margin: { top: string; right: string; bottom: string; left: string };
  /** Plain text at the top of every page; empty for none. */
  headerText: string;
  /** Plain text at the foot of every page, before the page number; empty for none. */
  footerText: string;
  /** Print "page / pages" at the foot of every page. */
  pageNumbers: boolean;
}

/** The layout used when a document gives none: A4, the document title as the header, page numbers. */
export const DEFAULT_LAYOUT: PrintLayout = {
  format: 'A4',
  landscape: false,
  margin: { top: '20mm', right: '18mm', bottom: '18mm', left: '18mm' },
  headerText: '',
  footerText: '',
  pageNumbers: true,
};

/** Prints self-contained HTML documents to PDF. */
export interface PdfRenderer {
  /**
   * Renders one document. It must be self-contained: scripts are disabled and
   * every network request is refused, so images must be inlined as data URIs.
   * Without a layout, the document `<title>` is printed in the page header.
   */
  render(html: string, layout?: PrintLayout): Promise<Buffer>;
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

const escape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Chromium draws these in the page margins; they cannot use the document's styles. */
const RUNNING_STYLE = 'width:100%;font:8px system-ui,sans-serif;color:#6b7280;';

/** The running header and footer templates for a layout. `null` header: the document title. */
export function runningTemplates(layout: PrintLayout | null): { header: string; footer: string } {
  const l = layout ?? DEFAULT_LAYOUT;
  const side = `margin:0 ${l.margin.right} 0 ${l.margin.left};`;
  const headerText = layout ? escape(l.headerText) : '<span class="title"></span>';
  const header = `<div style="${RUNNING_STYLE}${side}">${headerText}</div>`;
  const numbers = l.pageNumbers
    ? '<span class="pageNumber"></span> / <span class="totalPages"></span>'
    : '';
  const footer = `<div style="${RUNNING_STYLE}${side}display:flex;justify-content:space-between;gap:12px;"><span>${escape(l.footerText)}</span><span>${numbers}</span></div>`;
  return { header, footer };
}

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
    async render(html, layout) {
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
          const l = layout ?? DEFAULT_LAYOUT;
          const running = runningTemplates(layout ?? null);
          return await page.pdf({
            format: l.format,
            landscape: l.landscape,
            preferCSSPageSize: true,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: running.header,
            footerTemplate: running.footer,
            margin: l.margin,
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
