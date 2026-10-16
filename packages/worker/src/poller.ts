import {
  forgetPolledRefs,
  listRepos,
  recordPolledRef,
  refMatches,
  type BuildJob,
  type Pool,
} from '@opend/store';
import type { GitHubApp } from './github.js';
import { listRemoteRefs, type RemoteRef } from './source.js';
import { jsonLog, type Log } from './worker.js';

export interface PollerDeps {
  pool: Pool;
  /** Mints installation tokens for private repos; omit for public or local sources. */
  github?: GitHubApp | null;
  log?: Log;
  /** Override for tests. */
  listRefs?: typeof listRemoteRefs;
}

export interface PollSummary {
  repos: number;
  queued: BuildJob[];
  errors: { repo: string; error: string }[];
}

/**
 * Release refs in the order their builds should be queued. Tags go first and
 * branches last, so on a first poll a moving branch such as `main` gets the
 * newest job and wins its release line over an older tag. A branch and a tag
 * with the same name count once, as the branch.
 */
export function releaseRefsToPoll(refs: RemoteRef[], patterns: readonly string[]): RemoteRef[] {
  const byName = new Map<string, RemoteRef>();
  for (const r of refs) {
    if (!refMatches(patterns, r.ref)) continue;
    if (!byName.has(r.ref) || r.kind === 'branch') byName.set(r.ref, r);
  }
  const order = (r: RemoteRef) => (r.kind === 'tag' ? 0 : 1);
  return [...byName.values()].sort(
    (a, b) => order(a) - order(b) || a.ref.localeCompare(b.ref, 'en', { numeric: true }),
  );
}

/**
 * Checks every registered repo's release refs and queues a build for each head
 * sha that has no job yet. For installs that GitHub's webhooks cannot reach.
 */
export async function pollOnce(deps: PollerDeps): Promise<PollSummary> {
  const log = deps.log ?? jsonLog;
  const listRefs = deps.listRefs ?? listRemoteRefs;
  const repos = await listRepos(deps.pool);
  const summary: PollSummary = { repos: repos.length, queued: [], errors: [] };
  for (const repo of repos) {
    try {
      const token =
        repo.installationId !== null && deps.github
          ? await deps.github.installationToken(repo.installationId)
          : undefined;
      const refs = releaseRefsToPoll(
        await listRefs(repo.sourceUrl, token, deps.github?.gitHosts),
        repo.releaseRefs,
      );
      for (const { ref, sha } of refs) {
        const job = await recordPolledRef(deps.pool, { repoId: repo.id, ref, sha });
        if (!job) continue;
        summary.queued.push(job);
        log({
          level: 'info',
          msg: 'build queued',
          source: 'poll',
          job: job.id,
          repo: repo.fullName,
          ref,
          sha,
        });
      }
      await forgetPolledRefs(
        deps.pool,
        repo.id,
        refs.map((r) => r.ref),
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      summary.errors.push({ repo: repo.fullName, error });
      log({ level: 'warn', msg: 'poll failed', repo: repo.fullName, error });
    }
  }
  return summary;
}

export interface PollerHandle {
  stop(): Promise<void>;
}

/** Polls now and then every `intervalMs`, never overlapping two polls. */
export function startPoller(deps: PollerDeps & { intervalMs: number }): PollerHandle {
  const log = deps.log ?? jsonLog;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = () => {
    running = pollOnce(deps)
      .then(
        () => {},
        (err: unknown) => log({ level: 'error', msg: 'poller error', error: String(err) }),
      )
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, deps.intervalMs);
      });
  };
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
