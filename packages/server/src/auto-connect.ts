import { parse as parseYaml } from 'yaml';
import { CONFIG_FILE, siteSettingsSchema } from '@opend/model';
import {
  audit,
  enqueueJob,
  findRepoByName,
  listRepos,
  updateRepo,
  upsertRepo,
  withTransaction,
  type Db,
  type Pool,
  type Repo,
  type RepoInput,
} from '@opend/store';
import { listRemoteRefs, releaseRefsToPoll, type GitHubAccess, type RepoRef } from '@opend/worker';
import type { AppContext } from './context.js';
import { githubUrls, pickableRepos, type PickableRepo } from './github-connect.js';

/** The audit actor of a docs source connected without anyone choosing it. */
export const AUTO_CONNECT_ACTOR = 'github:auto-connect';

/** How deep below the repository root `opend.config.yaml` is looked for (`a/b/c/`). */
const SEARCH_DEPTH = 3;
/** At most this many candidate configs are read to choose between them. */
const MAX_CANDIDATES = 10;
/** A result that needs the console is kept this long, so page views do not call GitHub each time. */
const RETRY_MS = 60_000;

/** What auto-connect needs: the admin context, or the worker's equivalents. */
export type AutoConnectDeps = Pick<AppContext, 'pool' | 'github' | 'settings' | 'log'> & {
  config: Pick<AppContext['config'], 'siteRepo'>;
  env: Pick<AppContext['env'], 'githubWebUrl' | 'githubApiUrl'>;
};

export type AutoConnectOutcome =
  /** The site had no docs source; one was connected and its builds queued. */
  | { status: 'connected'; repo: Repo; configPath: string; builds: number }
  /** Left for the console, for `reason` (shown on the overview). */
  | { status: 'manual'; reason: string }
  /** Nothing to do: the site has a docs source, or GitHub gives it no repository yet. */
  | { status: 'idle' };

/** A docs repository's value for `POST /admin/source`, and the console's equivalent. */
export type SourceInput = RepoInput & { installationId: number | null };

/**
 * Saves the site's docs source, as the console's Docs source form does:
 * changing the site's repository keeps its row (access settings and history),
 * unless `OPEND_SITE_REPO` pins it; otherwise the repository is registered.
 */
export async function saveSource(
  db: Db,
  input: SourceInput,
  options: { current: Repo | null; pinned: boolean; actor: string; details?: object },
): Promise<Repo> {
  const existing = await findRepoByName(db, input.fullName);
  const repo =
    !existing && options.current && !options.pinned
      ? await updateRepo(db, options.current.id, input)
      : await upsertRepo(db, input);
  await audit(db, options.actor, 'repo.upsert', { ...input, ...options.details });
  return repo!;
}

/**
 * Queues a build of the head of every release ref of a repo, as **Rebuild
 * now** does. Throws when the repository's refs cannot be listed.
 */
export async function queueReleaseBuilds(
  deps: { pool: Pool; github: GitHubAccess },
  repo: Repo,
  actor: string,
): Promise<number> {
  const token = await deps.github.repoToken(repo, 'read');
  const refs = releaseRefsToPoll(
    await listRemoteRefs(repo.sourceUrl, token, deps.github.gitHosts),
    repo.releaseRefs,
  );
  await withTransaction(deps.pool, async (db) => {
    for (const { ref, sha } of refs) {
      const job = await enqueueJob(db, { repoId: repo.id, ref, sha });
      await audit(db, actor, 'build.request', { repo: repo.fullName, ref, sha, job: job.id });
    }
  });
  return refs.length;
}

