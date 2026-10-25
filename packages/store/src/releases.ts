import type { CompiledRelease, Diagnostic, ReleaseLines } from '@opend/model';
import { CHANNELS, notify, withTransaction, type Db, type Pool, type PoolClient } from './db.js';
import { writeSearchIndex, type SearchIndexInput } from './search.js';

export interface PublishInput {
  jobId: number;
  repoId: number;
  ref: string;
  sha: string;
  /**
   * The line to publish to, or how to compute it from the repo's release-line
   * granularity, which is read under a lock in the publishing transaction (so
   * a granularity change and a build finishing at the same time agree).
   */
  releaseLine: string | ((lines: ReleaseLines) => string | null);
  snapshot: CompiledRelease;
  diagnostics: Diagnostic[];
  /** Written in the same transaction, so a live release never lacks the index it was built with. */
  searchIndex?: SearchIndexInput;
  /**
   * Runs in the publishing transaction once the build went live, with the repo
   * row locked for update, so whatever it changes (the site settings its
   * config declares) takes effect together with the release: no reader is
   * ever served the new release under the old settings.
   */
  onLive?: (client: PoolClient, releaseId: number) => Promise<void>;
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
    // Locks the repo row against a release-line change (setRepoReleaseLines) until commit;
    // exclusively when `onLive` may change the repo, so concurrent publishes take turns.
    const { rows: repo } = await client.query<{ releaseLines: ReleaseLines }>(
      `select release_lines as "releaseLines" from repos where id = $1 for ${input.onLive ? 'update' : 'share'}`,
      [input.repoId],
    );
    const line =
      typeof input.releaseLine === 'string'
        ? input.releaseLine
        : input.releaseLine(repo[0]?.releaseLines ?? 'major');
    if (!line) throw new Error(`release "${input.snapshot.release}" has no release line`);
    const { rows } = await client.query<{ id: number }>(
      `insert into releases (repo_id, job_id, ref, sha, release, release_line, snapshot, diagnostics)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        input.repoId,
        input.jobId,
        input.ref,
        input.sha,
        input.snapshot.release,
        line,
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
      [input.repoId, line, releaseId, input.jobId],
    );
    await client.query(
      `update build_jobs set status = 'succeeded', release_id = $2, error = null, diagnostics = $3,
         locked_at = null, finished_at = now() where id = $1`,
      [input.jobId, releaseId, JSON.stringify(input.diagnostics)],
    );
    const live = swap.rowCount === 1;
    if (live) await notify(client, CHANNELS.releaseChanged, String(input.repoId));
    if (live && input.onLive) await input.onLive(client, releaseId);
    return { releaseId, live };
  });
}

export interface LiveRelease {
  releaseId: number;
  releaseLine: string;
  release: string;
  sha: string;
}

/** Lines as versions, oldest first (`0.3` before `0.23`); see compareReleaseLines in @opend/filter. */
function compareLines(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Number.isNaN(d) ? (a < b ? -1 : 1) : d;
  }
  return 0;
}

/** The live release of each line of a repo, oldest line first. */
export async function listLiveReleases(db: Db, repoId: number): Promise<LiveRelease[]> {
  const { rows } = await db.query<LiveRelease>(
    `select l.release_id as "releaseId", l.release_line as "releaseLine", r.release, r.sha
     from live_releases l join releases r on r.id = l.release_id
     where l.repo_id = $1`,
    [repoId],
  );
  return rows.sort((a, b) => compareLines(a.releaseLine, b.releaseLine));
}

/**
 * Takes a release line off the site: readers of that line get "nothing
 * published" and the staff view falls back to the next newest line. The
 * release itself stays stored; the next build for the line puts it back.
 */
export async function retireReleaseLine(
  db: Db,
  repoId: number,
  releaseLine: string,
): Promise<boolean> {
  const res = await db.query('delete from live_releases where repo_id = $1 and release_line = $2', [
    repoId,
    releaseLine,
  ]);
  if (res.rowCount !== 1) return false;
  await notify(db, CHANNELS.releaseChanged, String(repoId));
  return true;
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
