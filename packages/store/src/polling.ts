import { withTransaction, type Pool } from './db.js';
import { enqueueJob, type BuildJob } from './jobs.js';

/**
 * Records the head sha the poller saw for a release ref, and queues a build if
 * the sha changed and no job exists for it yet (a webhook may have queued one).
 *
 * Safe with several workers polling at once: the upsert locks the
 * `(repo, ref)` row, so a second poller waits, then sees the sha unchanged and
 * queues nothing.
 */
export async function recordPolledRef(
  pool: Pool,
  seen: { repoId: number; ref: string; sha: string },
): Promise<BuildJob | null> {
  return withTransaction(pool, async (db) => {
    const changed = await db.query(
      `insert into polled_refs (repo_id, ref, sha) values ($1, $2, $3)
       on conflict (repo_id, ref) do update set sha = excluded.sha, job_id = null, seen_at = now()
         where polled_refs.sha <> excluded.sha
       returning repo_id`,
      [seen.repoId, seen.ref, seen.sha],
    );
    if (changed.rowCount !== 1) return null;
    const existing = await db.query(
      'select 1 from build_jobs where repo_id = $1 and ref = $2 and sha = $3 limit 1',
      [seen.repoId, seen.ref, seen.sha],
    );
    if (existing.rowCount) return null;
    const job = await enqueueJob(db, seen);
    await db.query('update polled_refs set job_id = $3 where repo_id = $1 and ref = $2', [
      seen.repoId,
      seen.ref,
      job.id,
    ]);
    return job;
  });
}

/** Forgets refs that no longer exist on the remote, so recreating one builds it again. */
export async function forgetPolledRefs(
  pool: Pool,
  repoId: number,
  keep: readonly string[],
): Promise<number> {
  const { rowCount } = await pool.query(
    'delete from polled_refs where repo_id = $1 and not (ref = any($2))',
    [repoId, keep],
  );
  return rowCount ?? 0;
}

export async function listPolledRefs(
  pool: Pool,
  repoId: number,
): Promise<{ ref: string; sha: string; jobId: number | null }[]> {
  const { rows } = await pool.query(
    'select ref, sha, job_id as "jobId" from polled_refs where repo_id = $1 order by ref',
    [repoId],
  );
  return rows;
}
