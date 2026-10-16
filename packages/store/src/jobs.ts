import type { Diagnostic } from '@opend/model';
import { CHANNELS, notify, type Db } from './db.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface BuildJob {
  id: number;
  repoId: number;
  ref: string;
  sha: string;
  status: JobStatus;
  attempts: number;
  error: string | null;
  diagnostics: Diagnostic[];
  releaseId: number | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** Jobs that fail for infrastructure reasons (fetch errors) are retried this many times. */
export const MAX_ATTEMPTS = 5;
/** A running job whose worker has been silent this long is assumed dead and reclaimed. */
const STALE_LOCK = '15 minutes';

const COLUMNS = `id, repo_id as "repoId", ref, sha, status, attempts, error, diagnostics,
  release_id as "releaseId", created_at as "createdAt", finished_at as "finishedAt"`;

export async function enqueueJob(
  db: Db,
  job: { repoId: number; ref: string; sha: string },
): Promise<BuildJob> {
  const { rows } = await db.query<BuildJob>(
    `insert into build_jobs (repo_id, ref, sha) values ($1, $2, $3) returning ${COLUMNS}`,
    [job.repoId, job.ref, job.sha],
  );
  await notify(db, CHANNELS.jobQueued, String(rows[0]!.id));
  return rows[0]!;
}

/** Claims the oldest runnable job, or a job whose worker died. Safe with many workers. */
export async function claimJob(db: Db): Promise<BuildJob | null> {
  const { rows } = await db.query<BuildJob>(
    `update build_jobs set status = 'running', locked_at = now(), attempts = attempts + 1
     where id = (
       select id from build_jobs
       where (status = 'queued' and run_after <= now())
          or (status = 'running' and locked_at < now() - interval '${STALE_LOCK}')
       order by id
       for update skip locked
       limit 1
     )
     returning ${COLUMNS}`,
  );
  return rows[0] ?? null;
}

/**
 * Records a failed attempt. Retryable failures go back on the queue with
 * exponential backoff until `MAX_ATTEMPTS`; content failures are final.
 */
export async function failJob(
  db: Db,
  job: Pick<BuildJob, 'id' | 'attempts'>,
  failure: { error: string; diagnostics?: Diagnostic[]; retryable: boolean },
): Promise<JobStatus> {
  const retry = failure.retryable && job.attempts < MAX_ATTEMPTS;
  const status: JobStatus = retry ? 'queued' : 'failed';
  await db.query(
    `update build_jobs set status = $2, error = $3, diagnostics = $4, locked_at = null,
       run_after = now() + make_interval(secs => $5),
       finished_at = case when $2 = 'failed' then now() else null end
     where id = $1`,
    [
      job.id,
      status,
      failure.error,
      JSON.stringify(failure.diagnostics ?? []),
      retry ? 2 ** job.attempts * 5 : 0,
    ],
  );
  return status;
}

export async function listJobs(
  db: Db,
  options: { repoId?: number; limit?: number } = {},
): Promise<BuildJob[]> {
  const { rows } = await db.query<BuildJob>(
    `select ${COLUMNS} from build_jobs where ($1::bigint is null or repo_id = $1)
     order by id desc limit $2`,
    [options.repoId ?? null, options.limit ?? 50],
  );
  return rows;
}

export async function getJob(db: Db, id: number): Promise<BuildJob | null> {
  const { rows } = await db.query<BuildJob>(`select ${COLUMNS} from build_jobs where id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

/** Records a webhook delivery id. Returns false if it was already seen. */
export async function recordDelivery(db: Db, id: string, event: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'insert into webhook_deliveries (id, event) values ($1, $2) on conflict do nothing',
    [id, event],
  );
  return rowCount === 1;
}
