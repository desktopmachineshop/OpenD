import type { IncomingMessage, ServerResponse } from 'node:http';
import { createEditorApp, loadEditorConfig } from '@opend/editor';
import type { PdfRenderer } from '@opend/pdf';
import { createBlobStore, createPool, type Pool } from '@opend/store';
import { jsonLog, type Log } from '@opend/worker';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { siteEnv, type FleetConfig } from './config.js';
import type { Site } from './registry.js';

export type AppKind = 'web' | 'editor';

interface Running {
  key: string;
  version: number;
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  close: () => Promise<void>;
  lastUsed: number;
}

/**
 * The web and editor apps of the sites that had requests recently, built on
 * first use with the site's own configuration and closed when least recently
 * used beyond `maxSites` or after a settings change. Each app is exactly what a
 * single-site deployment runs: its own cookie secret, caches and admin token.
 */
export class SiteApps {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<Running>>();

  constructor(
    private readonly fleet: FleetConfig,
    private readonly shared: { pdf: PdfRenderer; log?: Log },
  ) {}

  async handler(site: Site, kind: AppKind): Promise<Running['handle']> {
    const key = `${kind}:${site.slug}`;
    const version = site.updatedAt.getTime();
    const current = this.running.get(key);
    if (current && current.version === version) {
      current.lastUsed = Date.now();
      return current.handle;
    }
    let pending = this.starting.get(key);
    if (!pending) {
      pending = (async () => {
        if (current) await this.close(key);
        const started = await this.start(site, kind, key, version);
        this.running.set(key, started);
        await this.evict();
        return started;
      })().finally(() => this.starting.delete(key));
      this.starting.set(key, pending);
    }
    return (await pending).handle;
  }

  /** Closes a site's apps, after a settings change, a suspension or a deletion. */
  async closeSite(slug: string): Promise<void> {
    await Promise.all([this.close(`web:${slug}`), this.close(`editor:${slug}`)]);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((k) => this.close(k)));
  }

  get size(): number {
    return this.running.size;
  }

  private async close(key: string): Promise<void> {
    const r = this.running.get(key);
    if (!r) return;
    this.running.delete(key);
    await r.close().catch((err: unknown) =>
      (this.shared.log ?? jsonLog)({
        level: 'warn',
        msg: 'site app close failed',
        key,
        error: String(err),
      }),
    );
  }

  private async evict(): Promise<void> {
    while (this.running.size > this.fleet.maxSites) {
      const oldest = [...this.running.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]!;
      await this.close(oldest.key);
    }
  }

  private async start(site: Site, kind: AppKind, key: string, version: number): Promise<Running> {
    const env = siteEnv(this.fleet, site);
    const log: Log = (entry) => (this.shared.log ?? jsonLog)({ ...entry, site: site.slug });
    // Small pools: most sites are idle most of the time, and idle connections close.
    const pool: Pool = createPool(
      env.DATABASE_URL!,
      (err) => log({ level: 'warn', msg: 'postgres idle client error', error: String(err) }),
      { max: 3, idleTimeoutMillis: 10_000 },
    );
    try {
      if (kind === 'web') {
        const config = loadConfig(env);
        const { app } = await createApp(config, {
          pool,
          blobs: createBlobStore(config.blobs),
          pdf: this.shared.pdf,
          log,
        });
        await app.ready();
        return {
          key,
          version,
          lastUsed: Date.now(),
          handle: (req, res) => app.routing(req, res),
          close: async () => {
            await app.close();
            await pool.end();
          },
        };
      }
      const { app } = await createEditorApp(loadEditorConfig(env), { pool, log });
      await app.ready();
      return {
        key,
        version,
        lastUsed: Date.now(),
        handle: (req, res) => app.routing(req, res),
        close: async () => {
          await app.close();
          await pool.end();
        },
      };
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
  }
}
