import { z } from 'zod';
import type { Site } from './registry.js';

/**
 * A fleet runs many sites from one deployment (managed hosting's shared plans).
 * Each site gets the environment a single-site deployment would have, with the
 * fleet's own database, storage and listening address substituted.
 */

/** Variables the fleet owns; a site's settings cannot set them. */
export const FLEET_OWNED = [
  'DATABASE_URL',
  'PORT',
  'HOST',
  'NODE_ENV',
  'BLOB_DIR',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
  'S3_PREFIX',
  'GITHUB_API_URL',
  'GITHUB_WEB_URL',
  'POLL_INTERVAL_SECONDS',
] as const;

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  OPEND_FLEET_KEY: z.string().min(32, 'OPEND_FLEET_KEY must be at least 32 characters'),
  OPEND_FLEET_TOKEN: z.string().min(32, 'OPEND_FLEET_TOKEN must be at least 32 characters'),
  /** The fleet's own host name, where its admin API answers (`/fleet/api`). */
  OPEND_FLEET_HOST: z.string().min(1),
  OPEND_FLEET_MAX_SITES: z.coerce.number().int().min(1).default(200),
  /**
   * Hosts answered with a permanent redirect instead of a site, such as
   * `www.opend.app=https://opend.app`: comma-separated `host=https origin` pairs.
   */
  OPEND_FLEET_REDIRECTS: z.string().default(''),
  OPEND_FLEET_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
});

export interface FleetConfig {
  databaseUrl: string;
  key: string;
  token: string;
  host: string;
  maxSites: number;
  /** Hosts answered with a permanent redirect to an origin, keeping path and query. */
  redirects: Map<string, string>;
  workerConcurrency: number;
  port: number;
  bindHost: string;
  /** The fleet's process environment, for the variables it owns. */
  env: NodeJS.ProcessEnv;
}

export function loadFleetConfig(env: NodeJS.ProcessEnv = process.env): FleetConfig {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `invalid fleet configuration: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    key: e.OPEND_FLEET_KEY,
    token: e.OPEND_FLEET_TOKEN,
    host: normaliseHost(e.OPEND_FLEET_HOST),
    maxSites: e.OPEND_FLEET_MAX_SITES,
    redirects: parseRedirects(e.OPEND_FLEET_REDIRECTS),
    workerConcurrency: e.OPEND_FLEET_WORKER_CONCURRENCY,
    port: e.PORT,
    bindHost: e.HOST,
    env,
  };
}

/** `host=https://origin` pairs, comma-separated; throws on anything else. */
function parseRedirects(value: string): Map<string, string> {
  const redirects = new Map<string, string>();
  for (const pair of value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [host, target] = pair.split('=').map((p) => p.trim());
    let origin: string | null;
    try {
      const url = target ? new URL(target) : null;
      origin =
        url?.protocol === 'https:' && url.origin === target!.replace(/\/+$/, '')
          ? url.origin
          : null;
    } catch {
      origin = null;
    }
    if (!host || !origin)
      throw new Error(
        `invalid fleet configuration: OPEND_FLEET_REDIRECTS: "${pair}" is not host=https://origin`,
      );
    redirects.set(normaliseHost(host), origin);
  }
  return redirects;
}

/** A database URL whose connections use the site's schema. */
export function siteDatabaseUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schemaName}`);
  return url.toString();
}

/** The environment a site's web, worker and editor apps are configured from. */
export function siteEnv(fleet: FleetConfig, site: Site): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(site.env))
    if (!(FLEET_OWNED as readonly string[]).includes(k)) env[k] = v;
  for (const k of FLEET_OWNED) if (fleet.env[k] !== undefined) env[k] = fleet.env[k];
  env.DATABASE_URL = siteDatabaseUrl(fleet.databaseUrl, site.schema);
  // Each site's blobs under a prefix (S3) or a directory (local disk) of their own.
  if (env.S3_BUCKET)
    env.S3_PREFIX = [fleet.env.S3_PREFIX?.replace(/\/+$/, ''), 'sites', site.schema]
      .filter(Boolean)
      .join('/');
  env.BLOB_DIR = `${(fleet.env.BLOB_DIR ?? './data/blobs').replace(/\/+$/, '')}/sites/${site.schema}`;
  // Webhooks would otherwise need one poller per site; hosted sites use the broker's webhooks.
  delete env.POLL_INTERVAL_SECONDS;
  return env;
}

export function normaliseHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[:/].*$/, '');
}
