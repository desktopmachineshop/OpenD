import { createPool, type Pool } from '@opend/store';
import { jsonLog, reindexAll, reindexRelease, type Log, type ReindexResult } from '@opend/worker';
import type { ServerConfig } from './config.js';

export interface ReindexCommandOptions {
  release?: string;
}

/**
 * `opend-server reindex [--release <id>]`: rebuilds the search index of one
 * stored release, or of every release. Releases published before search
 * indexing (or with an older index format) are searched in memory until then.
 */
export async function runReindexCommand(
  config: Pick<ServerConfig, 'databaseUrl'>,
  options: ReindexCommandOptions,
  deps: { pool?: Pool; log?: Log } = {},
): Promise<ReindexResult[]> {
  const log = deps.log ?? jsonLog;
  let releaseId: number | undefined;
  if (options.release !== undefined) {
    releaseId = Number(options.release);
    if (!Number.isSafeInteger(releaseId) || releaseId <= 0)
      throw new Error(`--release must be a release id, not ${options.release}`);
  }
  const pool = deps.pool ?? createPool(config.databaseUrl);
  try {
    let results: ReindexResult[];
    if (releaseId === undefined) results = await reindexAll(pool);
    else {
      const result = await reindexRelease(pool, releaseId);
      if (!result) throw new Error(`no release ${releaseId}`);
      results = [result];
    }
    for (const r of results) log({ level: 'info', msg: 'release reindexed', ...r });
    log({ level: 'info', msg: 'reindex finished', releases: results.length });
    return results;
  } finally {
    if (!deps.pool) await pool.end();
  }
}
