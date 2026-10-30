import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPdfRenderer, type PdfRenderer } from '@opend/pdf';
import {
  SecretBox,
  createBlobStore,
  createPool,
  deriveSecretKey,
  listen,
  migrate,
  notify,
  type Listener,
  type Pool,
} from '@opend/store';
import { jsonLog, type Log } from '@opend/worker';
import { loadConfig } from '../config.js';
import { messagePage } from '../pages.js';
import { SiteApps } from './apps.js';
import { proxy, type Forward } from './forward.js';
import { normaliseHost, siteDatabaseUrl, siteEnv, type FleetConfig } from './config.js';
import { Registry, migrateRegistry, type Site } from './registry.js';

/** Registry changes, so every fleet replica drops cached hosts and restarts changed sites. */
export const FLEET_CHANGED = 'opend_fleet_changed';

export interface Fleet {
  server: Server;
  admin: FastifyInstance;
  registry: Registry;
  apps: SiteApps;
  pool: Pool;
  close(): Promise<void>;
}

const hostSchema = z
  .string()
  .transform(normaliseHost)
  .pipe(
    z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'a host name'),
  );
const envSchema = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().max(16_384));
const createSchema = z.object({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
  hosts: z.array(hostSchema).min(1).max(10),
  editorHosts: z.array(hostSchema).max(10).default([]),
  env: envSchema,
});
/** http is allowed only to loopback and private-network hosts; anything else must be https. */
const privateHost = (host: string) =>
  host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.internal');
const forwardSchema = z.object({
  upstream: z
    .url()
    .transform((u) => new URL(u))
    .refine(
      (u) =>
        (u.protocol === 'https:' || (u.protocol === 'http:' && privateHost(u.hostname))) &&
        u.pathname === '/' &&
        !u.search &&
        !u.hash &&
        !u.username,
      'an https origin (http only to a private host)',
    )
    .transform((u) => u.origin),
});
const patchSchema = z.object({
  hosts: z.array(hostSchema).min(1).max(10).optional(),
  editorHosts: z.array(hostSchema).max(10).optional(),
  env: envSchema.optional(),
});

