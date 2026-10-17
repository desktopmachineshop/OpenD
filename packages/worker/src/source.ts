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
  tokenHosts?: readonly string[],
): Promise<FetchedSource> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(`not a commit sha: ${sha}`);
  const dir = await mkdtemp(join(tmpdir(), 'opend-build-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const git = (...args: string[]) =>
    run('git', [...gitAuthArgs(sourceUrl, token, tokenHosts), ...args], {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    await git('init', '-q');
    // `--` so a source URL such as `--upload-pack=...` can never be read as an option.
    await git('fetch', '-q', '--depth', '1', '--no-tags', '--', sourceUrl, sha);
    await git('checkout', '-q', '--detach', 'FETCH_HEAD');
    return { dir, cleanup };
  } catch (err) {
    await cleanup();
    // The original error is not attached as `cause`: its `cmd` includes the
    // auth header, and errors end up in logs and the build_jobs table.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`fetching ${sha} failed${gitFailureReason(err)}`);
  }
}

/** Where installation tokens may be sent when no GitHub Enterprise host is configured. */
export const DEFAULT_GIT_HOSTS: readonly string[] = ['github.com'];

/** Whether `sourceUrl` is an https URL on one of `hosts` (host, with port if not 443). */
export function onTokenHost(sourceUrl: string, hosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && hosts.includes(url.host);
}

/**
 * Git options that send a GitHub installation token as an HTTP header, so it
 * never appears in a URL or an error message. The header is only added for an
 * https source on a GitHub host (`hosts`, see `GitHubApp.gitHosts`), so a
 * repository registered with any other URL never receives the token.
 */
export function gitAuthArgs(
  sourceUrl: string,
  token?: string,
  hosts: readonly string[] = DEFAULT_GIT_HOSTS,
): string[] {
  return token && onTokenHost(sourceUrl, hosts)
    ? [
        '-c',
        `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      ]
    : [];
}

/** `: fatal: ...` from a failed git command's stderr, or an empty string. */
function gitFailureReason(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr?.trim();
  const lines = stderr?.split('\n') ?? [];
  // git's first "fatal:" line names the cause; later lines are hints.
  const reason = lines.find((l) => l.startsWith('fatal:')) ?? lines.at(-1);
  return reason ? `: ${reason}` : '';
}

export interface RemoteRef {
  /** Short name, as in webhooks and `release_refs`: `main`, `v1.2`. */
  ref: string;
  sha: string;
  kind: 'branch' | 'tag';
}

/** The branch and tag heads of a remote. Annotated tags resolve to the commit they point at. */
export async function listRemoteRefs(
  sourceUrl: string,
  token?: string,
  tokenHosts?: readonly string[],
): Promise<RemoteRef[]> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      'git',
      [
        ...gitAuthArgs(sourceUrl, token, tokenHosts),
        'ls-remote',
        '--heads',
        '--tags',
        '--',
        sourceUrl,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch (err) {
    // As in fetchSource: the original error's `cmd` carries the auth header.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`listing refs failed${gitFailureReason(err)}`);
  }
  const refs = new Map<string, RemoteRef>();
  const peeled = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = /^([0-9a-f]{40,64})\trefs\/(heads|tags)\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!m) continue;
    const [, sha, kind, ref, peel] = m as unknown as [string, string, string, string, string?];
    if (peel) peeled.set(ref, sha);
    else refs.set(`${kind}/${ref}`, { ref, sha, kind: kind === 'heads' ? 'branch' : 'tag' });
  }
  for (const [ref, sha] of peeled) {
    const tag = refs.get(`tags/${ref}`);
    if (tag) tag.sha = sha;
  }
  return [...refs.values()];
}
