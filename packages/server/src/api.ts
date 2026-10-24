import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { releaseLine, visibleNav, type VisibleNavEntry } from '@opend/filter';
import { displayText, firstChild } from '@opend/model';
import { pageHref, renderMarkdown, renderTopic } from '@opend/render-html';
import {
  listLiveReleases,
  listOrgs,
  verifyApiKey,
  type ApiKey,
  type ApiScope,
  type Repo,
} from '@opend/store';
import { readerAudience, type Audience } from './access.js';
import { OPENAPI } from './api-spec.js';
import { registerApiWrites } from './api-writes.js';
import type { AppContext } from './context.js';
import { audienceRelease, sitePublicAudience, siteRepo, type ReaderRelease } from './delivery.js';
import { searchRelease } from './search.js';

/**
 * The public API, `/api/v1`: the docs as a key's audience sees them (filtered
 * exactly as the site is), and with the `write`, `publish` and `builds` scopes,
 * changes to the docs source and builds. Keys are made by staff in the admin
 * console or the admin API; see ADR 0014.
 */

/** Requests a key may make per minute. */
const RATE_LIMIT = 300;

export interface ApiCaller {
  key: ApiKey;
}

/** An error answered as `{ error }` with a status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1]! : null;
}

export function registerApi(app: FastifyInstance, ctx: AppContext): void {
  const windows = new Map<number, { start: number; count: number }>();

  /** The calling key, when it is valid and has `scope`; otherwise answers the request itself. */
  const caller = async (
    request: FastifyRequest,
    reply: FastifyReply,
    scope: ApiScope,
  ): Promise<ApiCaller | null> => {
    void reply.header('cache-control', 'private, no-store');
    const token = bearerToken(request);
    const key = token ? await verifyApiKey(ctx.pool, token) : null;
    if (!key) {
      await reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="opend"')
        .send({ error: 'missing, invalid, revoked or expired API key' });
      return null;
    }
    const now = Date.now();
    const w = windows.get(key.id);
    if (!w || now - w.start >= 60_000) windows.set(key.id, { start: now, count: 1 });
    else if (++w.count > RATE_LIMIT) {
      await reply
        .code(429)
        .header('retry-after', String(Math.ceil((w.start + 60_000 - now) / 1000)))
        .send({ error: `rate limit: ${RATE_LIMIT} requests a minute per key` });
      return null;
    }
    if (!key.scopes.includes(scope)) {
      await reply.code(403).send({ error: `this key does not have the ${scope} scope` });
      return null;
    }
    return { key };
  };

  /** Runs a handler for a key with `scope`, answering ApiErrors as JSON. */
  const handle =
    (scope: ApiScope, run: (c: ApiCaller, request: FastifyRequest) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const c = await caller(request, reply, scope);
      if (!c) return reply;
      try {
        const body = await run(c, request);
        if (reply.sent) return reply;
        return reply.send(body);
      } catch (err) {
        if (err instanceof ApiError)
          return reply.code(err.status).send({ error: err.message, ...err.extra });
        throw err;
      }
    };

  const base = () => ctx.config.publicUrl;

  app.get('/api/v1', async (_request, reply) =>
    reply.header('cache-control', 'no-cache').send({
      name: 'OpenD API',
      version: 1,
      openapi: `${base()}/api/v1/openapi.json`,
    }),
  );
  app.get('/api/v1/openapi.json', async (_request, reply) =>
    reply
      .header('cache-control', 'no-cache')
      .send({ ...OPENAPI, servers: [{ url: `${base()}/api/v1` }] }),
  );

  app.get(
    '/api/v1/me',
    handle('read', async ({ key }) => ({
      key: {
        id: key.id,
        name: key.name,
        scopes: key.scopes,
        audience: key.audience,
        org: key.orgSlug,
        expiresAt: key.expiresAt,
      },
      site: { url: base() },
    })),
  );

  app.get(
    '/api/v1/versions',
    handle('read', async ({ key }) => {
      const repo = await requireRepo(ctx);
      const live = await listLiveReleases(ctx.pool, repo.id);
      const release = await releaseFor(ctx, key, undefined);
      // Only staff keys may pick a release line; others read their own.
      const lines =
        key.audience === 'staff' ? live : live.filter((l) => l.releaseLine === release.line);
      return {
        current: release.line,
        versions: lines.map((l) => ({ line: l.releaseLine, release: l.release, commit: l.sha })),
      };
    }),
  );

  app.get(
    '/api/v1/nav',
    handle('read', async ({ key }, request) => {
      const release = await releaseFor(ctx, key, version(request));
      return {
        version: release.line,
        title: release.view.release.title,
        nav: navJson(visibleNav(release.view), base()),
      };
    }),
  );

  app.get(
    '/api/v1/topics',
    handle('read', async ({ key }, request) => {
      const release = await releaseFor(ctx, key, version(request));
      const { view } = release;
      return {
        version: release.line,
        topics: view.topicIds().map((id) => {
          const topic = view.topic(id)!;
          const shortdesc = firstChild(topic.body, 'shortdesc');
          return {
            id,
            title: topic.title,
            shortdesc: shortdesc ? displayText(shortdesc) : '',
            url: `${base()}/${pageHref(id, '')}`,
          };
        }),
      };
    }),
  );

  app.get(
    '/api/v1/topics/*',
    handle('read', async ({ key }, request) => {
      const id = (request.params as { '*': string })['*'];
      const format = (request.query as { format?: string }).format ?? 'markdown';
      if (!['markdown', 'html', 'text'].includes(format))
        throw new ApiError(400, 'format must be markdown, html or text');
      const release = await releaseFor(ctx, key, version(request));
      const { view } = release;
      const topic = view.topic(id);
      if (!topic) throw new ApiError(404, 'no such topic');
      const shortdesc = firstChild(topic.body, 'shortdesc');
      const options = {
        base: `${base()}/`,
        showConditions: release.audience.context === null,
      };
      const content =
        format === 'html'
          ? renderTopic(view, topic, options)
          : format === 'text'
            ? displayText(topic.body).replace(/\s+/g, ' ').trim()
            : renderMarkdown(view, topic, options);
      return {
        id,
        version: release.line,
        title: topic.title,
        shortdesc: shortdesc ? displayText(shortdesc) : '',
        source: topic.file,
        url: `${base()}/${pageHref(id, '')}`,
        format,
        content,
      };
    }),
  );

  app.get(
    '/api/v1/search',
    handle('read', async ({ key }, request) => {
      const q = request.query as { q?: string; limit?: string };
      const query = (q.q ?? '').slice(0, 200);
      if (!query.trim()) throw new ApiError(400, 'q is required');
      const limit = Math.min(50, Math.max(1, Number(q.limit ?? 10) || 10));
      const release = await releaseFor(ctx, key, version(request));
      const hits = await searchRelease(ctx.pool, release, query, limit);
      return {
        query,
        version: release.line,
        hits: hits.map((h) => ({ ...h, url: `${base()}/${pageHref(h.topicId, '')}` })),
      };
    }),
  );

  registerApiWrites(app, ctx, handle);
}