/** What the admin API shows of a site: never its settings' values (they hold secrets). */
function view(site: Site) {
  return {
    slug: site.slug,
    schema: site.schema,
    hosts: site.hosts,
    editorHosts: site.editorHosts,
    status: site.status,
    settings: Object.keys(site.env).sort(),
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(messagePage(title, body));
}

/**
 * Migrates the registry and every site's schema, as `migrate` does for a single
 * site. Run before each fleet deploy (the image's pre-deploy command), so an
 * upgrade reaches every site before the new version serves it.
 */
export async function migrateFleet(
  fleet: FleetConfig,
  log: Log = jsonLog,
): Promise<{ site: string; ran: string[] }[]> {
  const pool = createPool(fleet.databaseUrl);
  try {
    await migrateRegistry(pool);
    const registry = new Registry(pool, new SecretBox(deriveSecretKey({ secretKey: fleet.key })!));
    const results: { site: string; ran: string[] }[] = [];
    for (const site of await registry.list()) {
      const sitePool = createPool(siteDatabaseUrl(fleet.databaseUrl, site.schema), undefined, {
        max: 1,
      });
      try {
        const ran = await migrate(sitePool);
        results.push({ site: site.slug, ran });
        if (ran.length) log({ level: 'info', msg: 'site migrated', site: site.slug, ran });
      } finally {
        await sitePool.end();
      }
    }
    return results;
  } finally {
    await pool.end();
  }
}

export async function startFleet(
  fleet: FleetConfig,
  deps: { log?: Log; pdf?: PdfRenderer } = {},
): Promise<Fleet> {
  const log = deps.log ?? jsonLog;
  const key = deriveSecretKey({ secretKey: fleet.key })!;
  const pool = createPool(fleet.databaseUrl);
  await migrateRegistry(pool);
  const registry = new Registry(pool, new SecretBox(key));
  const pdf = deps.pdf ?? createPdfRenderer();
  const apps = new SiteApps(fleet, { pdf, log });

  // Host → site or forward, briefly cached; registry changes clear it on every replica.
  type Found =
    | { site: Site; editor: boolean; forward?: undefined }
    | { forward: Forward; site?: undefined }
    | null;
  const hosts = new Map<string, { at: number; found: Found }>();
  const lookup = async (host: string): Promise<Found> => {
    const hit = hosts.get(host);
    if (hit && Date.now() - hit.at < 15_000) return hit.found;
    const site = await registry.byHost(host);
    const forward = site ? null : await registry.forwardFor(host);
    const found: Found = site ?? (forward ? { forward } : null);
    hosts.set(host, { at: Date.now(), found });
    if (hosts.size > 10_000) hosts.clear();
    return found;
  };
  const changed = async (slug: string) => {
    hosts.clear();
    await apps.closeSite(slug);
  };
  const listener: Listener = listen(
    fleet.databaseUrl,
    [FLEET_CHANGED],
    (_channel, slug) => void changed(slug),
    (err) => log({ level: 'warn', msg: 'fleet listen error', error: String(err) }),
  );
  const announce = async (slug: string) => {
    await changed(slug);
    await notify(pool, FLEET_CHANGED, slug);
  };

  const admin = Fastify({ logger: false, trustProxy: true, bodyLimit: 1024 * 1024 });
  admin.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const expected = `Bearer ${fleet.token}`;
    const ok =
      header.length === expected.length &&
      timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    if (!ok) return reply.code(401).send({ error: 'fleet token required' });
  });
  admin.get('/fleet/api/sites', async () => (await registry.list()).map(view));
  admin.get('/fleet/api/sites/:slug', async (request, reply) => {
    const site = await registry.get((request.params as { slug: string }).slug);
    return site ? view(site) : reply.code(404).send({ error: 'no such site' });
  });
  admin.post('/fleet/api/sites', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    const input = parsed.data;
    if (await registry.get(input.slug)) return reply.code(409).send({ error: 'the slug is taken' });
    const all = [...input.hosts, ...input.editorHosts];
    if (all.includes(fleet.host))
      return reply.code(400).send({ error: 'that is the fleet’s own host' });
    const taken = await registry.hostsTaken(all);
    if (taken.length) return reply.code(409).send({ error: `hosts in use: ${taken.join(', ')}` });
    const site = await registry.create(input);
    try {
      // The settings must make a valid single-site configuration.
      loadConfig(siteEnv(fleet, site));
      await pool.query(`create schema if not exists "${site.schema}"`);
      const sitePool = createPool(siteDatabaseUrl(fleet.databaseUrl, site.schema), undefined, {
        max: 1,
      });
      try {
        await migrate(sitePool);
      } finally {
        await sitePool.end();
      }
    } catch (err) {
      await pool.query(`drop schema if exists "${site.schema}" cascade`).catch(() => {});
      await registry.remove(site.slug);
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    log({ level: 'info', msg: 'site created', site: site.slug });
    return reply.code(201).send(view(site));
  });
  admin.patch('/fleet/api/sites/:slug', async (request, reply) => {
    const slug = (request.params as { slug: string }).slug;
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    const current = await registry.get(slug);
    if (!current) return reply.code(404).send({ error: 'no such site' });
    const all = [...(parsed.data.hosts ?? []), ...(parsed.data.editorHosts ?? [])];
    if (all.includes(fleet.host))
      return reply.code(400).send({ error: 'that is the fleet’s own host' });
    const taken = await registry.hostsTaken(all, slug);
    if (taken.length) return reply.code(409).send({ error: `hosts in use: ${taken.join(', ')}` });
    if (parsed.data.env) {
      try {
        loadConfig(siteEnv(fleet, { ...current, env: parsed.data.env }));
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    const site = await registry.update(slug, parsed.data);
    await announce(slug);
    return view(site!);
  });
  // Forwards: hosts under the fleet's domain served by a dedicated instance elsewhere.
  admin.get('/fleet/api/forwards', async () => registry.forwards());
  admin.put('/fleet/api/forwards/:host', async (request, reply) => {
    const host = hostSchema.safeParse((request.params as { host: string }).host);
    const parsed = forwardSchema.safeParse(request.body);
    if (!host.success) return reply.code(400).send({ error: 'host: a host name' });
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    if (host.data === fleet.host)
      return reply.code(400).send({ error: 'that is the fleet’s own host' });
    if (await registry.byHost(host.data))
      return reply.code(409).send({ error: `a site serves ${host.data}` });
    const upstreamHost = new URL(parsed.data.upstream).host;
    if (upstreamHost === host.data || (await registry.byHost(upstreamHost)))
      return reply.code(400).send({ error: 'the upstream must be another server' });
    const forward = { host: host.data, upstream: parsed.data.upstream };
    await registry.setForward(forward);
    await announce('');
    log({ level: 'info', msg: 'forward set', ...forward });
    return forward;
  });
  admin.delete('/fleet/api/forwards/:host', async (request, reply) => {
    const host = normaliseHost((request.params as { host: string }).host);
    if (!(await registry.removeForward(host)))
      return reply.code(404).send({ error: 'no such forward' });
    await announce('');
    return reply.code(204).send();
  });
  for (const [action, status] of [
    ['suspend', 'suspended'],
    ['resume', 'active'],
  ] as const) {
    admin.post(`/fleet/api/sites/:slug/${action}`, async (request, reply) => {
      const slug = (request.params as { slug: string }).slug;
      const site = await registry.update(slug, { status });
      if (!site) return reply.code(404).send({ error: 'no such site' });
      await announce(slug);
      return view(site);
    });
  }
  admin.delete('/fleet/api/sites/:slug', async (request, reply) => {
    const slug = (request.params as { slug: string }).slug;
    const site = await registry.get(slug);
    if (!site) return reply.code(404).send({ error: 'no such site' });
    await registry.update(slug, { status: 'suspended' });
    await announce(slug);
    const blobs = createBlobStore(loadConfig(siteEnv(fleet, site)).blobs);
    await blobs.clear?.();
    await pool.query(`drop schema if exists "${site.schema}" cascade`);
    await registry.remove(slug);
    await announce(slug);
    log({ level: 'info', msg: 'site deleted', site: slug });
    return reply.code(204).send();
  });
  await admin.ready();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const host = normaliseHost(req.headers.host ?? '');
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/healthz' && (host === fleet.host || !host || host.endsWith('.railway.app'))) {
        await pool.query('select 1');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', sites: apps.size }));
        return;
      }
      if (host === fleet.host) return admin.routing(req, res);
      const redirect = fleet.redirects.get(host);
      if (redirect) {
        res.writeHead(301, {
          location: `${redirect}${req.url ?? '/'}`,
          'cache-control': 'max-age=3600',
        });
        res.end();
        return;
      }
      const found = await lookup(host);
      if (!found)
        return page(res, 404, 'No site here', 'There is no documentation site at this address.');
      if (found.forward)
        return proxy(req, res, found.forward, (err) => {
          log({ level: 'warn', msg: 'forward failed', host, error: String(err) });
          if (!res.headersSent)
            page(
              res,
              502,
              'Site unavailable',
              'This documentation site did not answer. Please try again in a moment.',
            );
          else res.destroy();
        });
      if (found.site.status !== 'active')
        return page(
          res,
          503,
          'Site paused',
          'This documentation site is paused. Please try again later.',
        );
      const handle = await apps.handler(found.site, found.editor ? 'editor' : 'web');
      handle(req, res);
    })().catch((err: unknown) => {
      log({ level: 'error', msg: 'fleet request failed', error: String(err) });
      if (!res.headersSent) page(res, 500, 'Something went wrong', 'Please try again in a moment.');
      else res.destroy();
    });
  });

  return {
    server,
    admin,
    registry,
    apps,
    pool,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await listener.stop();
      await apps.closeAll();
      await admin.close();
      if (!deps.pdf) await pdf.close();
      await pool.end();
    },
  };
}
