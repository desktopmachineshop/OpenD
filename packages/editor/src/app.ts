import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { LRUCache } from 'lru-cache';
import type { Pool, Repo } from '@opend/store';
import { GitHubApp, jsonLog, type Log } from '@opend/worker';
import { registerAuth, wantsJson } from './auth.js';
import { editorScript } from './client.js';
import type { EditorConfig } from './config.js';
import { repoResolver, type EditorContext } from './context.js';
import type { GitHubClient } from './github/client.js';
import { createGitHubOAuth, type GitHubOAuth } from './github/oauth.js';
import { RestGitHubClient } from './github/rest.js';
import { createOidcProvider, type OidcProvider } from './oidc.js';
import { EDITOR_CSP, messagePage, PAGE_HEADERS } from './pages.js';
import { registerRoutes } from './routes.js';
import { EditorError, EditorService, type DraftBuild } from './service.js';
import { EDITOR_CSS } from './style.js';

export interface EditorDeps {
  pool: Pool;
  log?: Log;
  /** `fetch` for GitHub (API and OAuth). Tests pass `FakeGitHub.fetch`. */
  fetch?: typeof fetch;
  /** Override the GitHub client per repository (tests). Defaults to the App's REST client. */
  clientFor?: (repo: Repo & { installationId: number }) => GitHubClient;
  /** Override sign-in providers (tests). Default: built from the config. */
  oidc?: OidcProvider | null;
  githubOAuth?: GitHubOAuth | null;
}

export interface EditorApp {
  app: FastifyInstance;
  ctx: EditorContext;
}

/** Builds the editor app. The caller decides whether to `listen()` or `inject()`. */
export async function createEditorApp(config: EditorConfig, deps: EditorDeps): Promise<EditorApp> {
  const fetchImpl = deps.fetch ?? fetch;
  let clientFor = deps.clientFor;
  if (!clientFor) {
    const githubApp = new GitHubApp(config.github, fetchImpl);
    clientFor = (repo) => new RestGitHubClient(githubApp, repo.fullName, repo.installationId);
  }
  const ctx: EditorContext = {
    config,
    pool: deps.pool,
    log: deps.log ?? jsonLog,
    service: new EditorService(deps.pool),
    clientFor,
    drafts: new LRUCache<string, DraftBuild>({ max: 200, ttl: 30 * 60_000 }),
    oidc:
      deps.oidc !== undefined
        ? deps.oidc
        : config.oidc
          ? createOidcProvider({
              ...config.oidc,
              allowInsecure: !config.production && config.oidc.issuer.startsWith('http://'),
            })
          : null,
    githubOAuth:
      deps.githubOAuth !== undefined
        ? deps.githubOAuth
        : config.githubOAuth
          ? createGitHubOAuth(config.githubOAuth, fetchImpl)
          : null,
    repoContext: async () => {
      throw new Error('unreachable');
    },
  };
  ctx.repoContext = repoResolver(config, deps.pool, clientFor);

  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie, { secret: config.sessionSecret });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  app.addHook('onSend', async (_request, reply, payload) => {
    // Every response gets the strict CSP unless it set its own (previews, assets).
    if (!reply.hasHeader('content-security-policy'))
      reply.header('content-security-policy', EDITOR_CSP);
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    ctx.log({
      level: 'info',
      msg: 'request',
      method: request.method,
      url: request.url.split('?')[0],
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });
  app.setErrorHandler(async (err, request, reply) => {
    const known = err instanceof EditorError;
    const status = known
      ? err.status
      : ((err as { statusCode?: number }).statusCode ?? 500) < 500
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (!known || status >= 500)
      ctx.log({
        level: 'error',
        msg: 'editor request failed',
        url: request.url.split('?')[0],
        error: String(err),
      });
    const message =
      known || status < 500
        ? err instanceof Error
          ? err.message
          : String(err)
        : 'Something went wrong. Try again.';
    const html = String(request.headers.accept ?? '').includes('text/html');
    if (wantsJson(request) || (request.method !== 'GET' && !html))
      return reply.code(status).send({ error: message, ...(known ? err.detail : {}) });
    return reply
      .code(status)
      .headers(PAGE_HEADERS)
      .type('text/html; charset=utf-8')
      .send(
        messagePage(
          status === 410 ? 'Expired' : status === 403 ? 'Not allowed' : 'Problem',
          message,
        ),
      );
  });

  app.get('/healthz', async (_request, reply) => {
    await ctx.pool.query('select 1');
    return reply.send({ status: 'ok' });
  });
  const script = editorScript();
  app.get('/assets/editor.js', async (_request, reply) =>
    reply
      .headers({ 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' })
      .type('text/javascript; charset=utf-8')
      .send(script),
  );
  app.get('/assets/editor.css', async (_request, reply) =>
    reply
      .headers({ 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' })
      .type('text/css; charset=utf-8')
      .send(EDITOR_CSS),
  );
  registerAuth(app, ctx);
  registerRoutes(app, ctx);
  return { app, ctx };
}
