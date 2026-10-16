import type { CompiledRelease, Diagnostic } from '@opend/model';
import { CHANNELS, notify, withTransaction, type Db, type Pool } from './db.js';
import { writeSearchIndex, type SearchIndexInput } from './search.js';

export interface PublishInput {
  jobId: number;
  repoId: number;
  ref: string;
  sha: string;
  releaseLine: string;
  snapshot: CompiledRelease;
  diagnostics: Diagnostic[];
  /** Written in the same transaction, so a live release never lacks the index it was built with. */
  searchIndex?: SearchIndexInput;
}

export interface PublishResult {
  releaseId: number;
  /** False when a build of a newer push already went live for this line. */
  live: boolean;
}

/**
 * Stores a passing build and makes it live for its release line, in one
 * transaction. A build only replaces the live release if it comes from a newer
 * job, so a slow build of an old push can never overwrite a newer one.
 */
export async function publishRelease(pool: Pool, input: PublishInput): Promise<PublishResult> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `insert into releases (repo_id, job_id, ref, sha, release, release_line, snapshot, diagnostics)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        input.repoId,
        input.jobId,
        input.ref,
        input.sha,
        input.snapshot.release,
        input.releaseLine,
        JSON.stringify(input.snapshot),
        JSON.stringify(input.diagnostics),
      ],
    );
    const releaseId = rows[0]!.id;
    if (input.searchIndex) await writeSearchIndex(client, releaseId, input.searchIndex);
    const swap = await client.query(
      `insert into live_releases (repo_id, release_line, release_id) values ($1, $2, $3)
       on conflict (repo_id, release_line) do update
         set release_id = excluded.release_id, updated_at = now()
         where (select job_id from releases where id = live_releases.release_id) < $4`,
      [input.repoId, input.releaseLine, releaseId, input.jobId],
    );
    await client.query(
      `update build_jobs set status = 'succeeded', release_id = $2, error = null, diagnostics = $3,
         locked_at = null, finished_at = now() where id = $1`,
      [input.jobId, releaseId, JSON.stringify(input.diagnostics)],
    );
    const live = swap.rowCount === 1;
    if (live) await notify(client, CHANNELS.releaseChanged, String(input.repoId));
    return { releaseId, live };
  });
}

export interface LiveRelease {
  releaseId: number;
  releaseLine: string;
  release: string;
  sha: string;
}

export async function listLiveReleases(db: Db, repoId: number): Promise<LiveRelease[]> {
  const { rows } = await db.query<LiveRelease>(
    `select l.release_id as "releaseId", l.release_line as "releaseLine", r.release, r.sha
     from live_releases l join releases r on r.id = l.release_id
     where l.repo_id = $1 order by l.release_line`,
    [repoId],
  );
  return rows;
}

export async function getLiveReleaseId(
  db: Db,
  repoId: number,
  releaseLine: string,
): Promise<number | null> {
  const { rows } = await db.query<{ releaseId: number }>(
    'select release_id as "releaseId" from live_releases where repo_id = $1 and release_line = $2',
    [repoId, releaseLine],
  );
  return rows[0]?.releaseId ?? null;
}

export async function getReleaseSnapshot(
  db: Db,
  releaseId: number,
): Promise<CompiledRelease | null> {
  const { rows } = await db.query<{ snapshot: CompiledRelease }>(
    'select snapshot from releases where id = $1',
    [releaseId],
  );
  return rows[0]?.snapshot ?? null;
}

export interface StoredRelease {
  id: number;
  repoId: number;
  sha: string;
  snapshot: CompiledRelease;
}

export async function getRelease(db: Db, releaseId: number): Promise<StoredRelease | null> {
  const { rows } = await db.query<StoredRelease>(
    'select id, repo_id as "repoId", sha, snapshot from releases where id = $1',
    [releaseId],
  );
  return rows[0] ?? null;
}

/** Ids of every stored release, oldest first. */
export async function listReleaseIds(db: Db): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>('select id from releases order by id');
  return rows.map((r) => r.id);
}
