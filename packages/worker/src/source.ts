import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface FetchedSource {
  dir: string;
  cleanup(): Promise<void>;
}

/**
 * Fetches one commit into a fresh temporary directory: a shallow fetch of the
 * exact sha, so a newer push cannot change what this job builds. For GitHub
 * the installation token is sent as an HTTP header, never in the URL, so it
 * cannot appear in error messages.
 */
export async function fetchSource(
  sourceUrl: string,
  sha: string,
  token?: string,
): Promise<FetchedSource> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(`not a commit sha: ${sha}`);
  const dir = await mkdtemp(join(tmpdir(), 'opend-build-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const auth = token
    ? [
        '-c',
        `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      ]
    : [];
  const git = (...args: string[]) =>
    run('git', [...auth, ...args], {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    await git('init', '-q');
    await git('fetch', '-q', '--depth', '1', '--no-tags', sourceUrl, sha);
    await git('checkout', '-q', '--detach', 'FETCH_HEAD');
    return { dir, cleanup };
  } catch (err) {
    await cleanup();
    const stderr = (err as { stderr?: string }).stderr?.trim();
    const lines = stderr?.split('\n') ?? [];
    // git's first "fatal:" line names the cause; later lines are hints.
    const reason = lines.find((l) => l.startsWith('fatal:')) ?? lines.at(-1);
    // The original error is not attached as `cause`: its `cmd` includes the
    // auth header, and errors end up in logs and the build_jobs table.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`fetching ${sha} failed${reason ? `: ${reason}` : ''}`);
  }
}
