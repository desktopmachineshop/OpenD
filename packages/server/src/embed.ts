import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LRUCache } from 'lru-cache';
import { displayText, firstChild } from '@opend/model';
import {
  parseVersion,
  resolveContext,
  visibleNav,
  type ReleaseView,
  type VisibleNavEntry,
} from '@opend/filter';
import { frameScript, widgetScript } from '@opend/embed';
import {
  handleEmbedRequest,
  navNeighbours,
  pageHref,
  renderEmbedMessage,
  renderEmbedSignIn,
  renderTopic,
  type EmbedOptions,
} from '@opend/render-html';
import { findReaderByEmail, getReaderAccess } from '@opend/store';
import { appearance, siteThemeHref } from './appearance.js';
import { FEEDBACK_MARKER, feedbackHtml } from './analytics.js';
import { currentAccess, setEmbedSession } from './auth.js';
import type { AppContext } from './context.js';
import { anonymousRelease, readerRelease, servedSiteRepo, type ReaderRelease } from './delivery.js';
import { EmbedTokenError, verifyEmbedToken } from './embed-token.js';
import { searchRelease } from './search.js';

/** Headers for help-panel pages: only the configured host apps may frame them. */
export function embedFrameHeaders(origins: readonly string[]): Record<string, string> {
  return {
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin',
    'content-security-policy': `default-src 'none'; script-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors ${origins.join(' ')}`,
  };
}

/** Headers that say which release a help API answer was served from. */
export const RELEASE_HEADERS = ['OpenD-Release', 'OpenD-Release-Line'] as const;

/** How long browsers and proxies may keep an anonymous help API answer, in seconds. */
export const ANONYMOUS_HELP_MAX_AGE = 60;

/**
 * Embedded help for host apps: the panel pages a host frames, the widget and
 * frame scripts, the token-to-session exchange, and a JSON API for apps that
 * render help natively. Everything goes through the same reader filter as the
 * docs site. Without OPEND_EMBED_SECRET and OPEND_EMBED_ORIGINS none of it
 * exists, except the JSON API's anonymous answers on a public site: those are
 * exactly what an anonymous visitor of the site reads, so they need no token.
 */
export function registerEmbed(app: FastifyInstance, ctx: AppContext): void {
  const embed = ctx.config.embed ?? null;
  const allowed = new Set(embed?.origins ?? []);
  const audience = ctx.config.publicUrl;
  /**
   * Verified bearer tokens → reader id, for at most a minute and never past the
   * token's own `exp`, so an expired token is verified again (and rejected).
   */
  const tokens = new LRUCache<string, { readerId: number; expiresAtMs: number }>({
    max: 5000,
    ttl: 60_000,
  });

  /** Resolves a token to a reader whose org matches the claim. No secret: no token is valid. */
  const readerForToken = async (
    token: string,
  ): Promise<{ readerId: number } | 'invalid' | 'forbidden'> => {
    if (!embed) return 'invalid';
    const cached = tokens.get(token);
    if (cached && cached.expiresAtMs > Date.now()) return { readerId: cached.readerId };
    let claims;
    try {
      claims = await verifyEmbedToken(token, embed.secret, audience);
    } catch (err) {
      ctx.log({
        level: 'info',
        msg: 'embed token rejected',
        reason: err instanceof EmbedTokenError ? err.message : String(err),
      });
      return 'invalid';
    }
    const reader = await findReaderByEmail(ctx.pool, claims.email);
    if (!reader || reader.orgSlug !== claims.org) {
      ctx.log({
        level: 'info',
        msg: 'embed token for unknown reader or wrong org',
        org: claims.org,
      });
      return 'forbidden';
    }
    const expiresAtMs = claims.expiresAt * 1000;
    const ttl = Math.min(60_000, expiresAtMs - Date.now());
    if (ttl > 0) tokens.set(token, { readerId: reader.id, expiresAtMs }, { ttl });
    return { readerId: reader.id };
  };

  const bearer = (request: FastifyRequest): string | null => {
    const header = request.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() || null : null;
  };

  registerHelpApi(app, ctx, allowed, bearer, readerForToken);
  if (embed) registerPanel(app, ctx, allowed, bearer, readerForToken);
}

