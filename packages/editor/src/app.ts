import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { LRUCache } from 'lru-cache';
import {
  SecretBox,
  SettingsCache,
  storedGitHubApp,
  type Pool,
  type Repo,
  type SettingsSnapshot,
} from '@opend/store';
import { GitHubConnection, jsonLog, type Log } from '@opend/worker';
import { registerAuth, wantsJson } from './auth.js';
import { editorScript } from './client.js';
import type { EditorConfig } from './config.js';
import { repoResolver, type EditorContext } from './context.js';
import type { GitHubClient } from './github/client.js';
import { createGitHubOAuth, isGitHubAppClientId, type GitHubOAuth } from './github/oauth.js';
import { RestGitHubClient } from './github/rest.js';
import { RestUserGitHubClient } from './github/user.js';
import { createOidcProvider, type OidcProvider } from './oidc.js';
import { EDITOR_CSP, messagePage, PAGE_HEADERS } from './pages.js';
import { registerRoutes } from './routes.js';
import {
  EditorError,
  EditorService,
  type DraftBuild,
  type EditorServiceOptions,
} from './service.js';
import { EDITOR_CSS } from './style.js';
import { EditorTokens } from './tokens.js';

export interface EditorDeps {
  pool: Pool;
  log?: Log;
  /** `fetch` for GitHub (API and OAuth). Tests pass `FakeGitHub.fetch`. */
  fetch?: typeof fetch;
  /** Override the GitHub client per repository (tests). Defaults to the App's REST client. */
  clientFor?: (repo: Repo) => GitHubClient;
  /** Override sign-in providers (tests). Default: built from the config. */
  oidc?: OidcProvider | null;
  githubOAuth?: GitHubOAuth | null;
  /** Reload settings on Postgres notifications. Default true. */
  listen?: boolean;
  /** Service tuning (tests shorten the update-branch polling). */
  service?: Omit<EditorServiceOptions, 'userClient'>;
}

/**
 * GitHub sign-in for authors: the environment's OAuth credentials, or the
 * connected app's. `githubApp`: the credentials are a GitHub App's, whose user
 * tokens the editor keeps to commit as the author.
 */
function storedOAuth(
  config: EditorConfig,
  snapshot: SettingsSnapshot,
): {
  clientId: string;
  clientSecret: string;
  webUrl: string;
  apiUrl?: string;
  githubApp: boolean;
} | null {
  if (config.githubOAuth)
    return { ...config.githubOAuth, githubApp: isGitHubAppClientId(config.githubOAuth.clientId) };
  const app = storedGitHubApp(snapshot);
  if (!app?.clientId || !app.clientSecret) return null;
  return {
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    webUrl: app.webUrl,
    apiUrl: app.apiUrl,
    githubApp: true,
  };
}

export interface EditorApp {
  app: FastifyInstance;
  ctx: EditorContext;
}

/** Builds the editor app. The caller decides whether to `listen()` or `inject()`. */
export async function createEditorApp(config: EditorConfig, deps: EditorDeps): Promise<EditorApp> {
  const fetchImpl = deps.fetch ?? fetch;
  const settings = new SettingsCache(
    deps.pool,
    config.secretKey ? new SecretBox(config.secretKey) : null,
  );
  await settings.reload();
  const github = new GitHubConnection({
    app: config.github ?? null,
    broker: config.broker ?? null,
    stored: () => {
      const app = storedGitHubApp(settings.current);
      return app ? { appId: app.appId, privateKey: app.privateKey, apiUrl: app.apiUrl } : null;
    },
    ...(config.githubApiUrl ? { apiUrl: config.githubApiUrl } : {}),
    webUrl: config.githubWebUrl,
    fetch: fetchImpl,
    log: (entry) => ctx.log(entry),
  });
  const clientFor = deps.clientFor ?? ((repo: Repo) => new RestGitHubClient(github, repo));
  let oauthKey = '';
  let userApiUrl = config.githubApiUrl ?? 'https://api.github.com';
  const ctx: EditorContext = {
    config,
    pool: deps.pool,
    log: deps.log ?? jsonLog,
    service: new EditorService(deps.pool, {
      ...deps.service,
      userClient: (repo, source) =>
        new RestUserGitHubClient(source, repo, { apiUrl: userApiUrl, fetch: fetchImpl }),
    }),
    github,
    settings,
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
    githubOAuth: deps.githubOAuth ?? null,
    keepsGitHubTokens: false,
    tokens: new EditorTokens(
      deps.pool,
      () => settings.secretBox,
      () => ctx.githubOAuth,
      (entry) => ctx.log(entry),
    ),
    repoContext: async () => {
      throw new Error('unreachable');
    },
  };
  ctx.repoContext = repoResolver(config, deps.pool, clientFor, () => github.mode() !== 'broker');
  // Author sign-in follows Connect GitHub in the docs site's admin console, without a restart.
  const applySettings = () => {
    if (deps.githubOAuth !== undefined) return;
    const oauth = storedOAuth(config, settings.current);
    const key = oauth ? JSON.stringify(oauth) : '';
    if (key === oauthKey) return;
    oauthKey = key;
    ctx.githubOAuth = oauth ? createGitHubOAuth(oauth, fetchImpl) : null;
    ctx.keepsGitHubTokens = oauth?.githubApp === true;
    userApiUrl = oauth?.apiUrl ?? config.githubApiUrl ?? 'https://api.github.com';
  };
  applySettings();

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
    // Refusals that GitHub sign-in fixes say where to sign in, when it can help.
    const signIn =
      known &&
      (err.detail.signedCommitsRequired === true || err.detail.githubSignIn === true) &&
      ctx.githubOAuth !== null &&
      ctx.keepsGitHubTokens &&
      ctx.tokens.canStore
        ? { signInUrl: '/auth/github?returnTo=%2F' }
        : {};
    if (wantsJson(request) || (request.method !== 'GET' && !html))
      return reply.code(status).send({ error: message, ...(known ? err.detail : {}), ...signIn });
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
  const onError = (err: unknown) =>
    ctx.log({ level: 'warn', msg: 'settings reload failed', error: String(err) });
  app.addHook('onRequest', async () => {
    settings.refreshIfStale(60_000, onError);
    applySettings();
  });
  if (deps.listen !== false) {
    const listener = settings.listen(config.databaseUrl, onError);
    app.addHook('onReady', async () => listener.ready);
    app.addHook('onClose', async () => listener.stop());
  }
  return { app, ctx };
}
