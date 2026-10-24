import { posix } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ASSET_ATTR,
  logoRoute,
  publicationSlug,
  walk,
  type Publication,
  type ReaderContext,
} from '@opend/model';
import {
  compareReleaseLines,
  resolveContext,
  viewPublication,
  viewRelease,
  type PublicationView,
  type ReleaseView,
} from '@opend/filter';
import {
  pageHref,
  publicationHasContent,
  publicationHref,
  renderIndex,
  renderNotFound,
  renderPage,
  renderSearch,
  renderVersionMenu,
  siteSearchQuery,
  escapeHtml,
  type PageOptions,
} from '@opend/render-html';
import {
  assetKey,
  findRepoByName,
  getLiveReleaseId,
  getRelease,
  getReleaseLineSettings,
  listLiveReleases,
  listRepos,
  type ReaderAccess,
  type Repo,
  type StoredRelease,
} from '@opend/store';
import {
  NOTHING_GATED,
  audienceFilter,
  audienceFor,
  defaultPublicLine,
  publicAudience,
  publicLineAudience,
  readerAudience,
  type Audience,
  type LatestLine,
  type PublicLine,
} from './access.js';
import { FEEDBACK_MARKER, feedbackHtml } from './analytics.js';
import { currentAccess, redirectToLogin } from './auth.js';
import type { AppContext } from './context.js';
import {
  ACCOUNT_MARKER,
  MENU_ACCOUNT_MARKER,
  TOPIC_ACTIONS_MARKER,
  accountControls,
  messagePage,
  topicActions,
} from './pages.js';
import { pdfResponder } from './pdf.js';
import { searchRelease } from './search.js';

/** Marker in cached pages, replaced per request with the version menu of public sites. */
export const VERSIONS_MARKER = '<!--opend-versions-->';

/** Most hits on the site search page. */
export const SITE_SEARCH_LIMIT = 20;

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/** Pages are personalised and never cached by browsers or proxies. No scripts run. */
export const PAGE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy':
    "default-src 'none'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/** Author-supplied files (SVG can carry script) are sandboxed when opened directly. */