type ReaderForToken = (token: string) => Promise<{ readerId: number } | 'invalid' | 'forbidden'>;
type Bearer = (request: FastifyRequest) => string | null;

function registerPanel(
  app: FastifyInstance,
  ctx: AppContext,
  allowed: ReadonlySet<string>,
  bearer: Bearer,
  readerForToken: ReaderForToken,
): void {
  const frameHeaders = embedFrameHeaders([...allowed]);

  // The frame exchanges the host's token for a partitioned session cookie.
  app.post('/embed/session', async (request, reply) => {
    const token = bearer(request);
    if (!token) return reply.code(401).send({ error: 'missing token' });
    const result = await readerForToken(token);
    if (result === 'invalid') return reply.code(401).send({ error: 'invalid token' });
    if (result === 'forbidden') return reply.code(403).send({ error: 'no access' });
    setEmbedSession(reply, result.readerId);
    return reply.code(204).send();
  });

  app.get('/embed/frame.js', async (_request, reply) =>
    reply
      .headers({ 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' })
      .type('text/javascript; charset=utf-8')
      .send(frameScript()),
  );
  app.get('/embed/opend-help.js', async (_request, reply) =>
    reply
      .headers({
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'access-control-allow-origin': '*',
      })
      .type('text/javascript; charset=utf-8')
      .send(widgetScript()),
  );

  const embedOptions = (request: FastifyRequest, view: ReleaseView | null): EmbedOptions => {
    const params = new URLSearchParams(request.url.split('?')[1] ?? '');
    const host = params.get('host');
    const o: EmbedOptions = {
      hostOrigin: host && allowed.has(host) ? host : null,
      fullDocsBase: `${ctx.config.publicUrl}/`,
    };
    const appName = params.get('app');
    if (appName) o.app = appName;
    if (view?.release.theme) o.themeHref = '/_theme.css';
    const siteTheme = siteThemeHref(appearance(ctx));
    if (siteTheme) o.siteThemeHref = siteTheme;
    return o;
  };

  const panel = async (request: FastifyRequest, reply: FastifyReply) => {
    const send = (status: number, html: string) =>
      reply.code(status).headers(frameHeaders).type('text/html; charset=utf-8').send(html);
    const path = request.url.split('?')[0]!;
    const params = new URLSearchParams(request.url.split('?')[1] ?? '');
    const access = await currentAccess(request, ctx);
    if (!access) {
      const o = embedOptions(request, null);
      // Only a framing host can supply a token; elsewhere, say where help lives.
      if (!o.hostOrigin)
        return send(
          401,
          renderEmbedMessage(
            'Sign in',
            'Open help from your application, or sign in to the docs site.',
            o,
          ),
        );
      return send(200, renderEmbedSignIn(request.url, o));
    }
    if (!access.context)
      return send(
        403,
        renderEmbedMessage(
          'No access yet',
          'Your organization has no documentation entitlements yet.',
          embedOptions(request, null),
        ),
      );
    const release = await readerRelease(ctx, access.context);
    if (typeof release === 'string')
      return send(404, renderEmbedMessage('Not published', release, embedOptions(request, null)));
    const hits =
      path === '/embed/search'
        ? await searchRelease(ctx.pool, release, params.get('q') ?? '')
        : undefined;
    const result = handleEmbedRequest(
      release.view,
      path,
      params,
      { ...embedOptions(request, release.view), topicEnd: FEEDBACK_MARKER },
      hits,
    );
    if (result.location)
      return reply.headers(frameHeaders).redirect(result.location, result.status);
    const event = { surface: 'embed', orgSlug: access.orgSlug, releaseLine: release.line } as const;
    let html = result.html;
    if (result.topicId) {
      ctx.analytics.view(request, { ...event, topicId: result.topicId });
      const feedback = feedbackHtml(request, ctx, result.topicId, 'embed');
      html = html.replace(FEEDBACK_MARKER, () => feedback);
    }
    if (result.search)
      ctx.analytics.search(request, {
        ...event,
        query: result.search.query,
        resultCount: result.search.hits,
      });
    return send(result.status, html);
  };
  app.get('/embed/context', panel);
  app.get('/embed/search', panel);
  app.get('/embed/topics/*', panel);
}

/** The `version` a help API request asks for, when it looks like one; anything else is ignored. */
function requestedVersion(request: FastifyRequest): string | undefined {
  const v = (request.query as { version?: unknown }).version;
  if (typeof v !== 'string') return undefined;
  const version = v.trim();
  return version && version.length <= 32 && parseVersion(version) ? version : undefined;
}

/**
 * The help JSON API: `/api/v1/help/{context,topics/*,search,nav}`.
 *
 * - With an `Authorization` header: an embed token, for its reader, from any
 *   server or from a browser on an OPEND_EMBED_ORIGINS origin. Never cached.
 * - Without one, on a public site: the anonymous public view, at the
 *   `version` the version picker allows (else the default), from anywhere
 *   (`Access-Control-Allow-Origin: *`, no credentials), cacheable for a
 *   minute. On a private site: 401.
 *
 * Every answer from a release says which in `OpenD-Release` and
 * `OpenD-Release-Line`.
 */
function registerHelpApi(
  app: FastifyInstance,
  ctx: AppContext,
  allowed: ReadonlySet<string>,
  bearer: Bearer,
  readerForToken: ReaderForToken,
): void {
  const expose = RELEASE_HEADERS.join(', ');

  /** CORS for token requests: only the configured host origins (or no Origin: a server). */
  const cors = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const origin = request.headers.origin;
    if (!origin) return true; // server-to-server
    if (!allowed.has(origin)) return false;
    void reply.headers({
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization',
      'access-control-allow-methods': 'GET',
      'access-control-expose-headers': expose,
      'access-control-max-age': '600',
    });
    return true;
  };

  app.options('/api/v1/help/*', async (request, reply) => {
    void reply.header('vary', 'Origin');
    if (!cors(request, reply)) return reply.code(403).send();
    return reply.code(204).send();
  });

  interface ApiCaller {
    /** The reader's org, or null for the anonymous public view. */
    orgSlug: string | null;
    release: ReaderRelease;
  }

  const releaseHeaders = (reply: FastifyReply, release: ReaderRelease) =>
    void reply.headers({
      'opend-release': release.view.release.release,
      'opend-release-line': release.line,
    });

  /** The anonymous public view, or null (answered) on a private site or when nothing is live. */
  const anonymousCaller = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ApiCaller | null> => {
    // The same for every origin, and readable by any: it is what the public site shows.
    void reply.headers({
      'access-control-allow-origin': '*',
      'access-control-expose-headers': expose,
      'cache-control': 'private, no-store',
    });
    const repo = await servedSiteRepo(ctx);
    if (repo?.access !== 'public') {
      await reply.code(401).send({ error: 'invalid or missing token' });
      return null;
    }
    const release = await anonymousRelease(ctx, repo, requestedVersion(request));
    if (typeof release === 'string') {
      await reply.code(404).send({ error: release });
      return null;
    }
    void reply.header('cache-control', `public, max-age=${ANONYMOUS_HELP_MAX_AGE}`);
    releaseHeaders(reply, release);
    return { orgSlug: null, release };
  };

  /** Resolves the API caller to a release, or answers the request itself. */
  const apiReader = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ApiCaller | null> => {
    void reply.header('vary', 'Origin, Authorization');
    if (request.headers.authorization === undefined) return anonymousCaller(request, reply);
    if (!cors(request, reply)) {
      await reply.code(403).send({ error: 'origin not allowed' });
      return null;
    }
    void reply.header('cache-control', 'private, no-store');
    const token = bearer(request);
    const result = token ? await readerForToken(token) : 'invalid';
    if (result === 'invalid') {
      await reply.code(401).send({ error: 'invalid or missing token' });
      return null;
    }
    if (result === 'forbidden') {
      await reply.code(403).send({ error: 'no access' });
      return null;
    }
    const access = await getReaderAccess(ctx.pool, result.readerId);
    if (!access?.context) {
      await reply.code(403).send({ error: 'no entitlements' });
      return null;
    }
    const release = await readerRelease(ctx, access.context);
    if (typeof release === 'string') {
      await reply.code(404).send({ error: release });
      return null;
    }
    releaseHeaders(reply, release);
    return { orgSlug: access.orgSlug, release };
  };

  const topicJson = (view: ReleaseView, topicId: string, extra: Record<string, unknown> = {}) => {
    const topic = view.topic(topicId);
    if (!topic) return null;
    const base = `${ctx.config.publicUrl}/`;
    const shortdesc = firstChild(topic.body, 'shortdesc');
    return {
      ...extra,
      topicId,
      title: topic.title,
      shortdesc: shortdesc ? displayText(shortdesc) : '',
      // Absolute links: native renderers decide whether to open them in the docs site.
      html: renderTopic(view, topic, { base }),
      related: navNeighbours(view, topicId).map((e) => ({ topicId: e.topicId!, title: e.title })),
      fullUrl: `${base}${pageHref(topicId, '')}`,
      // The help panel exists only with embedding configured.
      embedUrl: ctx.config.embed
        ? `${ctx.config.publicUrl}/embed/topics/${pageHref(topicId, '')}`
        : null,
    };
  };

  const apiView = (request: FastifyRequest, r: ApiCaller, topicId: string) =>
    ctx.analytics.view(request, {
      surface: 'api',
      orgSlug: r.orgSlug,
      releaseLine: r.release.line,
      topicId,
    });

  app.get('/api/v1/help/context', async (request, reply) => {
    const r = await apiReader(request, reply);
    if (!r) return reply;
    const q = request.query as { app?: string; key?: string; path?: string };
    const req: { app: string; key?: string; path?: string } = { app: q.app ?? '' };
    if (q.key) req.key = q.key;
    else if (q.path) req.path = q.path;
    const resolved = resolveContext(r.release.view, req);
    const body =
      resolved &&
      topicJson(r.release.view, resolved.topicId, {
        key: resolved.key,
        via: resolved.via,
        fragment: resolved.fragment ?? null,
      });
    if (!body) return reply.code(404).send({ error: 'no help for this context' });
    apiView(request, r, body.topicId);
    return reply.send(body);
  });

  app.get('/api/v1/help/topics/*', async (request, reply) => {
    const r = await apiReader(request, reply);
    if (!r) return reply;
    const id = (request.params as { '*': string })['*'];
    const body = topicJson(r.release.view, id);
    if (!body) return reply.code(404).send({ error: 'not found' });
    apiView(request, r, id);
    return reply.send(body);
  });

  // The reader's navigation, filtered exactly as the docs site's contents.
  app.get('/api/v1/help/nav', async (request, reply) => {
    const r = await apiReader(request, reply);
    if (!r) return reply;
    return reply.send({
      title: r.release.view.release.title,
      release: r.release.view.release.release,
      line: r.release.line,
      nav: helpNavJson(visibleNav(r.release.view)),
    });
  });

  app.get('/api/v1/help/search', async (request, reply) => {
    const r = await apiReader(request, reply);
    if (!r) return reply;
    const q = (request.query as { q?: string }).q ?? '';
    const hits = await searchRelease(ctx.pool, r.release, q);
    ctx.analytics.search(request, {
      surface: 'api',
      orgSlug: r.orgSlug,
      releaseLine: r.release.line,
      query: q,
      resultCount: hits.length,
    });
    return reply.send({ query: q, hits });
  });
}

/** One entry of `/api/v1/help/nav`: a topic (with `topicId`) or a heading (without). */
export interface HelpNavEntry {
  title: string;
  /** The id `/api/v1/help/topics/<topicId>` accepts; absent for headings. */
  topicId?: string;
  children: HelpNavEntry[];
}

function helpNavJson(entries: readonly VisibleNavEntry[]): HelpNavEntry[] {
  return entries.map((e) => {
    const out: HelpNavEntry = { title: e.title, children: helpNavJson(e.children) };
    if (e.topicId) out.topicId = e.topicId;
    return out;
  });
}