export type ApiHandle = (
  scope: ApiScope,
  run: (c: ApiCaller, request: FastifyRequest) => Promise<unknown>,
) => (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function version(request: FastifyRequest): string | undefined {
  const v = (request.query as { version?: unknown }).version;
  return typeof v === 'string' && v ? v : undefined;
}

export async function requireRepo(ctx: AppContext): Promise<Repo> {
  const repo = await siteRepo(ctx);
  if (!repo) throw new ApiError(503, 'no documentation site is configured yet');
  return repo;
}

/**
 * The release a key reads, filtered for its audience. Staff keys may choose a
 * live release line with `version`; org and public keys read their own line.
 */
export async function releaseFor(
  ctx: AppContext,
  key: ApiKey,
  requested: string | undefined,
): Promise<ReaderRelease> {
  const repo = await requireRepo(ctx);
  let audience: Audience;
  if (key.audience === 'staff') {
    const line = requested ? releaseLine(requested, repo.releaseLines) : null;
    if (requested && !line) throw new ApiError(400, 'version must look like 2 or 2.1');
    audience = { key: 'staff', context: null, line };
  } else if (key.audience === 'org') {
    const org = (await listOrgs(ctx.pool)).find((o) => o.slug === key.orgSlug);
    if (!org?.version) throw new ApiError(403, 'the key’s org has no entitlements');
    audience = readerAudience(
      { products: org.products, features: org.features, version: org.version },
      repo.releaseLines,
    );
  } else {
    if (repo.access !== 'public') throw new ApiError(403, 'the site is private');
    audience = await sitePublicAudience(ctx, repo);
  }
  if (
    requested &&
    key.audience !== 'staff' &&
    releaseLine(requested, repo.releaseLines) !== audience.line
  )
    throw new ApiError(403, `this key reads release ${audience.line ?? 'the newest'} only`);
  const release = await audienceRelease(ctx, repo, audience);
  if (typeof release === 'string') throw new ApiError(404, release);
  return release;
}

interface NavJson {
  title: string;
  topicId?: string;
  url?: string;
  children: NavJson[];
}

/** The reader's navigation (see `visibleNav`): hidden topics never appear, not even their navtitles. */
function navJson(entries: readonly VisibleNavEntry[], base: string): NavJson[] {
  return entries.map((e) => {
    const out: NavJson = { title: e.title, children: navJson(e.children, base) };
    if (e.topicId) {
      out.topicId = e.topicId;
      out.url = `${base}/${pageHref(e.topicId, '')}${e.fragment ? `#${e.fragment}` : ''}`;
    }
    return out;
  });
}
