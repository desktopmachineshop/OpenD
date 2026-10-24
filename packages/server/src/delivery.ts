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
  listLiveReleases,
  listRepos,
  type ReaderAccess,
  type Repo,
  type StoredRelease,
} from '@opend/store';
import { appearance, siteThemeHref } from './appearance.js';
import {
  NOTHING_GATED,
  audienceFilter,
  audienceFor,
  publicAudience,
  readerAudience,
  type Audience,
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
    .map((r) => Number(r.releaseLine))
    .filter(Number.isInteger)
    .sort((a, b) => b - a);
  const line = lines.length ? String(lines[0]) : null;
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
  return audienceRelease(ctx, repo, readerAudience(reader));
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
  const release = await audienceRelease(ctx, repo, publicAudience(repo));
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
  const audience = audienceFor(repo, access);
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
  const pageOptions = (release: ReaderRelease): PageOptions => {
    const options: PageOptions = {
      account: { header: ACCOUNT_MARKER, menu: MENU_ACCOUNT_MARKER },
      topicEnd: TOPIC_ACTIONS_MARKER + FEEDBACK_MARKER,
      search: { action: '/search' },
      publications: readerPublications(ctx, release).map((p) => ({
        title: p.title || publicationSlug(p.file),
        href: publicationHref(p),
      })),
    };
    // The staff view marks conditional content, as the previewer and editor do.
    if (release.audience.context === null) options.showConditions = true;
    if (release.view.release.theme) options.themeHref = '/_theme.css';
    const siteTheme = siteThemeHref(appearance(ctx));
    if (siteTheme) options.siteThemeHref = siteTheme;
    if (release.view.release.logo) options.logoHref = `/${logoRoute(release.view.release.logo)}`;
    return options;
  };
  const resolve = (request: FastifyRequest, reply: FastifyReply) =>
    resolveViewer(ctx, request, reply);

  /** Fills the per-request markers of a (possibly cached) page and sends it. */
  const sendPage = (
    request: FastifyRequest,
    reply: FastifyReply,
    viewer: Viewer,
    status: number,
    html: string,
    topic?: { id: string; file: string },
  ) => {
    const account = accountControls(request, ctx, viewer.access);
    const actions = topic ? topicActions(ctx, viewer, topic.file) : '';
    const feedback = topic ? feedbackHtml(request, ctx, topic.id, 'site') : '';
    return reply
      .code(status)
      .headers(PAGE_HEADERS)
      .type('text/html; charset=utf-8')
      .send(
        // Function replacements: a `$` in a reader's name must not act as a replacement pattern.
        html
          .replace(ACCOUNT_MARKER, () => account.header)
          .replace(MENU_ACCOUNT_MARKER, () => account.menu)
          .replace(TOPIC_ACTIONS_MARKER, () => actions)
          .replace(FEEDBACK_MARKER, () => feedback),
      );
  };

  app.get('/', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    const first = r.release.view.topicIds()[0];
    if (first) return reply.headers(PAGE_HEADERS).redirect(pageHref(first));
    return sendPage(request, reply, r, 200, renderIndex(r.release.view, pageOptions(r.release)));
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

  app.get('/_logo.:ext', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    const logo = r.release.stored.snapshot.logo;
    const data =
      logo && request.url.split('?')[0] === `/${logoRoute(logo)}`
        ? await ctx.blobs.get(assetKey(r.release.stored.repoId, r.release.stored.sha, logo))
        : null;
    if (!data) return reply.code(404).headers(ASSET_HEADERS).type('text/plain').send('Not found');
    return reply
      .headers(ASSET_HEADERS)
      .type(CONTENT_TYPES[posix.extname(logo!).toLowerCase()] ?? 'application/octet-stream')
      .send(data);
  });

  app.get('/_assets/*', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    const path = (request.params as { '*': string })['*'];
    // Fail closed: only files referenced by a topic this viewer can see.
    const data = visibleAssets(r.release.view).has(path)
      ? await ctx.blobs.get(assetKey(r.release.stored.repoId, r.release.stored.sha, path))
      : null;
    if (!data) return reply.code(404).headers(ASSET_HEADERS).type('text/plain').send('Not found');
    return reply
      .headers(ASSET_HEADERS)
      .type(CONTENT_TYPES[posix.extname(path).toLowerCase()] ?? 'application/octet-stream')
      .send(data);
  });

  // Never cached: the hits depend on the viewer's entitlements and the query.
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
    return sendPage(request, reply, r, 200, html);
  });

  app.get('/*', async (request, reply) => {
    const r = await resolve(request, reply);
    if (!r) return reply;
    const path = decodeURIComponent((request.params as { '*': string })['*']);
    const { view, key } = r.release;
    if (path.endsWith('.html')) {
      const topicId = path.slice(0, -'.html'.length);
      // The appearance version is in the key: pages link the theme stylesheet by version.
      const cacheKey = `${key}|${appearance(ctx).version}|${topicId}`;
      let html = ctx.caches.pages.get(cacheKey);
      if (html === undefined) {
        html = renderPage(view, topicId, pageOptions(r.release)) ?? '';
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
    return sendPage(request, reply, r, 404, renderNotFound(view, pageOptions(r.release)));
  });
}