/** A located `opend.config.yaml`: its folder (`.` for the root) and parsed YAML. */
interface FoundConfig {
  path: string;
  docsPath: string;
  raw: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The `opend.config.yaml` files of a repository's default branch, read
 * through the GitHub API (git data endpoints, which every GitHub and the
 * test fake serve): the root one alone when there is one, else every one up
 * to `SEARCH_DEPTH` folders down, outside hidden folders and `node_modules`.
 */
async function findConfigs(
  github: GitHubAccess,
  repo: RepoRef,
  branch: string,
): Promise<FoundConfig[]> {
  const api = (path: string) => github.request(repo, 'GET', `/repos/${repo.fullName}${path}`);
  const expect = (res: { status: number; data: unknown }, what: string) => {
    if (res.status !== 200) throw new Error(`GitHub ${what} failed: ${res.status}`);
    return asRecord(res.data) ?? {};
  };
  const ref = expect(
    await api(`/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`),
    `reading ${branch}`,
  );
  const commitSha = asRecord(ref.object)?.sha;
  if (typeof commitSha !== 'string') throw new Error(`GitHub returned no commit for ${branch}`);
  const commit = expect(await api(`/git/commits/${commitSha}`), 'reading the commit');
  const treeSha = asRecord(commit.tree)?.sha;
  if (typeof treeSha !== 'string') throw new Error('GitHub returned no tree');
  const tree = expect(await api(`/git/trees/${treeSha}?recursive=1`), 'reading the tree');
  const entries = (Array.isArray(tree.tree) ? tree.tree : [])
    .map(asRecord)
    .filter((e): e is Record<string, unknown> => e !== null && e.type === 'blob')
    .filter((e) => typeof e.path === 'string' && typeof e.sha === 'string')
    .map((e) => ({ path: e.path as string, sha: e.sha as string }))
    .filter(({ path }) => {
      const parts = path.split('/');
      return (
        parts.at(-1) === CONFIG_FILE &&
        parts.length - 1 <= SEARCH_DEPTH &&
        !parts.slice(0, -1).some((p) => p.startsWith('.') || p === 'node_modules')
      );
    })
    .sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : 1),
    );
  const root = entries.find((e) => e.path === CONFIG_FILE);
  const chosen = root ? [root] : entries.slice(0, MAX_CANDIDATES);
  const found: FoundConfig[] = [];
  for (const { path, sha } of chosen) {
    const blob = expect(await api(`/git/blobs/${sha}`), `reading ${path}`);
    const text =
      blob.encoding === 'base64' && typeof blob.content === 'string'
        ? Buffer.from(blob.content, 'base64').toString('utf8')
        : typeof blob.content === 'string'
          ? blob.content
          : '';
    let raw: unknown = null;
    try {
      raw = parseYaml(text);
    } catch {
      // Unreadable YAML still marks a docs folder; its build reports the error.
    }
    const dir = path.split('/').slice(0, -1).join('/');
    found.push({ path, docsPath: dir || '.', raw });
  }
  return found;
}

/** Chooses the docs folder: the only config, else the only one with a `site:` block. */
function chooseConfig(found: FoundConfig[]): FoundConfig | string {
  if (found.length === 0) return `no ${CONFIG_FILE} on the default branch`;
  if (found.length === 1) return found[0]!;
  const withSite = found.filter((f) => asRecord(f.raw)?.site !== undefined);
  if (withSite.length === 1) return withSite[0]!;
  const list = (withSite.length ? withSite : found).map((f) => f.path).join(', ');
  return withSite.length
    ? `several ${CONFIG_FILE} files have a site: block (${list})`
    : `several ${CONFIG_FILE} files and none has a site: block (${list})`;
}

