import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { CHANNELS, listen, type BlobStore, type Pool } from '@opend/store';
import { jsonLog, type Log } from '@opend/worker';
import { registerAdmin } from './admin.js';
import { registerAuth } from './auth.js';
import type { ServerConfig } from './config.js';
import { Caches, type AppContext } from './context.js';
import { registerDelivery } from './delivery.js';
import { createOidcProvider, type OidcProvider } from './oidc.js';
import { registerWebhook } from './webhook.js';

export interface AppDeps {
  pool: Pool;
  blobs: BlobStore;
  log?: Log;
  /** Override the OIDC provider (tests). Defaults to one built from the config. */
  oidc?: OidcProvider | null;
  /** Listen for cache invalidations over Postgres. Default true. */
  listen?: boolean;
}

export interface OpendApp {
  app: FastifyInstance;
  ctx: AppContext;
}

/** Builds the hosted app. The caller decides whether to `listen()` or `inject()`. */
export async function createApp(config: ServerConfig, deps: AppDeps): Promise<OpendApp> {
  const ctx: AppContext = {
    config,
    pool: deps.pool,
    blobs: deps.blobs,
    log: deps.log ?? jsonLog,
    caches: new Caches(),
    oidc:
      deps.oidc !== undefined
        ? deps.oidc
        : config.oidc
          ? createOidcProvider({
              ...config.oidc,
              allowInsecure: !config.production && config.oidc.issuer.startsWith('http://'),
            })
          : null,
  };

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
  registerDelivery(app, ctx);

  if (deps.listen !== false) {
    const listener = listen(
      config.databaseUrl,
      [CHANNELS.releaseChanged, CHANNELS.entitlementsChanged],
      (channel) => {
        if (channel === CHANNELS.releaseChanged) ctx.caches.releaseChanged();
        else ctx.caches.entitlementsChanged();
      },
      (err) => ctx.log({ level: 'warn', msg: 'listen error', error: String(err) }),
    );
    app.addHook('onReady', async () => listener.ready);
    app.addHook('onClose', async () => listener.stop());
  }

  return { app, ctx };
}
