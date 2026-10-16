import { createPool, type Pool, type SyncMode, type SyncResult } from '@opend/store';
import { jsonLog, type Log } from '@opend/worker';
import type { ServerConfig } from './config.js';
import { reconcile, redactUrl, type ReconcileOptions } from './entitlement-sync.js';

export interface ReconcileCommandOptions {
  from?: string;
  mode?: string;
  dryRun?: boolean;
  allowEmpty?: boolean;
}

/**
 * Resolves `opend-server reconcile` options against the environment. The
 * bearer token is only sent to the configured export's origin, so `--from`
 * pointed elsewhere cannot leak it.
 */
export function reconcileOptions(
  config: ServerConfig,
  options: ReconcileCommandOptions,
): ReconcileOptions {
  const source = config.selfHosting?.entitlementSource;
  const url = options.from ?? source?.url;
  if (!url) throw new Error('no export URL: pass --from <url> or set ENTITLEMENT_SOURCE_URL');
  const parsed = URL.parse(url);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    throw new Error(`--from must be an http(s) URL: ${url}`);
  }
  const mode = options.mode ?? config.selfHosting?.entitlementSyncMode ?? 'merge';
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error(`--mode must be merge or replace, not ${mode}`);
  }
  const resolved: ReconcileOptions = { url, mode: mode as SyncMode };
  if (source?.token && new URL(source.url).origin === parsed.origin) resolved.token = source.token;
  if (options.dryRun) resolved.dryRun = true;
  if (options.allowEmpty) resolved.allowEmpty = true;
  return resolved;
}

export async function runReconcileCommand(
  config: ServerConfig,
  options: ReconcileCommandOptions,
  deps: { pool?: Pool; log?: Log; fetchImpl?: typeof fetch } = {},
): Promise<SyncResult> {
  const log = deps.log ?? jsonLog;
  const resolved = reconcileOptions(config, options);
  if (deps.fetchImpl) resolved.fetchImpl = deps.fetchImpl;
  const pool = deps.pool ?? createPool(config.databaseUrl);
  try {
    const result = await reconcile(pool, resolved);
    log({
      level: 'info',
      msg: result.dryRun ? 'reconcile dry run' : 'reconcile applied',
      source: redactUrl(resolved.url),
      mode: result.mode,
      ...result.summary,
      ...(result.dryRun ? { changes: result.changes } : {}),
    });
    return result;
  } finally {
    if (!deps.pool) await pool.end();
  }
}