/** Connects the one repository the GitHub App exposes. See `autoConnect`. */
async function connectOne(deps: AutoConnectDeps): Promise<AutoConnectOutcome> {
  const repos = await listRepos(deps.pool);
  const pinned = deps.config.siteRepo;
  if (pinned ? repos.some((r) => r.fullName.toLowerCase() === pinned.toLowerCase()) : repos.length)
    return { status: 'idle' };
  let list: PickableRepo[] | null;
  try {
    list = await pickableRepos(deps);
  } catch (err) {
    return {
      status: 'manual',
      reason: `GitHub’s repository list could not be read (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (!list?.length) return { status: 'idle' };
  if (pinned) list = list.filter((r) => r.fullName.toLowerCase() === pinned.toLowerCase());
  if (list.length !== 1)
    return {
      status: 'manual',
      reason: pinned
        ? `the GitHub App cannot access ${pinned}, the repository OPEND_SITE_REPO names.`
        : `the GitHub App can access ${list.length} repositories; choose the docs repository on Docs source.`,
    };
  const picked = list[0]!;
  const sourceUrl = `${githubUrls(deps).web}/${picked.fullName}.git`;
  const installationId =
    picked.installationId && picked.installationId > 0 ? picked.installationId : null;
  let config: FoundConfig | string;
  try {
    config = chooseConfig(
      await findConfigs(
        deps.github,
        { fullName: picked.fullName, installationId, sourceUrl },
        picked.defaultBranch,
      ),
    );
  } catch (err) {
    return {
      status: 'manual',
      reason: `${picked.fullName} could not be read (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (typeof config === 'string')
    return { status: 'manual', reason: `${picked.fullName} has ${config}.` };
  const site = siteSettingsSchema.safeParse(asRecord(config.raw)?.site ?? {});
  if (!site.success)
    return {
      status: 'manual',
      reason: `the site: block of ${picked.fullName}/${config.path} is not valid (${site.error.issues
        .map((i) => `${i.path.join('.') || 'site'}: ${i.message}`)
        .join('; ')}).`,
    };
  const input: SourceInput = {
    fullName: picked.fullName,
    sourceUrl,
    installationId,
    releaseRefs: site.data.releaseRefs ?? [picked.defaultBranch],
    docsPath: config.docsPath,
  };
  const repo = await withTransaction(deps.pool, async (db) => {
    // One connection per site, however many replicas and page views race here.
    await db.query("select pg_advisory_xact_lock(hashtext('opend:auto-connect'))");
    const now = await listRepos(db);
    if (pinned ? now.some((r) => r.fullName.toLowerCase() === pinned.toLowerCase()) : now.length)
      return null;
    return saveSource(db, input, {
      current: null,
      pinned: Boolean(pinned),
      actor: AUTO_CONNECT_ACTOR,
      details: { config: config.path },
    });
  });
  if (!repo) return { status: 'idle' };
  deps.log({
    level: 'info',
    msg: 'docs source connected',
    repo: repo.fullName,
    docsPath: repo.docsPath,
    releaseRefs: repo.releaseRefs,
  });
  let builds = 0;
  try {
    builds = await queueReleaseBuilds(deps, repo, AUTO_CONNECT_ACTOR);
  } catch (err) {
    // The poller, a push or Rebuild now still builds it.
    deps.log({
      level: 'warn',
      msg: 'auto-connect could not queue builds',
      repo: repo.fullName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { status: 'connected', repo, configPath: config.path, builds };
}

const recent = new WeakMap<Pool, { at: number; outcome: Promise<AutoConnectOutcome> }>();

/**
 * Zero-touch setup: when the site has no docs source yet and the GitHub App
 * (its stored installation, or the hosting provider's broker) exposes exactly
 * one repository, connects it. The docs folder is where `opend.config.yaml`
 * is on the default branch (the root's first, else the only one up to three
 * folders down, else the only one with a `site:` block), the release refs are
 * its `site.releaseRefs` (default: the default branch), and every ref's head is
 * queued to build, as the console's Docs source form and Rebuild now do. The
 * build then applies the rest of the `site:` block.
 *
 * Called where an installation completes and lazily (console pages, pushes
 * for an unregistered repository, the poller). Calls that run at once share
 * one attempt, and an outcome that needs the console is reused for a minute.
 */
export function autoConnect(deps: AutoConnectDeps): Promise<AutoConnectOutcome> {
  const last = recent.get(deps.pool);
  if (last && Date.now() - last.at < RETRY_MS) {
    // A manual outcome is reused; idle or connected ones are cheap to recheck.
    const reuse = last.outcome.then((o) => (o.status === 'manual' ? o : null));
    return reuse.then((o) => o ?? run(deps));
  }
  return run(deps);
}

function run(deps: AutoConnectDeps): Promise<AutoConnectOutcome> {
  const pending = recent.get(deps.pool);
  if (pending?.at === 0) return pending.outcome;
  const outcome = connectOne(deps).catch((err: unknown): AutoConnectOutcome => {
    deps.log({ level: 'error', msg: 'auto-connect failed', error: String(err) });
    return { status: 'manual', reason: 'automatic setup failed; see the server log.' };
  });
  recent.set(deps.pool, { at: 0, outcome });
  void outcome.then((o) => {
    if (o.status === 'manual') recent.set(deps.pool, { at: Date.now(), outcome });
    else recent.delete(deps.pool);
  });
  return outcome;
}

/** Forgets a reused outcome, so the next call asks GitHub again (after an install). */
export function forgetAutoConnect(pool: Pool): void {
  const last = recent.get(pool);
  if (last && last.at !== 0) recent.delete(pool);
}
