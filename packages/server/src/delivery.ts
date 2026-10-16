import { posix } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ASSET_ATTR,
  entitlementKey,
  publicationSlug,
  walk,
  type Publication,
  type ReaderContext,
} from '@opend/model';
import {
  readerPolicy,
  releaseLine,
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
  siteSearchQuery,
  type PageOptions,
} from '@opend/render-html';
import {
  assetKey,
  findRepoByName,
  getLiveReleaseId,
  getRelease,
  listRepos,
  type Repo,
  type StoredRelease,
} from '@opend/store';
import { FEEDBACK_MARKER, feedbackHtml } from './analytics.js';
import { currentAccess, redirectToLogin } from './auth.js';
import type { AppContext } from './context.js';
import { USER_BAR_MARKER, messagePage, userBar } from './pages.js';
import { searchRelease } from './search.js';

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
  /** `releaseId|entitlementKey`: everything rendered from this view is cached under it. */
  key: string;
  /** The reader's release line, e.g. `2`. */
  line: string;
  reader: ReaderContext;
}

async function siteRepo(ctx: AppContext): Promise<Repo | null> {
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

/** The live release for the reader's line, filtered for their entitlement set. */
export async function readerRelease(
  ctx: AppContext,
  reader: ReaderContext,
): Promise<ReaderRelease | string> {
  const repo = await siteRepo(ctx);
  if (!repo) return 'No documentation site is configured yet.';
  const line = releaseLine(reader.version);
  if (!line) return 'Your account has no valid release version. Ask your administrator.';
  const id = await liveReleaseId(ctx, repo.id, line);
  const stored = id === null ? null : await storedRelease(ctx, id);
  if (!stored) return `No documentation has been published for release ${line}.x yet.`;
  const key = `${stored.id}|${entitlementKey(reader)}`;
  let view = ctx.caches.views.get(key);
  if (!view) {
    // Build-time filtering already happened in the worker; only the reader's policy remains.
    view = viewRelease(stored.snapshot, [readerPolicy(reader)]);
    ctx.caches.views.set(key, view);
  }
  return { stored, view, key, line, reader };
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
    cached = {
      view: viewPublication(release.stored.snapshot, file, [readerPolicy(release.reader)]),
    };
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
 * Resolves the signed-in reader and their release, or answers the request
 * itself: sign-in redirect, no entitlements, or nothing published.
 */
export async function resolveReader(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ email: string; orgSlug: string; release: ReaderRelease } | null> {
  const access = await currentAccess(request, ctx);
  if (!access) {
    await redirectToLogin(request, reply);
    return null;
  }
  if (!access.context) {
    await reply
      .code(403)
      .headers(PAGE_HEADERS)
      .type('text/html')
      .send(
        messagePage('No access yet', 'Your organization has no documentation entitlements yet.'),
      );
    return null;
  }
  const release = await readerRelease(ctx, access.context);
  if (typeof release === 'string') {
    await reply
      .code(404)
      .headers(PAGE_HEADERS)
      .type('text/html')
      .send(messagePage('Not published', release));
    return null;
  }
  return { email: access.reader.email, orgSlug: access.orgSlug, release };
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
  const pageOptions = (release: ReaderRelease): PageOptions => {
    const options: PageOptions = {
      banner: USER_BAR_MARKER,
      topicEnd: FEEDBACK_MARKER,
      search: { action: '/search' },
      publications: readerPublications(ctx, release).map((p) => ({
        title: p.title || publicationSlug(p.file),
        href: publicationHref(p),
      })),
    };
    if (release.view.release.theme) options.themeHref = '/_theme.css';
    return options;
  };
  const resolve = (request: FastifyRequest, reply: FastifyReply) =>
    resolveReader(ctx, request, reply);

  const sendPage = (
    reply: FastifyReply,
    status: number,
    html: string,
    email: string,
    feedback = '',
  ) =>
    reply
      .code(status)
      .headers(PAGE_HEADERS)
      .type('text/html; charset=utf-8')
      .send(html.replace(USER_BAR_MARKER, userBar(email)).replace(FEEDBACK_MARKER, feedback));

  app.get('/', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    const first = r.release.view.topicIds()[0];
    if (first) return reply.headers(PAGE_HEADERS).redirect(pageHref(first));
    return sendPage(reply, 200, renderIndex(r.release.view, pageOptions(r.release)), r.email);
  });

  app.get('/_theme.css', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    const theme = r.release.stored.snapshot.theme;
    const data = theme
      ? await ctx.blobs.get(assetKey(r.release.stored.repoId, r.release.stored.sha, theme))
      : null;
    if (!data) return reply.code(404).send('Not found');
    return reply.headers(ASSET_HEADERS).type('text/css; charset=utf-8').send(data);
  });

  app.get('/_assets/*', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    const path = (request.params as { '*': string })['*'];
    // Fail closed: only files referenced by a topic this reader can see.
    const data = visibleAssets(r.release.view).has(path)
      ? await ctx.blobs.get(assetKey(r.release.stored.repoId, r.release.stored.sha, path))
      : null;
    if (!data) return reply.code(404).headers(ASSET_HEADERS).type('text/plain').send('Not found');
    return reply
      .headers(ASSET_HEADERS)
      .type(CONTENT_TYPES[posix.extname(path).toLowerCase()] ?? 'application/octet-stream')
      .send(data);
  });

  // Never cached: the hits depend on the reader's entitlements and the query.
  app.get('/search', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
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
      ...pageOptions(r.release),
      limit: SITE_SEARCH_LIMIT,
    });
    return sendPage(reply, 200, html, r.email);
  });

  app.get('/*', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    const path = decodeURIComponent((request.params as { '*': string })['*']);
    const { view, key } = r.release;
    if (path.endsWith('.html')) {
      const topicId = path.slice(0, -'.html'.length);
      const cacheKey = `${key}|${topicId}`;
      let html = ctx.caches.pages.get(cacheKey);
      if (html === undefined) {
        html = renderPage(view, topicId, pageOptions(r.release)) ?? '';
        ctx.caches.pages.set(cacheKey, html);
      }
      if (html) {
        ctx.analytics.view(request, {
          surface: 'site',
          orgSlug: r.orgSlug,
          releaseLine: r.release.line,
          topicId,
        });
        const feedback = feedbackHtml(request, ctx, topicId, 'site');
        return sendPage(reply, 200, html, r.email, feedback);
      }
    }
    // Missing and hidden pages look the same.
    return sendPage(reply, 404, renderNotFound(view, pageOptions(r.release)), r.email);
  });
}
