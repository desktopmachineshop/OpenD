import { watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { posix } from 'node:path';
import { findPublication, formatDiagnostic, type Diagnostic } from '@opend/model';
import { searchView, viewRelease } from '@opend/filter';
import { readSourceFile } from '@opend/build';
import { frameScript, widgetScript } from '@opend/embed';
import { createPdfRenderer, type PdfRenderer } from '@opend/pdf';
import { helpLab } from './help-lab.js';
import { previewPublicationHtml, publicationsIndex, visiblePublications } from './publications.js';
import {
  escapeHtml,
  pageHref,
  publicationHref,
  renderIndex,
  renderNotFound,
  renderPage,
  renderSearch,
  siteSearchQuery,
  handleEmbedRequest,
  type EmbedOptions,
  type PageOptions,
} from '@opend/render-html';
import {
  describeAudience,
  loadProject,
  policiesFor,
  type LoadedProject,
  type PreviewAudience,
} from './project.js';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

const AUDIENCE_COOKIE = 'opend-as';
/** Same as the hosted search page. */
const PREVIEW_SEARCH_LIMIT = 20;
const IGNORED_WATCH = /(^|[\\/])(\.git|node_modules|\.opend|dist)([\\/]|$)/;

export interface PreviewOptions {
  dir: string;
  ref?: string;
  /**
   * Audience from the command line, or a function choosing it once the project
   * is loaded. The banner can switch to any named context.
   */
  audience: PreviewAudience | ((project: LoadedProject) => PreviewAudience);
  port?: number;
  host?: string;
  watch?: boolean;
  onRebuild?(project: LoadedProject, ms: number): void;
  /** Prints `/pdf/*.pdf`. Default: headless Chromium, launched on the first request. */
  pdf?: PdfRenderer;
}

export interface PreviewServer {
  server: Server;
  url: string;
  audience: PreviewAudience;
  project(): LoadedProject;
  rebuild(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Local previewer: builds the docs tree, serves it with the same filter and
 * renderer as hosted delivery, and rebuilds on save. It only binds to
 * localhost by default and never contacts any service.
 */
export async function startPreview(options: PreviewOptions): Promise<PreviewServer> {
  let project = await loadProject(options.dir, options.ref);
  const defaultAudience =
    typeof options.audience === 'function' ? options.audience(project) : options.audience;
  const clients = new Set<ServerResponse>();
  let ownPdf: PdfRenderer | undefined;
  const pdfRenderer = () => options.pdf ?? (ownPdf ??= createPdfRenderer());

  const rebuild = async () => {
    const started = Date.now();
    project = await loadProject(options.dir, options.ref);
    options.onRebuild?.(project, Date.now() - started);
    for (const res of clients) res.write('data: reload\n\n');
  };

  const audienceFor = (req: IncomingMessage): PreviewAudience => {
    const chosen = readCookie(req, AUDIENCE_COOKIE);
    if (chosen === 'all') return { kind: 'all' };
    if (chosen && chosen !== 'cli' && project.contexts[chosen]) {
      return { kind: 'named', name: chosen, context: project.contexts[chosen] };
    }
    return defaultAudience;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Preview error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    // Switching audience from the banner sets a cookie and returns to the page.
    const as = url.searchParams.get('as');
    if (as !== null) {
      // A search keeps its query, so authors can compare results across audiences.
      const q = url.searchParams.get('q');
      res.writeHead(303, {
        'set-cookie': `${AUDIENCE_COOKIE}=${encodeURIComponent(as)}; Path=/; SameSite=Lax`,
        location: path === '/search' && q ? `/search?q=${encodeURIComponent(q)}` : url.pathname,
      });
      res.end();
      return;
    }

    if (path === '/_opend/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/_opend/diagnostics.json') {
      send(res, 200, 'application/json', JSON.stringify(allDiagnostics(project), null, 2));
      return;
    }

    const release = project.build.release;
    if (!release) {
      send(res, 500, 'text/html; charset=utf-8', errorPage(project));
      return;
    }

    if (path === '/_theme.css' && release.theme) {
      await sendFile(res, project, release.theme);
      return;
    }
    if (path.startsWith('/_assets/')) {
      const asset = path.slice('/_assets/'.length);
      // Only files the content references are served, never sources or config.
      if (release.assets.includes(asset)) await sendFile(res, project, asset);
      else send(res, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }

    const audience = audienceFor(req);
    const policies = [...project.build.buildPolicies, ...policiesFor(audience)];
    const view = viewRelease(release, policies, {
      resolveChoices: audience.kind !== 'all',
    });
    const pageOptions: PageOptions = {
      showConditions: audience.kind === 'all',
      banner: banner(project, audience, path === '/search' ? url.searchParams.get('q') : null),
      bodyEnd: options.watch === false ? '' : LIVE_RELOAD,
      search: { action: '/search' },
      publications: visiblePublications(release, policies).map((p) => ({
        title: p.title || p.file,
        href: publicationHref(p),
      })),
    };
    if (release.theme) pageOptions.themeHref = '/_theme.css';

    if (path === '/embed/frame.js' || path === '/embed/opend-help.js') {
      send(
        res,
        200,
        'text/javascript; charset=utf-8',
        path === '/embed/frame.js' ? frameScript() : widgetScript(),
      );
      return;
    }
    if (path.startsWith('/embed/')) {
      // The previewer only lets its own help lab embed it.
      const self = `http://${req.headers.host ?? 'localhost'}`;
      const embed: EmbedOptions = {
        showConditions: audience.kind === 'all',
        hostOrigin: url.searchParams.get('host') === self ? self : null,
      };
      const app = url.searchParams.get('app');
      if (app) embed.app = app;
      if (release.theme) embed.themeHref = '/_theme.css';
      const result = handleEmbedRequest(view, path, url.searchParams, embed);
      if (result.location) {
        res.writeHead(result.status, { location: result.location, 'cache-control': 'no-store' });
        res.end();
      } else send(res, result.status, 'text/html; charset=utf-8', result.html);
      return;
    }
    if (path === '/_opend/publications') {
      send(
        res,
        200,
        'text/html; charset=utf-8',
        publicationsIndex(release, policies, describeAudience(audience)),
      );
      return;
    }
    const pdf = /^\/pdf\/([^/]+)\.(pdf|html)$/.exec(path);
    if (pdf) {
      // Print HTML (`.html`) shows authors the print layout without a browser.
      const [, slug = '', format] = pdf;
      const publication = findPublication(release.publications, slug);
      const html =
        publication &&
        (await previewPublicationHtml(
          project,
          release,
          publication,
          audience,
          policies,
          `http://${req.headers.host ?? 'localhost'}/`,
        ));
      if (!html) send(res, 404, 'text/plain; charset=utf-8', 'Not found');
      else if (format === 'html') send(res, 200, 'text/html; charset=utf-8', html);
      else {
        const body = await pdfRenderer().render(html);
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="${slug.replace(/[^\w.-]/g, '_')}.pdf"`,
          'cache-control': 'no-store',
        });
        res.end(body);
      }
      return;
    }
    if (path === '/_opend/help-lab') {
      send(
        res,
        200,
        'text/html; charset=utf-8',
        helpLab(
          view,
          audience,
          `http://${req.headers.host ?? 'localhost'}`,
          url.searchParams.get('path') ?? '',
        ),
      );
      return;
    }

    if (path === '/search') {
      // No database here: the in-memory search over the same filtered view.
      const query = siteSearchQuery(url.searchParams.get('q'));
      const hits = query ? searchView(view, query, PREVIEW_SEARCH_LIMIT) : [];
      send(
        res,
        200,
        'text/html; charset=utf-8',
        renderSearch(view, query, hits, { ...pageOptions, limit: PREVIEW_SEARCH_LIMIT }),
      );
      return;
    }
    if (path === '/' || path === '/index.html') {
      const first = view.topicIds()[0];
      if (first) {
        res.writeHead(302, { location: pageHref(first) });
        res.end();
      } else send(res, 200, 'text/html; charset=utf-8', renderIndex(view, pageOptions));
      return;
    }
    if (path.endsWith('.html')) {
      const html = renderPage(view, path.slice(1, -'.html'.length), pageOptions);
      if (html) {
        send(res, 200, 'text/html; charset=utf-8', html);
        return;
      }
    }
    send(res, 404, 'text/html; charset=utf-8', renderNotFound(view, pageOptions));
  }

  let watcher: FSWatcher | undefined;
  if (options.watch !== false && !options.ref) {
    let timer: NodeJS.Timeout | undefined;
    watcher = watch(project.root, { recursive: true }, (_event, file) => {
      if (file && IGNORED_WATCH.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void rebuild(), 120);
    });
  }

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4000, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    server,
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`,
    audience: defaultAudience,
    project: () => project,
    rebuild,
    close: async () => {
      watcher?.close();
      await ownPdf?.close();
      for (const res of clients) res.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function sendFile(res: ServerResponse, project: LoadedProject, path: string) {
  try {
    const body = await readSourceFile(project.root, path, project.ref);
    send(
      res,
      200,
      CONTENT_TYPES[posix.extname(path).toLowerCase()] ?? 'application/octet-stream',
      body,
    );
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function allDiagnostics(project: LoadedProject): Diagnostic[] {
  return [...project.diagnostics, ...project.contextDiagnostics];
}

function diagnosticsList(diagnostics: Diagnostic[]): string {
  return `<ul>${diagnostics
    .map((d) => `<li class="diag-${d.severity}">${escapeHtml(formatDiagnostic(d))}</li>`)
    .join('')}</ul>`;
}

/** `searchQuery` is carried through an audience switch on the search page. */
function banner(
  project: LoadedProject,
  audience: PreviewAudience,
  searchQuery: string | null = null,
): string {
  const diagnostics = allDiagnostics(project);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  const current =
    audience.kind === 'named' ? audience.name : audience.kind === 'all' ? 'all' : 'cli';
  const option = (value: string, label: string) =>
    `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const choices = [
    audience.kind === 'inline' ? option('cli', 'Command line context') : '',
    option('all', 'Everything (staff view)'),
    ...Object.keys(project.contexts).map((name) => option(name, name)),
  ].join('');
  const summary = diagnostics.length
    ? `<details><summary>${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}</summary>${diagnosticsList(diagnostics)}</details>`
    : '<span>No problems found</span>';
  return `<div class="opend-preview-banner" role="region" aria-label="Preview">
<style>
.opend-preview-banner{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:8px 16px;font:13px/1.5 var(--opend-font);background:var(--opend-surface-alt);border-bottom:1px solid var(--opend-border)}
.opend-preview-banner form{margin:0}.opend-preview-banner details ul{margin:6px 0;padding-left:18px;font-family:var(--opend-mono)}
.opend-preview-banner .diag-error{color:#dc2626}.opend-preview-banner .diag-warning{color:var(--opend-warn)}
</style>
<strong>Local preview${project.ref ? ` of ${escapeHtml(project.ref)}` : ''}</strong>
<form method="get">${searchQuery ? `<input type="hidden" name="q" value="${escapeHtml(searchQuery)}">` : ''}<label>Preview as <select name="as" onchange="this.form.submit()">${choices}</select></label><noscript><button>Apply</button></noscript></form>
<span>${escapeHtml(describeAudience(audience))}</span>
<a href="/_opend/publications">Publications</a>
${summary}
</div>`;
}

function errorPage(project: LoadedProject): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Build failed</title></head>
<body style="font:15px/1.5 system-ui,sans-serif;margin:24px"><h1>Build failed</h1>${diagnosticsList(allDiagnostics(project))}${LIVE_RELOAD}</body></html>`;
}

const LIVE_RELOAD = `<script>
(() => {
  const events = new EventSource('/_opend/events');
  events.onmessage = (e) => { if (e.data === 'reload') location.reload(); };
})();
</script>`;
