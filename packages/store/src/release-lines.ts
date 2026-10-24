import type { ReleaseLines } from '@opend/model';
import { CHANNELS, notify, type PoolClient } from './db.js';
import { getRepo, type Repo } from './repos.js';

/** Maps a release version (`0.23.1`) to its line at the new granularity, or null. */
export type LineOf = (release: string) => string | null;

/**
 * Switches a repo between lines by major and by minor version, inside the
 * caller's transaction, and keeps what is live consistent with it:
 *
 * - every stored release of the repo is re-labelled with its new line;
 * - each live release moves to its new line. When several land on one line
 *   (minor to major: 0.21 and 0.23 both become 0), the one from the newest
 *   build stays live, the rule a build swap follows. Nothing that is not live
 *   now goes live: lines merged away, or retired ones, come back with their
 *   next build.
 *
 * Replicas drop their caches, as on a release swap. The repo row is locked first, as `publishRelease` locks it, so a build that
 * finishes meanwhile publishes to a line of the new granularity.
 * Returns null when the repo does not exist.
 */
export async function setRepoReleaseLines(
  client: PoolClient,
  repoId: number,
  lines: ReleaseLines,
  lineOf: LineOf,
): Promise<{ repo: Repo; changed: boolean } | null> {
  const { rows: locked } = await client.query<{ releaseLines: ReleaseLines }>(
    'select release_lines as "releaseLines" from repos where id = $1 for update',
    [repoId],
  );
  if (!locked[0]) return null;
  if (locked[0].releaseLines === lines)
    return { repo: (await getRepo(client, repoId))!, changed: false };
  await client.query('update repos set release_lines = $2 where id = $1', [repoId, lines]);

  const { rows: releases } = await client.query<{ id: number; release: string }>(
    'select id, release from releases where repo_id = $1',
    [repoId],
  );
  for (const r of releases) {
    const line = lineOf(r.release);
    if (line)
      await client.query('update releases set release_line = $2 where id = $1', [r.id, line]);
  }

  const { rows: live } = await client.query<{ releaseId: number; jobId: number; release: string }>(
    `select l.release_id as "releaseId", r.job_id as "jobId", r.release
     from live_releases l join releases r on r.id = l.release_id where l.repo_id = $1`,
    [repoId],
  );
  const keep = new Map<string, { releaseId: number; jobId: number }>();
  for (const l of live) {
    const line = lineOf(l.release);
    if (!line) continue;
    const current = keep.get(line);
    if (!current || Number(l.jobId) > Number(current.jobId)) keep.set(line, l);
  }
  await client.query('delete from live_releases where repo_id = $1', [repoId]);
  for (const [line, l] of keep)
    await client.query(
      'insert into live_releases (repo_id, release_line, release_id) values ($1, $2, $3)',
      [repoId, line, l.releaseId],
    );
  await notify(client, CHANNELS.releaseChanged, String(repoId));
  return { repo: (await getRepo(client, repoId))!, changed: true };
}
