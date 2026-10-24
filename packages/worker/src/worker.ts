import { join, normalize, sep } from 'node:path';
import { formatDiagnostic, hasErrors, type Diagnostic } from '@opend/model';
import { releaseLine } from '@opend/filter';
import { buildRelease, readDirectory, readSourceFile } from '@opend/build';
import { validate } from '@opend/validate';
import {
  CHANNELS,
  assetKey,
  claimJob,
  failJob,
  getRepo,
  listen,
  publishRelease,
  type BlobStore,
  type BuildJob,
  type Pool,
  type Repo,
} from '@opend/store';
import { searchIndexInput } from './search.js';
import { fetchSource } from './source.js';
import { nullReporter, type GitHubAccess, type StatusReporter } from './github.js';

export type Log = (entry: Record<string, unknown>) => void;

export const jsonLog: Log = (entry) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);

export interface WorkerDeps {
  pool: Pool;
  blobs: BlobStore;
  /**
   * Installation tokens for private repos (a GitHub App, the token broker, or
   * a `GitHubConnection` choosing between them); omit for public or local sources.
   */
  github?: GitHubAccess | null;
  reporter?: StatusReporter;
  log?: Log;
}

export type JobOutcome = 'published' | 'superseded' | 'failed' | 'retrying';

class RetryableError extends Error {}

/** Summary for a commit status: the first few errors, compactly. */
export function summarize(diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const first = errors
    .slice(0, 2)
    .map((d) => `${d.file ?? ''}${d.line ? `:${d.line}` : ''} ${d.code}`)
    .join('; ');
  return `${errors.length} error${errors.length === 1 ? '' : 's'}: ${first}`;
}

function docsRoot(checkout: string, docsPath: string): string {
  const root = normalize(join(checkout, docsPath));
  if (root !== checkout && !root.startsWith(checkout + sep)) {
    throw new Error(`docs_path escapes the repository: ${docsPath}`);
  }
  return root;
}

/**
 * Runs one claimed job: fetch the commit, build, validate, upload assets, and
 * publish. Content errors fail the job and leave the live release untouched;
 * infrastructure errors are retried.
 */
export async function runJob(deps: WorkerDeps, job: BuildJob): Promise<JobOutcome> {
  const log = deps.log ?? jsonLog;
  const reporter = deps.reporter ?? deps.github ?? nullReporter;
  const repo = await getRepo(deps.pool, job.repoId);
  if (!repo) {
    await failJob(deps.pool, job, { error: 'repository no longer registered', retryable: false });
    return 'failed';
  }
  const report = (state: Parameters<StatusReporter['report']>[2], description: string) =>
    reporter
      .report(repo, job.sha, state, description)
      .catch((err: unknown) =>
        log({ level: 'warn', msg: 'commit status failed', job: job.id, error: String(err) }),
      );

  await report('pending', 'Building docs');
  try {
    const outcome = await buildAndPublish(deps, repo, job);
    if (outcome.kind === 'invalid') {
      await failJob(deps.pool, job, {
        error: outcome.message,
        diagnostics: outcome.diagnostics,
        retryable: false,
      });
      await report('failure', outcome.message);
      log({
        level: 'info',
        msg: 'build failed',
        job: job.id,
        repo: repo.fullName,
        ref: job.ref,
        sha: job.sha,
        error: outcome.message,
      });
      return 'failed';
    }
    const description = outcome.live
      ? `Published ${outcome.release}`
      : `Built ${outcome.release}; a newer push is already live`;
    await report('success', description);
    log({
      level: 'info',
      msg: 'build published',
      job: job.id,
      repo: repo.fullName,
      ref: job.ref,
      sha: job.sha,
      release: outcome.release,
      live: outcome.live,
    });
    return outcome.live ? 'published' : 'superseded';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof RetryableError;
    const status = await failJob(deps.pool, job, { error: message, retryable });
    if (status === 'failed') await report('error', `Build could not run: ${message}`);
    log({
      level: 'error',
      msg: 'build error',
      job: job.id,
      repo: repo.fullName,
      error: message,
      willRetry: status === 'queued',
    });
    return status === 'queued' ? 'retrying' : 'failed';
  }
}

type BuildOutcome =
  | { kind: 'invalid'; message: string; diagnostics: Diagnostic[] }
  | { kind: 'published'; release: string; live: boolean };

async function buildAndPublish(deps: WorkerDeps, repo: Repo, job: BuildJob): Promise<BuildOutcome> {
  let token: string | undefined;
  try {
    token = await deps.github?.repoToken(repo, 'read');
  } catch (err) {
    throw new RetryableError(`GitHub token: ${err instanceof Error ? err.message : String(err)}`);
  }
  let source;
  try {
    source = await fetchSource(repo.sourceUrl, job.sha, token, deps.github?.gitHosts);
  } catch (err) {
    throw new RetryableError(err instanceof Error ? err.message : String(err));
  }
  try {
    const root = docsRoot(source.dir, repo.docsPath);
    const result = buildRelease(await readDirectory(root));
    const diagnostics = validate(result);
    const release = result.release;
    if (!release || hasErrors(diagnostics)) {
      return { kind: 'invalid', message: summarize(diagnostics), diagnostics };
    }
    // Both granularities accept the same versions; the line itself is computed
    // when publishing, with the repo's granularity read under a lock.
    if (!releaseLine(release.release, repo.releaseLines)) {
      const d: Diagnostic = {
        severity: 'error',
        code: 'invalid-config',
        message: `release "${release.release}" must be a version such as 2.1`,
        file: 'opend.config.yaml',
      };
      return { kind: 'invalid', message: formatDiagnostic(d), diagnostics: [d, ...diagnostics] };
    }
    try {
      const files = [
        ...release.assets,
        ...(release.theme ? [release.theme] : []),
        ...(release.logo ? [release.logo] : []),
      ];
      for (const path of files) {
        await deps.blobs.put(assetKey(repo.id, job.sha, path), await readSourceFile(root, path));
      }
    } catch (err) {
      throw new RetryableError(
        `storing assets: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const published = await publishRelease(deps.pool, {
      jobId: job.id,
      repoId: repo.id,
      ref: job.ref,
      sha: job.sha,
      releaseLine: (lines) => releaseLine(release.release, lines),
      snapshot: release,
      diagnostics,
      searchIndex: searchIndexInput(release),
    });
    return { kind: 'published', release: release.release, live: published.live };
  } finally {
    await source.cleanup();
  }
}

/** Claims and runs the next job. Returns false when the queue was empty. */
export async function processNext(deps: WorkerDeps): Promise<JobOutcome | null> {
  const job = await claimJob(deps.pool);
  return job ? runJob(deps, job) : null;
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

/**
 * Runs jobs until stopped. Wakes on new-job notifications and also polls, so a
 * missed notification or a retry whose backoff elapsed is still picked up.
 */
export function startWorker(
  deps: WorkerDeps & { databaseUrl: string; pollMs?: number },
): WorkerHandle {
  const log = deps.log ?? jsonLog;
  let stopped = false;
  let wake: () => void = () => {};
  const listener = listen(
    deps.databaseUrl,
    [CHANNELS.jobQueued],
    () => wake(),
    (err) => log({ level: 'warn', msg: 'listen error', error: String(err) }),
  );

  const loop = async () => {
    while (!stopped) {
      try {
        if ((await processNext(deps)) !== null) continue;
      } catch (err) {
        log({ level: 'error', msg: 'worker loop error', error: String(err) });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deps.pollMs ?? 5000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };
  const running = loop();

  return {
    stop: async () => {
      stopped = true;
      wake();
      await running;
      await listener.stop();
    },
  };
}
