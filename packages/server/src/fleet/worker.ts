import {
  CHANNELS,
  STALE_LOCK,
  SecretBox,
  SettingsCache,
  createBlobStore,
  createPool,
  deriveSecretKey,
  listen,
  purgeAnalytics,
  storedGitHubApp,
  type Listener,
} from '@opend/store';
import { GitHubConnection, jsonLog, processNext, type Log } from '@opend/worker';
import { DEFAULT_ANALYTICS, loadConfig } from '../config.js';
import { siteEnv, type FleetConfig } from './config.js';
import { Registry, migrateRegistry, type Site } from './registry.js';
import { FLEET_CHANGED } from './serve.js';

export interface FleetWorker {
  /** Runs every runnable job of every site once (tests). */
  drain(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build jobs for every active site. Jobs are queued in each site's own schema;
 * the worker wakes on any site's job notification and also sweeps all sites, so
 * a missed notification or an elapsed retry backoff is still picked up. At most
 * one job per site runs at a time, and `OPEND_FLEET_WORKER_CONCURRENCY` overall,
 * so one busy site cannot hold up the rest.
 */
export async function startFleetWorker(
  fleet: FleetConfig,
  deps: { log?: Log; sweepMs?: number; purgeMs?: number; fetch?: typeof fetch } = {},
): Promise<FleetWorker> {
  const log = deps.log ?? jsonLog;
  const pool = createPool(fleet.databaseUrl);
  await migrateRegistry(pool);
  const registry = new Registry(pool, new SecretBox(deriveSecretKey({ secretKey: fleet.key })!));

  let stopped = false;
  const pending = new Set<string>();
  const busy = new Set<string>();
  let sites = new Map<string, Site>();
  const subscriptions = new Map<string, Listener>();
  let wake: () => void = () => {};

  const refresh = async () => {
    const all = (await registry.list()).filter((s) => s.status === 'active');
    sites = new Map(all.map((s) => [s.slug, s]));
    for (const [slug, l] of subscriptions)
      if (!sites.has(slug)) {
        subscriptions.delete(slug);
        await l.stop();
      }
    for (const site of all)
      if (!subscriptions.has(site.slug))
        subscriptions.set(
          site.slug,
          listen(siteEnv(fleet, site).DATABASE_URL!, [CHANNELS.jobQueued], () => {
            pending.add(site.slug);
            wake();
          }),
        );
  };

  /** Sites with a runnable job, found with one query per hundred sites. */
  const sweep = async () => {
    const list = [...sites.values()];
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const sql = chunk
        .map(
          (s, n) =>
            `select $${n + 1}::text as slug where exists (select 1 from "${s.schema}".build_jobs
             where (status = 'queued' and run_after <= now())
                or (status = 'running' and locked_at < now() - interval '${STALE_LOCK}'))`,
        )
        .join(' union all ');
      const { rows } = await pool.query<{ slug: string }>(
        sql,
        chunk.map((s) => s.slug),
      );
      for (const r of rows) pending.add(r.slug);
    }
  };

  /** Runs one site's queue until it is empty. */
  const runSite = async (site: Site) => {
    const env = siteEnv(fleet, site);
    const config = loadConfig(env);
    const sitePool = createPool(config.databaseUrl, undefined, { max: 2 });
    const siteLog: Log = (entry) => log({ ...entry, site: site.slug });
    try {
      const key = deriveSecretKey({
        secretKey: config.secretKey,
        sessionSecret: config.sessionSecret,
      });
      const settings = new SettingsCache(sitePool, key ? new SecretBox(key) : null);
      await settings.reload().catch(() => {});
      const github = new GitHubConnection({
        app: config.github ?? null,
        broker: config.broker ?? null,
        stored: () => {
          const app = storedGitHubApp(settings.current);
          return app ? { appId: app.appId, privateKey: app.privateKey, apiUrl: app.apiUrl } : null;
        },
        ...(config.githubApiUrl ? { apiUrl: config.githubApiUrl } : {}),
        ...(config.githubWebUrl ? { webUrl: config.githubWebUrl } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        log: siteLog,
      });
      const blobs = createBlobStore(config.blobs);
      while (
        !stopped &&
        (await processNext({ pool: sitePool, blobs, github, log: siteLog })) !== null
      );
    } finally {
      await sitePool.end();
    }
  };

  const pump = async (): Promise<void> => {
    const runs: Promise<void>[] = [];
    for (const slug of [...pending]) {
      if (busy.size >= fleet.workerConcurrency) break;
      if (busy.has(slug)) continue;
      pending.delete(slug);
      const site = sites.get(slug);
      if (!site) continue;
      busy.add(slug);
      runs.push(
        runSite(site)
          .catch((err: unknown) =>
            log({ level: 'error', msg: 'site jobs failed', site: slug, error: String(err) }),
          )
          .finally(() => {
            busy.delete(slug);
            wake();
          }),
      );
    }
    await Promise.all(runs);
  };

  await refresh();
  const changes = listen(fleet.databaseUrl, [FLEET_CHANGED], () => void refresh().catch(() => {}));

  const loop = async () => {
    let lastSweep = 0;
    while (!stopped) {
      try {
        if (Date.now() - lastSweep >= (deps.sweepMs ?? 10_000)) {
          lastSweep = Date.now();
          await refresh();
          await sweep();
        }
        void pump();
      } catch (err) {
        log({ level: 'error', msg: 'fleet worker loop error', error: String(err) });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };
  const running = loop();

  // Analytics retention per site, a few times a day.
  const purge = setInterval(
    () =>
      void (async () => {
        for (const site of sites.values()) {
          const config = loadConfig(siteEnv(fleet, site));
          const sitePool = createPool(config.databaseUrl, undefined, { max: 1 });
          await purgeAnalytics(sitePool, (config.analytics ?? DEFAULT_ANALYTICS).retentionDays)
            .catch((err: unknown) =>
              log({
                level: 'warn',
                msg: 'analytics purge failed',
                site: site.slug,
                error: String(err),
              }),
            )
            .finally(() => sitePool.end());
        }
      })(),
    deps.purgeMs ?? 6 * 3600_000,
  );
  purge.unref();

  return {
    drain: async () => {
      await refresh();
      await sweep();
      while (pending.size || busy.size) {
        await pump();
        if (busy.size) await new Promise((r) => setTimeout(r, 20));
      }
    },
    stop: async () => {
      stopped = true;
      clearInterval(purge);
      wake();
      await running;
      while (busy.size) await new Promise((r) => setTimeout(r, 50));
      await changes.stop();
      for (const l of subscriptions.values()) await l.stop();
      await pool.end();
    },
  };
}