export const ASSET_HEADERS = {
  'cache-control': 'private, max-age=300',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

export interface ReaderRelease {
  stored: StoredRelease;
  view: ReleaseView;
  /** `releaseId|audienceKey`: everything rendered from this view is cached under it. */
  key: string;
  /** The release line served, e.g. `2`. */
  line: string;
  /** Who it is filtered for; see `Audience`. `audience.context` is null for the staff view. */
  audience: Audience;
}

/** The repository the site serves, cached briefly and dropped when a release or access changes. */
export async function siteRepo(ctx: AppContext): Promise<Repo | null> {
  const cached = ctx.caches.site;
  if (cached && Date.now() - cached.at < 60_000) return cached.repo;
  let repo: Repo | null;
  if (ctx.config.siteRepo) repo = await findRepoByName(ctx.pool, ctx.config.siteRepo);
  else {
    const repos = await listRepos(ctx.pool);
    repo = repos.length === 1 ? repos[0]! : null;
  }
  ctx.caches.site = { repo, at: Date.now() };
  return repo;
}

async function liveReleaseId(
  ctx: AppContext,
  repoId: number,
  line: string,
): Promise<number | null> {
  const key = `${repoId}:${line}`;
  const cached = ctx.caches.live.get(key);
  if (cached) return cached.id;
  const id = await getLiveReleaseId(ctx.pool, repoId, line);
  ctx.caches.live.set(key, { id });
  return id;
}

async function storedRelease(ctx: AppContext, id: number): Promise<StoredRelease | null> {
  const cached = ctx.caches.releases.get(id);
  if (cached) return cached;
  const stored = await getRelease(ctx.pool, id);
  if (stored) ctx.caches.releases.set(id, stored);
  return stored;
}

/** The newest live release line of a repo, e.g. `2`, or null when nothing is live. */
async function newestLine(ctx: AppContext, repoId: number): Promise<string | null> {
  const cached = ctx.caches.newest.get(repoId);
  if (cached) return cached.line;
  const lines = (await listLiveReleases(ctx.pool, repoId))
    .map((r) => r.releaseLine)
    .sort((a, b) => compareReleaseLines(b, a));
  const line = lines[0] ?? null;
  ctx.caches.newest.set(repoId, { line });
  return line;
}

/** The live release of the audience's line, filtered for the audience. */
export async function audienceRelease(
  ctx: AppContext,
  repo: Repo,
  audience: Audience,
): Promise<ReaderRelease | string> {
  // A reader context without a line has an unparseable version. The staff
  // view and the "nothing gated" public view are served the newest line.
  const servesNewest = audience.context === null || audience.context === NOTHING_GATED;
  if (!audience.line && !servesNewest)
    return 'Your account has no valid release version. Ask your administrator.';
  const line = audience.line ?? (await newestLine(ctx, repo.id));
  if (!line) return 'No documentation has been published yet.';
  const id = await liveReleaseId(ctx, repo.id, line);
  const stored = id === null ? null : await storedRelease(ctx, id);
  if (!stored) return `No documentation has been published for release ${line}.x yet.`;
  const key = `${stored.id}|${audience.key}`;
  let view = ctx.caches.views.get(key);
  if (!view) {
    // Build-time filtering already happened in the worker; only the audience's policy remains.
    const { policies, options } = audienceFilter(audience);
    view = viewRelease(stored.snapshot, policies, options);
    ctx.caches.views.set(key, view);
  }
  return { stored, view, key, line, audience };
}

/** The live release for the reader's line, filtered for their own entitlement set. */
export async function readerRelease(
  ctx: AppContext,
  reader: ReaderContext,
): Promise<ReaderRelease | string> {
  const repo = await siteRepo(ctx);
  if (!repo) return 'No documentation site is configured yet.';
  return audienceRelease(ctx, repo, readerAudience(reader, repo.releaseLines));
}

/** The live lines of a repo and their settings, as the public site uses them; cached. */
async function lineState(
  ctx: AppContext,
  repo: Repo,
): Promise<{ lines: PublicLine[]; latest: LatestLine | null }> {
  const cached = ctx.caches.publicLines.get(repo.id);
  if (cached) return cached;
  const live = await listLiveReleases(ctx.pool, repo.id);
  const settings = await getReleaseLineSettings(ctx.pool, repo.id);
  const labelled = live.find((l) => l.releaseLine === settings.labels.latest);
  const latest = labelled ? { line: labelled.releaseLine, release: labelled.release } : null;
  const served = defaultPublicLine(repo, latest) ?? (await newestLine(ctx, repo.id));
  const marked = new Set(settings.publicLines);
  const lines =
    repo.access !== 'public'
      ? []
      : live
          .filter((l) => l.releaseLine === served || marked.has(l.releaseLine))
          .sort((a, b) => compareReleaseLines(b.releaseLine, a.releaseLine))
          .map((l) => ({
            line: l.releaseLine,
            release: l.release,
            isDefault: l.releaseLine === served,
            labels: Object.entries(settings.labels)
              .filter(([, line]) => line === l.releaseLine)
              .map(([label]) => label),
          }));
  const state = { lines, latest };
  ctx.caches.publicLines.set(repo.id, state);
  return state;
}

/**
 * The live lines a public site serves anonymous visitors under `/v/<line>/`,
 * newest first: the line `/` serves them (see `defaultPublicLine`) and the
 * lines marked public. Lines that are not live are never listed. None on
 * private sites.
 */
export async function publicLines(ctx: AppContext, repo: Repo): Promise<PublicLine[]> {
  return (await lineState(ctx, repo)).lines;
}

/** The live line labelled `latest`, or null. */
export async function latestLine(ctx: AppContext, repo: Repo): Promise<LatestLine | null> {
  return (await lineState(ctx, repo)).latest;
}

/** Anonymous visitors of a public site at `/` (see `publicAudience`). */
export async function sitePublicAudience(ctx: AppContext, repo: Repo): Promise<Audience> {
  return publicAudience(repo, await latestLine(ctx, repo));
}

/** A public line's live release, filtered for anonymous visitors of that line. */
export async function publicLineRelease(
  ctx: AppContext,
  repo: Repo,
  line: PublicLine,
): Promise<ReaderRelease | string> {
  return audienceRelease(ctx, repo, publicLineAudience(repo, line.line, line.release));
}

/**
 * The version menu for a page of `currentLine`: every public line, linking to
 * the same topic in that line's public view, or to that line's home when that
 * view does not have it. Only when there is more than one public line, so a
 * site that never marked a line public looks as it always did.
 */
async function versionMenu(
  ctx: AppContext,
  repo: Repo,
  currentLine: string,
  topicId: string | null,
): Promise<string> {
  const lines = await publicLines(ctx, repo);
  if (lines.length < 2) return '';
  const items = [];
  for (const l of lines) {
    const base = linePrefix(l.line);
    let href = base;
    if (topicId) {
      const release = await publicLineRelease(ctx, repo, l);
      if (typeof release !== 'string' && release.view.isVisible(topicId))
        href = pageHref(topicId, base);
    }
    items.push({ line: l.line, labels: l.labels, href });
  }
  const current = lines.find((l) => l.line === currentLine);
  return renderVersionMenu({ line: currentLine, labels: current?.labels ?? [] }, items);
}

/** `/v/<line>/`, the prefix of a public line's pages. */
export function linePrefix(line: string): string {
  return `/v/${encodeURIComponent(line)}/`;
}

/**
 * The viewer of a public line's pages: anonymous visitors' view of that line,
 * whoever asks (a signed-in reader's own entitlements never apply under
 * `/v/`). Null when the site is not public or the line is not a live public
 * line, which callers answer exactly as a path that does not exist.
 */
async function lineViewer(
  ctx: AppContext,
  request: FastifyRequest,
  line: string,
): Promise<Viewer | null> {
  const repo = await siteRepo(ctx);
  if (repo?.access !== 'public') return null;
  const found = (await publicLines(ctx, repo)).find((l) => l.line === line);
  if (!found) return null;
  const release = await publicLineRelease(ctx, repo, found);
  if (typeof release === 'string') return null;
  const access = await currentAccess(request, ctx);
  return { access, repo, release, orgSlug: access?.orgSlug ?? null, publicLine: found };
}

/** The reader's view of one publication, or `null` when the release has none from `file`. */
export function publicationView(
  ctx: AppContext,
  release: ReaderRelease,
  file: string,
): PublicationView | null {
  const key = `${release.key}|${file}`;
  let cached = ctx.caches.publications.get(key);
  if (!cached) {
    const { policies, options } = audienceFilter(release.audience);
    cached = { view: viewPublication(release.stored.snapshot, file, policies, options) };
    ctx.caches.publications.set(key, cached);
  }
  return cached.view;
}

/** Publications with at least one topic this reader can see. */
export function readerPublications(ctx: AppContext, release: ReaderRelease): Publication[] {
  return release.stored.snapshot.publications.filter((p) => {
    const view = publicationView(ctx, release, p.file);
    return view !== null && publicationHasContent(view);
  });
}

/**
 * The site title for the sign-in page, on public sites only: anonymous
 * visitors could read it anyway. Private sites reveal nothing before sign-in.
 */
export async function publicSiteTitle(ctx: AppContext): Promise<string | undefined> {
  const repo = await siteRepo(ctx);
  if (repo?.access !== 'public') return undefined;
  const release = await audienceRelease(ctx, repo, await sitePublicAudience(ctx, repo));
  return typeof release === 'string' ? undefined : release.view.release.title || undefined;
}

/** Who is reading, and what they see. */
export interface Viewer {
  /** The signed-in reader, or null for an anonymous visitor of a public site. */
  access: ReaderAccess | null;
  repo: Repo;
  release: ReaderRelease;
  /** Analytics org: the reader's, or null for anonymous visitors. */
  orgSlug: string | null;
  /** Set for pages under `/v/<line>/`: the public line they are from. */
  publicLine?: PublicLine;
}

/**
 * The release a request sees, by the same rules for every route: the site's
 * access mode, the session, staff and entitlements (see `audienceFor`).
 * Returns why there is none instead when it cannot see one.
 */
export async function viewerRelease(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<
  | Viewer
  | { refused: 'sign-in' }
  | { refused: 'no-entitlements' }
  | { refused: 'unpublished'; message: string }
> {
  const access = await currentAccess(request, ctx);
  const repo = await siteRepo(ctx);
  // Without a site there is no access mode: fail closed, as a private site.
  if (!repo)
    return access
      ? { refused: 'unpublished', message: 'No documentation site is configured yet.' }
      : { refused: 'sign-in' };
  const audience = audienceFor(
    repo,
    access,
    repo.access === 'public' ? await latestLine(ctx, repo) : null,
  );
  if (audience === 'sign-in') return { refused: 'sign-in' };
  if (audience === 'no-entitlements') return { refused: 'no-entitlements' };
  const release = await audienceRelease(ctx, repo, audience);
  if (typeof release === 'string') return { refused: 'unpublished', message: release };
  return { access, repo, release, orgSlug: access?.orgSlug ?? null };
}

/**
 * Resolves the viewer and their release, or answers the request itself:
 * sign-in redirect (private sites), no entitlements, or nothing published.
 */
export async function resolveViewer(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Viewer | null> {
  const r = await viewerRelease(ctx, request);
  if ('release' in r) return r;
  if (r.refused === 'sign-in') {
    await redirectToLogin(request, reply);
  } else if (r.refused === 'no-entitlements') {
    await reply
      .code(403)
      .headers(PAGE_HEADERS)
      .type('text/html')
      .send(
        messagePage('No access yet', 'Your organization has no documentation entitlements yet.'),
      );
  } else {
    await reply
      .code(404)
      .headers(PAGE_HEADERS)
      .type('text/html')
      .send(messagePage('Not published', r.message));
  }
  return null;
}

const visibleAssetsCache = new WeakMap<ReleaseView, Set<string>>();

/** Files referenced by topics this view can see. Anything else is not served to this reader. */
function visibleAssets(view: ReleaseView): Set<string> {
  let assets = visibleAssetsCache.get(view);
  if (!assets) {
    assets = new Set();
    for (const id of view.topicIds()) {
      walk(view.topic(id)!.body, (el) => {
        const asset = el.attrs[ASSET_ATTR];
        if (asset) assets!.add(asset);
      });
    }
    visibleAssetsCache.set(view, assets);
  }
  return assets;
}

export function registerDelivery(app: FastifyInstance, ctx: AppContext): void {
  /** Page links, search, assets and PDFs of a viewer's pages: under `/`, or `/v/<line>/`. */
  const baseOf = (viewer: Viewer) => (viewer.publicLine ? linePrefix(viewer.publicLine.line) : '/');

  const pageOptions = (viewer: Viewer): PageOptions => {
    const release = viewer.release;
    const base = baseOf(viewer);
    const options: PageOptions = {
      account: { header: ACCOUNT_MARKER, menu: MENU_ACCOUNT_MARKER },
      topicEnd: TOPIC_ACTIONS_MARKER + FEEDBACK_MARKER,
      search: { action: `${base}search` },
      publications: readerPublications(ctx, release).map((p) => ({
        title: p.title || publicationSlug(p.file),
        href: publicationHref(p, base),
      })),
      versions: VERSIONS_MARKER,
    };
    if (base !== '/') options.base = base;
    // The staff view marks conditional content, as the previewer and editor do.
    if (release.audience.context === null) options.showConditions = true;
    if (release.view.release.theme) options.themeHref = `${base}_theme.css`;
    if (release.view.release.logo)
      options.logoHref = `${base}${logoRoute(release.view.release.logo)}`;
    return options;
  };
  const resolve = (request: FastifyRequest, reply: FastifyReply) =>
    resolveViewer(ctx, request, reply);
  const pdf = pdfResponder(ctx);

  /** Fills the per-request markers of a (possibly cached) page and sends it. */
  const sendPage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    viewer: Viewer,
    status: number,
    html: string,
    topic?: { id: string; file: string },
  ) => {
    const account = accountControls(request, ctx, viewer.access);
    const actions = topic ? topicActions(ctx, viewer, topic.file) : '';
    // Feedback is about the reader's own view, which a public line's pages are not.
    const feedback =
      topic && !viewer.publicLine ? feedbackHtml(request, ctx, topic.id, 'site') : '';
    const versions = await versionMenu(ctx, viewer.repo, viewer.release.line, topic?.id ?? null);
    return reply
      .code(status)
      .headers(PAGE_HEADERS)
      .type('text/html; charset=utf-8')
      .send(
        // Function replacements: a `$` in a reader's name must not act as a replacement pattern.
        html
          .replace(ACCOUNT_MARKER, () => account.header)
          .replace(MENU_ACCOUNT_MARKER, () => account.menu)
          .replace(VERSIONS_MARKER, () => versions)
          .replace(TOPIC_ACTIONS_MARKER, () => actions)
          .replace(FEEDBACK_MARKER, () => feedback),
      );
  };

  const notFoundAsset = (reply: FastifyReply) =>
    reply.code(404).headers(ASSET_HEADERS).type('text/plain').send('Not found');

  const home = async (request: FastifyRequest, reply: FastifyReply, r: Viewer) => {
    const first = r.release.view.topicIds()[0];
    if (first) return reply.headers(PAGE_HEADERS).redirect(pageHref(first, baseOf(r)));
    return sendPage(request, reply, r, 200, renderIndex(r.release.view, pageOptions(r)));
  };

  const theme = async (reply: FastifyReply, r: Viewer) => {
    const file = r.release.stored.snapshot.theme;
    const data = file
      ? await ctx.blobs.get(assetKey(r.release.stored.repoId, r.release.stored.sha, file))
      : null;
    if (!data) return reply.code(404).send('Not found');
    return reply.headers(ASSET_HEADERS).type('text/css; charset=utf-8').send(data);
  };

  /** `name` is the requested file name, e.g. `_logo.svg`. */
  const logo = async (reply: FastifyReply, r: Viewer, name: string) => {
    const file = r.release.stored.snapshot.logo;
    const data =
      file && name === logoRoute(file)
        ? await ctx.blobs.get(assetKey(r.release.stored.repoId, r.release.stored.sha, file))
        : null;
    if (!data) return notFoundAsset(reply);
    return reply
      .headers(ASSET_HEADERS)
      .type(CONTENT_TYPES[posix.extname(file!).toLowerCase()] ?? 'application/octet-stream')
      .send(data);
  };

  const asset = async (reply: FastifyReply, r: Viewer, path: string) => {
    // Fail closed: only files referenced by a topic this viewer can see.
    const data = visibleAssets(r.release.view).has(path)
      ? await ctx.blobs.get(assetKey(r.release.stored.repoId, r.release.stored.sha, path))
      : null;
    if (!data) return notFoundAsset(reply);
    return reply
      .headers(ASSET_HEADERS)
      .type(CONTENT_TYPES[posix.extname(path).toLowerCase()] ?? 'application/octet-stream')
      .send(data);
  };

  // Never cached: the hits depend on the viewer's entitlements and the query.
  const search = async (request: FastifyRequest, reply: FastifyReply, r: Viewer) => {
    const query = siteSearchQuery((request.query as { q?: unknown }).q);
    const hits = query ? await searchRelease(ctx.pool, r.release, query, SITE_SEARCH_LIMIT) : [];
    if (query)
      ctx.analytics.search(request, {
        surface: 'site',
        orgSlug: r.orgSlug,
        releaseLine: r.release.line,
        query,
        resultCount: hits.length,
      });
    const html = renderSearch(r.release.view, query, hits, {
      ...pageOptions(r),
      limit: SITE_SEARCH_LIMIT,
    });
    return sendPage(request, reply, r, 200, html);
  };

  const page = async (request: FastifyRequest, reply: FastifyReply, r: Viewer, path: string) => {
    const { view, key } = r.release;
    if (path.endsWith('.html')) {
      const topicId = path.slice(0, -'.html'.length);
      const cacheKey = `${key}|${topicId}`;
      let html = ctx.caches.pages.get(cacheKey);
      if (html === undefined) {
        const options = pageOptions(r);
        // The default public line is also served at `/`: that is the page's address.
        if (r.publicLine?.isDefault)
          options.head = `<link rel="canonical" href="${escapeHtml(`${ctx.config.publicUrl}${pageHref(topicId)}`)}">`;
        html = renderPage(view, topicId, options) ?? '';
        ctx.caches.pages.set(cacheKey, html);
      }
      const topic = html ? view.topic(topicId) : null;
      if (html && topic) {
        ctx.analytics.view(request, {
          surface: 'site',
          orgSlug: r.orgSlug,
          releaseLine: r.release.line,
          topicId,
        });
        return sendPage(request, reply, r, 200, html, { id: topicId, file: topic.file });
      }
    }
    // Missing and hidden pages look the same.
    return sendPage(request, reply, r, 404, renderNotFound(view, pageOptions(r)));
  };

  /** Any other path of the site, for the request's own viewer. */
  const sitePath = async (request: FastifyRequest, reply: FastifyReply, path: string) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    return page(request, reply, r, path);
  };

  const notFoundPage = (reply: FastifyReply) =>
    reply
      .code(404)
      .headers(PAGE_HEADERS)
      .type('text/html; charset=utf-8')
      .send(messagePage('Page not found', 'This page does not exist or is not available to you.'));

  /**
   * `context/<app>/<key>` (or `context/<app>?path=`) on a public site: the
   * help topic for a context key, resolved as the help API resolves it
   * (key, parents, app default) but in anonymous visitors' view, so it never
   * names a topic they cannot see. Redirects to the topic page under `base`.
   */
  const context = async (
    request: FastifyRequest,
    reply: FastifyReply,
    release: ReaderRelease,
    base: string,
    appName: string,
    key: string | undefined,
  ) => {
    const req: { app: string; key?: string; path?: string } = { app: appName };
    const path = (request.query as { path?: unknown }).path;
    if (key) req.key = key;
    else if (typeof path === 'string' && path) req.path = path;
    const resolved = resolveContext(release.view, req);
    if (!resolved) return notFoundPage(reply);
    const fragment = resolved.fragment ? `#${encodeURIComponent(resolved.fragment)}` : '';
    return reply.headers(PAGE_HEADERS).redirect(`${pageHref(resolved.topicId, base)}${fragment}`);
  };

  app.get('/', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    return home(request, reply, r);
  });

  app.get('/_theme.css', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    return theme(reply, r);
  });

  app.get('/_logo.:ext', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    return logo(reply, r, request.url.split('?')[0]!.slice(1));
  });

  app.get('/_assets/*', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    return asset(reply, r, (request.params as { '*': string })['*']);
  });

  app.get('/search', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    return search(request, reply, r);
  });

  // Help context links for public sites. Private sites answer 404 and reveal nothing.
  const contextRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    const { app: appName, key } = request.params as { app: string; key?: string };
    // A topic page whose id starts with context/ is still a page.
    if (request.url.split('?')[0]!.endsWith('.html'))
      return sitePath(request, reply, decodeURIComponent(request.url.split('?')[0]!.slice(1)));
    const repo = await siteRepo(ctx);
    if (repo?.access !== 'public') return notFoundPage(reply);
    const release = await audienceRelease(ctx, repo, await sitePublicAudience(ctx, repo));
    if (typeof release === 'string') return notFoundPage(reply);
    return context(request, reply, release, '/', appName, key);
  };
  app.get('/context/:app', contextRoute);
  app.get('/context/:app/:key', contextRoute);

  // Public lines: anonymous visitors' view of each line under /v/<line>/. Anything
  // else under /v/ is an ordinary path (and so a 404 like any page that does not exist).
  app.get('/v/:line', async (request, reply) => {
    const { line } = request.params as { line: string };
    if (await lineViewer(ctx, request, line))
      return reply.headers(PAGE_HEADERS).redirect(linePrefix(line));
    return sitePath(request, reply, `v/${line}`);
  });
  app.get('/v/:line/*', async (request, reply) => {
    const params = request.params as { line: string; '*': string };
    const rest = params['*'];
    const r = await lineViewer(ctx, request, params.line);
    if (!r) return sitePath(request, reply, decodeURIComponent(`v/${params.line}/${rest}`));
    if (rest === '') return home(request, reply, r);
    if (rest === '_theme.css') return theme(reply, r);
    if (/^_logo\.[A-Za-z0-9]+$/.test(rest)) return logo(reply, r, rest);
    if (rest.startsWith('_assets/')) return asset(reply, r, rest.slice('_assets/'.length));
    if (rest === 'search') return search(request, reply, r);
    if (rest.startsWith('pdf/') && !rest.slice(4).includes('/'))
      return pdf(request, reply, r, rest.slice(4));
    const ctxMatch = /^context\/([^/]+)(?:\/([^/]+))?$/.exec(rest);
    if (ctxMatch && !rest.endsWith('.html'))
      return context(request, reply, r.release, linePrefix(params.line), ctxMatch[1]!, ctxMatch[2]);
    return page(request, reply, r, decodeURIComponent(rest));
  });

  app.get('/*', async (request, reply) =>
    sitePath(request, reply, decodeURIComponent((request.params as { '*': string })['*'])),
  );
}
