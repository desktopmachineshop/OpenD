import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { createGitHubOAuth } from '@opend/editor';
import { createPdfRenderer, type PdfRenderer } from '@opend/pdf';
import {
  CHANNELS,
  SecretBox,
  SettingsCache,
  deriveSecretKey,
  listen,
  storedGitHubApp,
  type BlobStore,
  type Pool,
} from '@opend/store';
import { GitHubConnection, jsonLog, type Log } from '@opend/worker';
import { registerAdminConsole } from './admin-console.js';
import { registerAdmin } from './admin.js';
import { Analytics } from './analytics.js';
import { registerAuth } from './auth.js';
import type { ServerConfig } from './config.js';
import { Caches, type AppContext } from './context.js';
import { registerDelivery } from './delivery.js';
import { registerEmbed } from './embed.js';
import { registerFeedback } from './feedback.js';
import { registerPdf } from './pdf.js';
import { registerEntitlementSync } from './entitlement-sync.js';
import { createOidcProvider, type OidcProvider } from './oidc.js';
import { effectiveConfig } from './settings.js';
import { registerWebhook } from './webhook.js';

export interface AppDeps {
  pool: Pool;
  blobs: BlobStore;
  log?: Log;
  /** Override the OIDC provider (tests). Defaults to one built from the config. */
  oidc?: OidcProvider | null;
  /** Listen for cache invalidations over Postgres. Default true. */
  listen?: boolean;
  /** Override the PDF renderer (tests). Defaults to headless Chromium, launched on first use. */
  pdf?: PdfRenderer;
  /** `fetch` for GitHub sign-in and the GitHub App (tests pass a fake GitHub's). */
  githubFetch?: typeof fetch;
}

export interface OpendApp {
  app: FastifyInstance;
  ctx: AppContext;
}

/** Builds the hosted app. The caller decides whether to `listen()` or `inject()`. */
export async function createApp(config: ServerConfig, deps: AppDeps): Promise<OpendApp> {
  const log = deps.log ?? jsonLog;
  const githubFetch = deps.githubFetch ?? fetch;
  const key = deriveSecretKey({ secretKey: config.secretKey, sessionSecret: config.sessionSecret });
  const settings = new SettingsCache(deps.pool, key ? new SecretBox(key) : null, () => apply());
  const github = new GitHubConnection({
    app: config.github ?? null,
    broker: config.broker ?? null,
    stored: () => {
      const app = storedGitHubApp(settings.current);
      return app ? { appId: app.appId, privateKey: app.privateKey, apiUrl: app.apiUrl } : null;
    },
    ...(config.githubApiUrl ? { apiUrl: config.githubApiUrl } : {}),
    ...(config.githubWebUrl ? { webUrl: config.githubWebUrl } : {}),
    fetch: githubFetch,
    log: (entry) => ctx.log(entry),
  });
  const ctx: AppContext = {
    config,
    env: config,
    settings,
    github,
    githubFetch,
    reloadSettings: async () => {
      await settings.reload();
    },
    pool: deps.pool,
    blobs: deps.blobs,
    log,
    // Through ctx.log, so a log swapped in later (tests) is the one used.
    analytics: new Analytics(deps.pool, (entry) => ctx.log(entry), config.analytics),
    caches: new Caches(),
    pdf: deps.pdf ?? createPdfRenderer(),
    githubOAuth: null,
    repoPermission: async (repo, login) => {
      const mode = github.mode();
      if (mode === 'none' || (mode !== 'broker' && repo.installationId === null)) return null;
      const res = await github.request(
        repo,
        'GET',
        `/repos/${repo.fullName}/collaborators/${encodeURIComponent(login)}/permission`,
      );
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`GitHub permission check failed: ${res.status}`);
      const permission = (res.data as { permission?: unknown } | null)?.permission;
      return typeof permission === 'string' ? permission : null;
    },
    oidc: deps.oidc ?? null,
  };

  // Sign-in providers follow the effective settings; rebuilt only when theirs change.
  let oidcKey = '';
  let githubKey = '';
  function apply() {
    ctx.config = effectiveConfig(config, settings.current);
    if (deps.oidc === undefined) {
      const oidc = ctx.config.oidc;
      const next = oidc
        ? JSON.stringify([oidc.issuer, oidc.clientId, oidc.clientSecret, oidc.scopes])
        : '';
      if (next !== oidcKey) {
        oidcKey = next;
        ctx.oidc = oidc
          ? createOidcProvider({
              ...oidc,
              allowInsecure: !config.production && oidc.issuer.startsWith('http://'),
            })
          : null;
      }
    }
    const oauth = ctx.config.githubOAuth;
    const next = oauth ? JSON.stringify([oauth.clientId, oauth.clientSecret, oauth.webUrl]) : '';
    if (next !== githubKey) {
      githubKey = next;
      ctx.githubOAuth = oauth ? createGitHubOAuth(oauth, githubFetch) : null;
    }
  }
  try {
    await settings.reload();
  } catch (err) {
    // Not migrated yet, or the database is briefly away: serve the environment's settings.
    log({ level: 'warn', msg: 'settings not loaded', error: String(err) });
    apply();
  }

  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 25 * 1024 * 1024 });
  await app.register(cookie, { secret: config.sessionSecret });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
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
    ctx.log({
      level: 'error',
      msg: 'request failed',
      url: request.url.split('?')[0],
      error: String(err),
    });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return reply
      .code(status >= 400 && status < 500 ? status : 500)
      .send({ error: status < 500 ? message : 'internal error' });
  });

  app.get('/healthz', async (_request, reply) => {
    await ctx.pool.query('select 1');
    return reply.send({ status: 'ok' });
  });
  registerWebhook(app, ctx);
  registerAuth(app, ctx);
  registerAdmin(app, ctx);
  registerAdminConsole(app, ctx);
  registerEntitlementSync(app, ctx);
  registerEmbed(app, ctx);
  registerPdf(app, ctx);
  registerFeedback(app, ctx);
  registerDelivery(app, ctx);
  app.addHook('onClose', async () => ctx.analytics.flush());
  // The default renderer is ours to close; an injected one belongs to the caller.
  if (!deps.pdf) app.addHook('onClose', async () => ctx.pdf.close());

  // A missed notification is bounded: settings older than a minute are re-read in the background.
  const settingsError = (err: unknown) =>
    ctx.log({ level: 'warn', msg: 'settings reload failed', error: String(err) });
  app.addHook('onRequest', async () => settings.refreshIfStale(60_000, settingsError));

  if (deps.listen !== false) {
    const listener = listen(
      config.databaseUrl,
      [CHANNELS.releaseChanged, CHANNELS.entitlementsChanged, CHANNELS.settingsChanged],
      (channel) => {
        if (channel === CHANNELS.releaseChanged) ctx.caches.releaseChanged();
        else if (channel === CHANNELS.settingsChanged) void settings.reload().catch(settingsError);
        else ctx.caches.entitlementsChanged();
      },
      (err) => ctx.log({ level: 'warn', msg: 'listen error', error: String(err) }),
    );
    app.addHook('onReady', async () => listener.ready);
    app.addHook('onClose', async () => listener.stop());
  }

  return { app, ctx };
}
