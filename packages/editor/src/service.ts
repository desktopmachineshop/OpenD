import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { LRUCache } from 'lru-cache';
import { hasErrors, type Diagnostic } from '@opend/model';
import { buildRelease, type BuildResult, type SourceTree } from '@opend/build';
import { parseXml } from '@opend/dita';
import { validate } from '@opend/validate';
import {
  createEditorBranch,
  findEditorBranch,
  getActiveEditorBranch,
  recordEditorAudit,
  updateEditorBranch,
  type EditorAction,
  type EditorBranch,
  type EditorUser,
  type Pool,
  type Repo,
} from '@opend/store';
import { EditorError } from './errors.js';
import type {
  GitHubClient,
  GitIdentity,
  PullRequest,
  RulesLookup,
  TreeChange,
  TreeEntry,
  UserGitHubClient,
} from './github/client.js';
import type { UserTokenSource } from './github/user.js';
import { elementIds, hasConflictMarkers, merge3 } from './merge.js';
import { evaluateReview, readRequirements, type ReviewState } from './rules.js';

export { EditorError };

/** Shown to authors without a GitHub token when the repository requires signed commits. */
export const SIGNED_COMMITS_REQUIRED =
  'This repository requires signed commits. Sign in with GitHub to save and publish.';

/** Who is acting: the signed-in editor and their session, both from the server side. */
export interface Actor {
  user: EditorUser;
  sessionId: string;
  /** The author's own GitHub token, when they signed in with GitHub and the editor keeps it. */
  github?: UserTokenSource | null;
}

/**
 * Whether commits to the author's branch, or merges into the base branch,
 * need verified signatures: from branch protection or rulesets. `unknown`
 * when GitHub hides the rules from the app.
 */
export type SigningRequirement = 'required' | 'not-required' | 'unknown';

/** How the author's saves reach GitHub, shown in the editor. */
export interface CommitIdentity {
  requirement: SigningRequirement;
  /**
   * `user`: as the author's own GitHub account, signed by GitHub ("Verified").
   * `app`: the OpenD app on their behalf, crediting them as co-author.
   * `blocked`: signed commits are required and the author has no GitHub token.
   */
  via: 'user' | 'app' | 'blocked';
  login: string | null;
}

interface WriteMode extends CommitIdentity {
  /** The client for writes: the author's own token, else the installation. */
  writer: GitHubClient;
  user: UserGitHubClient | null;
  /**
   * Only GitHub-signed commits: saves through createCommitOnBranch, merges of
   * the base branch through update-branch. Used for authors with a token
   * unless the repository is known not to require signatures.
   */
  signedFlow: boolean;
}

export interface EditorServiceOptions {
  /** The client for an author's own token (the REST/GraphQL client in production). */
  userClient?: (repo: Repo, source: UserTokenSource) => UserGitHubClient;
  /** Milliseconds to wait between checks while GitHub runs an update-branch. */
  updateBranchPolls?: number[];
  /** How long signing requirements are cached, ms. */
  signingTtlMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The repository being edited. */
export interface RepoContext {
  repo: Repo;
  gh: GitHubClient;
  baseBranch: string;
  /** `docs_path` as a repository path prefix: `''` or `docs/`. */
  docsPrefix: string;
}

/** Files the build reads as text (as in `@opend/build`). */
const TEXT_EXTENSIONS = new Set([
  '.dita',
  '.ditamap',
  '.bookmap',
  '.ditaval',
  '.xml',
  '.yaml',
  '.yml',
]);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.opend', 'dist']);
/** Files authors may edit in v1: DITA topics and maps. */
export const EDITABLE_EXTENSIONS = new Set(['.dita', '.ditamap', '.bookmap']);

export const isTextFile = (path: string) => TEXT_EXTENSIONS.has(posix.extname(path).toLowerCase());
export const isEditable = (path: string) =>
  EDITABLE_EXTENSIONS.has(posix.extname(path).toLowerCase());

export function docsPrefix(docsPath: string): string {
  const normal = posix.normalize(docsPath.replace(/\\/g, '/')).replace(/\/$/, '');
  const p = normal === '.' ? '' : normal;
  if (p.startsWith('..') || p.startsWith('/'))
    throw new Error(`docs_path escapes the repository: ${docsPath}`);
  return p ? `${p}/` : '';
}

/** A docs-root-relative path an author may write, or an error. */
export function checkEditablePath(path: string): string {
  const p = path.trim();
  if (
    !p ||
    p.startsWith('/') ||
    p.includes('\\') ||
    p.split('/').some((s) => s === '' || s === '.' || s === '..' || IGNORED_DIRS.has(s)) ||
    !/^[A-Za-z0-9._/-]+$/.test(p)
  )
    throw new EditorError(400, `"${path}" is not a file the editor can write.`);
  if (!isEditable(p))
    throw new EditorError(
      400,
      'Only DITA topics (.dita) and maps (.ditamap, .bookmap) can be edited.',
    );
  return p;
}

/** Problems that stop a save: the file must be well-formed XML. */
export function wellFormedness(path: string, content: string): Diagnostic[] {
  const diagnostics = parseXml(content, path).diagnostics.filter((d) => d.severity === 'error');
  if (hasConflictMarkers(content))
    diagnostics.unshift({
      severity: 'error',
      code: 'conflict-markers',
      message: 'Remove the conflict markers (<<<<<<<, =======, >>>>>>>) before saving.',
      file: path,
    });
  return diagnostics;
}

/** A built and validated tree: a saved commit, or a commit plus unsaved edits. */
export interface DraftBuild {
  commitSha: string;
  tree: SourceTree;
  result: BuildResult;
  diagnostics: Diagnostic[];
  /** Docs-relative path → blob sha, for assets and the file list. */
  blobs: Map<string, string>;
  /** Docs-relative paths with unsaved edits. */
  edited: string[];
}

export interface SyncResult {
  /** `behind`: the base branch has newer changes that merge cleanly; GitHub merges them in on publish. */
  status: 'up-to-date' | 'merged' | 'conflict' | 'behind';
  sha?: string;
}

export interface FileConflict {
  path: string;
  base: string | null;
  mine: string;
  theirs: string;
  /** Both versions with conflict markers around each conflicting section. */
  merged: string;
}

export interface StructuralConflict {
  path: string;
  reason: string;
}

export interface ConflictSet {
  oursSha: string;
  theirsSha: string;
  baseSha: string;
  /**
   * Files that merged on their own, relative to the current version of main:
   * the author's blob (`sha`), or a line-by-line merge (`content`) of the
   * author's text and main's (`theirs`).
   */
  automatic: { path: string; sha?: string | null; content?: string; theirs?: string }[];
  conflicts: FileConflict[];
  structural: StructuralConflict[];
}

export type Choice =
  | { path: string; take: 'mine' }
  | { path: string; take: 'theirs' }
  | { path: string; take: 'manual'; content: string };

export interface PublishOutcome {
  pull: PullRequest;
  created: boolean;
  merged: boolean;
  mergeSha?: string;
  review: ReviewState;
  /** Why an attempted merge was refused. */
  mergeError?: string;
}

/** Author line of a commit and the trailer that credits them, from the server-side session. */
export function authorOf(user: EditorUser): GitIdentity {
  return { name: user.name || user.email, email: user.email };
}

export function coAuthorTrailer(user: EditorUser): string {
  const a = authorOf(user);
  return `Co-authored-by: ${a.name.replace(/[<>\n]/g, '')} <${a.email.replace(/[<>\n]/g, '')}>`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'drafts'
  );
}

/** Runs tasks for the same key one after another, so two saves never race on one branch. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.tails.set(key, next);
    void next
      .catch(() => {})
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    return next;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Everything the editor does against GitHub and the store. Routes call these
 * with the signed-in actor; ownership of the branch is checked here, so no
 * route can write to someone else's branch.
 */
export class EditorService {
  private readonly trees = new LRUCache<string, TreeEntry[]>({ max: 64 });
  private readonly blobCache = new LRUCache<string, Buffer>({
    maxSize: 64 * 1024 * 1024,
    sizeCalculation: (b) => Math.max(1, b.length),
  });
  private readonly builds = new LRUCache<string, DraftBuild>({ max: 16 });
  private readonly locks = new KeyedLock();
  private readonly signing: LRUCache<string, SigningRequirement>;
  private readonly polls: number[];

  constructor(
    private readonly pool: Pool,
    private readonly options: EditorServiceOptions = {},
  ) {
    this.signing = new LRUCache({ max: 256, ttl: options.signingTtlMs ?? 60_000 });
    this.polls = options.updateBranchPolls ?? [250, 500, 1000, 1000, 2000, 2000, 3000, 5000];
  }

  private async audit(
    rc: RepoContext,
    actor: Actor,
    action: EditorAction,
    entry: {
      branch?: string;
      commitSha?: string | null;
      prNumber?: number | null;
      detail?: object;
    },
  ): Promise<void> {
    await recordEditorAudit(this.pool, {
      sessionId: actor.sessionId,
      userId: actor.user.id,
      repoId: rc.repo.id,
      action,
      ...entry,
    });
  }

  // ---- reading -------------------------------------------------------------

  async commitTree(
    rc: RepoContext,
    commitSha: string,
  ): Promise<{ tree: string; entries: TreeEntry[] }> {
    const commit = await rc.gh.getCommit(commitSha);
    let entries = this.trees.get(commit.tree);
    if (!entries) {
      entries = await rc.gh.getTree(commit.tree);
      this.trees.set(commit.tree, entries);
    }
    return { tree: commit.tree, entries };
  }

  async blob(rc: RepoContext, sha: string): Promise<Buffer> {
    let data = this.blobCache.get(sha);
    if (!data) {
      data = await rc.gh.getBlob(sha);
      this.blobCache.set(sha, data);
    }
    return data;
  }

  /** Docs-relative path → blob sha for every file under the docs root. */
  async docsFiles(rc: RepoContext, commitSha: string): Promise<Map<string, string>> {
    const { entries } = await this.commitTree(rc, commitSha);
    const out = new Map<string, string>();
    for (const e of entries) {
      if (!e.path.startsWith(rc.docsPrefix)) continue;
      const rel = e.path.slice(rc.docsPrefix.length);
      if (rel.split('/').some((part) => IGNORED_DIRS.has(part))) continue;
      out.set(rel, e.sha);
    }
    return out;
  }

  async readFile(
    rc: RepoContext,
    commitSha: string,
    path: string,
  ): Promise<{ sha: string; text: string } | null> {
    const sha = (await this.docsFiles(rc, commitSha)).get(path);
    return sha ? { sha, text: (await this.blob(rc, sha)).toString('utf8') } : null;
  }

  /**
   * Builds and validates the docs at a commit, optionally with unsaved edits
   * laid over it. Saved commits are cached; drafts are built fresh.
   */
  async build(
    rc: RepoContext,
    commitSha: string,
    overlay: Map<string, string> = new Map(),
  ): Promise<DraftBuild> {
    const key = `${rc.repo.id}:${commitSha}`;
    if (overlay.size === 0) {
      const cached = this.builds.get(key);
      if (cached) return cached;
    }
    const blobs = await this.docsFiles(rc, commitSha);
    const files = new Set<string>([...blobs.keys(), ...overlay.keys()]);
    const texts = new Map<string, string>();
    const textPaths = [...blobs.keys()].filter((p) => isTextFile(p) && !overlay.has(p));
    const contents = await mapLimit(textPaths, 8, async (p) =>
      (await this.blob(rc, blobs.get(p)!)).toString('utf8'),
    );
    textPaths.forEach((p, i) => texts.set(p, contents[i]!));
    for (const [p, text] of overlay) texts.set(p, text);
    const tree: SourceTree = { files, texts, ref: commitSha };
    const result = buildRelease(tree);
    const draft: DraftBuild = {
      commitSha,
      tree,
      result,
      diagnostics: validate(result),
      blobs,
      edited: [...overlay.keys()],
    };
    if (overlay.size === 0) this.builds.set(key, draft);
    return draft;
  }

  // ---- branches ------------------------------------------------------------

  /** The commit the author works on: their branch head, or the base branch when they have none. */
  async workingHead(rc: RepoContext, branch: EditorBranch | null): Promise<string> {
    const sha = await rc.gh.branchSha(branch?.branch ?? rc.baseBranch);
    if (!sha) {
      if (branch)
        throw new EditorError(409, `The branch ${branch.branch} no longer exists on GitHub.`);
      throw new EditorError(
        503,
        `The base branch ${rc.baseBranch} does not exist in ${rc.repo.fullName}.`,
      );
    }
    return sha;
  }

  /**
   * The author's active branch, refreshed from GitHub: a merged pull request
   * retires it (the next save starts a new branch); a closed one is forgotten.
   */
  async activeBranch(rc: RepoContext, user: EditorUser): Promise<EditorBranch | null> {
    const branch = await getActiveEditorBranch(this.pool, rc.repo.id, user.id);
    if (!branch) return null;
    if (branch.prNumber !== null) {
      const pull = await rc.gh.getPull(branch.prNumber);
      if (pull?.merged) {
        await updateEditorBranch(this.pool, branch.id, { status: 'merged' });
        return null;
      }
      if (!pull || pull.state === 'closed') {
        await updateEditorBranch(this.pool, branch.id, { prNumber: null });
        branch.prNumber = null;
      }
    }
    if (!(await rc.gh.branchSha(branch.branch))) {
      await updateEditorBranch(this.pool, branch.id, { status: 'abandoned' });
      return null;
    }
    return branch;
  }

  /** The named branch, if it is this author's active branch. Anything else is refused. */
  async ownBranch(rc: RepoContext, user: EditorUser, name: string): Promise<EditorBranch> {
    const branch = await findEditorBranch(this.pool, rc.repo.id, name);
    if (!branch || branch.userId !== user.id) {
      throw new EditorError(403, 'You can only change your own working branch.', { branch: name });
    }
    if (branch.status !== 'active')
      throw new EditorError(
        409,
        'This branch has already been published. Reload to start a new one.',
      );
    return branch;
  }

  /** The author's branch, created from the base branch's head on first use. */
  private async ensureBranch(
    rc: RepoContext,
    actor: Actor,
    writer: GitHubClient,
    existing: EditorBranch | null,
  ): Promise<EditorBranch> {
    if (existing) return existing;
    const base = await this.workingHead(rc, null);
    const name = `editor/${actor.user.id}/${slugify(actor.user.name || actor.user.email.split('@')[0]!)}-${randomBytes(3).toString('hex')}`;
    await writer.createBranch(name, base);
    const created = await createEditorBranch(this.pool, {
      repoId: rc.repo.id,
      userId: actor.user.id,
      branch: name,
      baseBranch: rc.baseBranch,
      headSha: base,
    });
    if (created) return created;
    // Another request created one first; use it.
    const winner = await getActiveEditorBranch(this.pool, rc.repo.id, actor.user.id);
    if (!winner) throw new EditorError(409, 'Could not create a working branch; try again.');
    return winner;
  }

  // ---- signed commits --------------------------------------------------------

  /**
   * Whether the base branch or the author's branch requires signed commits:
   * classic protection (`required_signatures`) or a ruleset rule of that type.
   * Rulesets are read for the branch name even before it exists, so a rule on
   * `editor/**` counts. Cached briefly.
   */
  async signingRequirement(rc: RepoContext, workBranch: string): Promise<SigningRequirement> {
    const key = `${rc.repo.id}\n${rc.baseBranch}\n${workBranch}`;
    const cached = this.signing.get(key);
    if (cached) return cached;
    const safe = async (lookup: Promise<RulesLookup<boolean>>): Promise<RulesLookup<boolean>> =>
      lookup.catch(() => ({ status: 'forbidden' as const }));
    const rules = (branch: string) =>
      safe(
        rc.gh
          .branchRulesets(branch)
          .then((r) =>
            r.status === 'ok' ? { status: 'ok' as const, rules: r.rules.requiredSignatures } : r,
          ),
      );
    const lookups = await Promise.all([
      safe(rc.gh.requiredSignatures(rc.baseBranch)),
      safe(rc.gh.requiredSignatures(workBranch)),
      rules(rc.baseBranch),
      rules(workBranch),
    ]);
    const result: SigningRequirement = lookups.some((l) => l.status === 'ok' && l.rules)
      ? 'required'
      : lookups.some((l) => l.status === 'forbidden')
        ? 'unknown'
        : 'not-required';
    this.signing.set(key, result);
    return result;
  }

  /**
   * How this author writes: with their own GitHub token when they have one
   * (commits GitHub signs as them), else as the app. On a repository that
   * requires signed commits an author without a token may not write at all;
   * with `write`, that refusal is thrown before any GitHub write.
   */
  private async mode(
    rc: RepoContext,
    actor: Actor,
    branch: EditorBranch | null,
    write: boolean,
  ): Promise<WriteMode> {
    const requirement = await this.signingRequirement(
      rc,
      branch?.branch ?? `editor/${actor.user.id}/new`,
    );
    const user =
      actor.github && this.options.userClient
        ? this.options.userClient(rc.repo, actor.github)
        : null;
    if (requirement === 'required' && !user) {
      if (write)
        throw new EditorError(403, SIGNED_COMMITS_REQUIRED, { signedCommitsRequired: true });
      return {
        requirement,
        via: 'blocked',
        login: null,
        writer: rc.gh,
        user: null,
        signedFlow: true,
      };
    }
    return {
      requirement,
      via: user ? 'user' : 'app',
      login: user?.login ?? null,
      writer: user ?? rc.gh,
      user,
      signedFlow: user !== null && requirement !== 'not-required',
    };
  }

  /** How the author's saves reach GitHub, for the editor to show. Never throws the refusal. */
  async identity(
    rc: RepoContext,
    actor: Actor,
    branch: EditorBranch | null,
  ): Promise<CommitIdentity> {
    const { requirement, via, login } = await this.mode(rc, actor, branch, false);
    return { requirement, via, login };
  }

  /** One commit on the author's branch through createCommitOnBranch (signed by GitHub). */
  private async commitAs(
    user: UserGitHubClient,
    branch: EditorBranch,
    expectedHeadOid: string,
    message: { headline: string; body?: string },
    additions: { path: string; content: string }[],
    stale: string,
  ): Promise<string> {
    const result = await user.commitOnBranch({
      branch: branch.branch,
      expectedHeadOid,
      ...message,
      additions,
      deletions: [],
    });
    if (result.status === 'stale') throw new EditorError(409, stale, { stale: true });
    return result.sha;
  }

  /** The branch's open pull request, if any. */
  private async openPull(rc: RepoContext, branch: EditorBranch): Promise<PullRequest | null> {
    if (branch.prNumber === null) return null;
    const pull = await rc.gh.getPull(branch.prNumber);
    return pull && pull.state === 'open' ? pull : null;
  }

  /** GitHub merges the base branch into the pull request's branch (update-branch); waits for it. */
  private async updateOnGitHub(
    rc: RepoContext,
    writer: GitHubClient,
    branch: EditorBranch,
    pull: PullRequest,
    expected: string,
  ): Promise<string> {
    const result = await writer.updatePullBranch(pull.number, expected);
    if (result.status === 'conflict')
      throw new EditorError(
        409,
        `GitHub could not merge ${rc.baseBranch} into your branch (${result.message}). Resolve the conflicts first.`,
        { conflicts: true },
      );
    if (result.status === 'refused')
      throw new EditorError(
        409,
        `GitHub did not update your branch (${result.message}). Reload and try again.`,
        { stale: true },
      );
    for (const delay of [0, ...this.polls]) {
      if (delay) await sleep(delay);
      const sha = await rc.gh.branchSha(branch.branch);
      if (sha && sha !== expected) return sha;
    }
    throw new EditorError(
      503,
      `GitHub is still merging ${rc.baseBranch} into your branch. Reload in a moment.`,
    );
  }

  /**
   * Merges the base branch into the author's branch with only GitHub-signed
   * commits. createCommitOnBranch cannot make a merge commit, so:
   * 1. commit main's version of every file changed on both sides (signed), so
   *    GitHub's merge has nothing to conflict on;
   * 2. GitHub merges main in through update-branch (a merge commit GitHub signs);
   * 3. commit the author's resolutions and the line-by-line merges (signed).
   * The branch never loses history; squash-merging on publish keeps main tidy.
   */
  private async signedMerge(
    rc: RepoContext,
    actor: Actor,
    branch: EditorBranch,
    mode: WriteMode,
    set: ConflictSet,
    choices: Choice[],
    pull: PullRequest,
  ): Promise<string> {
    const user = mode.user!;
    const stale = 'Something changed while merging. Review the files again.';
    let head = set.oursSha;
    const theirsFirst = [
      ...set.conflicts.map((c) => ({ path: c.path, content: c.theirs })),
      ...set.automatic
        .filter((a) => a.content !== undefined)
        .map((a) => ({ path: a.path, content: a.theirs! })),
    ];
    if (theirsFirst.length)
      head = await this.commitAs(
        user,
        branch,
        head,
        {
          headline: `Take ${rc.baseBranch}'s version of ${theirsFirst.length} file${theirsFirst.length === 1 ? '' : 's'} before merging`,
          body: 'Made by the OpenD web editor so GitHub can merge without conflicts; the next commits put the resolved text back.',
        },
        theirsFirst,
        stale,
      );
    head = await this.updateOnGitHub(rc, mode.writer, branch, pull, head);
    const resolved = [
      ...set.automatic
        .filter((a) => a.content !== undefined)
        .map((a) => ({ path: a.path, content: a.content! })),
      ...choices.flatMap((c) => {
        if (c.take === 'theirs') return [];
        const conflict = set.conflicts.find((x) => x.path === c.path)!;
        return [{ path: c.path, content: c.take === 'mine' ? conflict.mine : c.content }];
      }),
    ];
    if (resolved.length)
      head = await this.commitAs(
        user,
        branch,
        head,
        {
          headline: choices.length
            ? `Resolve conflicts with ${rc.baseBranch}`
            : `Merge ${rc.baseBranch} line by line`,
          body: [
            choices.length
              ? 'Conflicts resolved in the OpenD web editor:'
              : 'Merged automatically.',
            ...choices.map((c) => `- ${c.path}: ${describeChoice(c)}`),
          ].join('\n'),
        },
        resolved,
        stale,
      );
    await updateEditorBranch(this.pool, branch.id, { headSha: head });
    await this.audit(rc, actor, choices.length ? 'resolve' : 'sync', {
      branch: branch.branch,
      commitSha: head,
      prNumber: pull.number,
      detail: {
        resolved: choices.map((c) => ({ path: c.path, take: c.take })),
        via: 'user',
        signed: true,
      },
    });
    return head;
  }

  // ---- save ----------------------------------------------------------------

  /**
   * Commits files to the author's branch (creating it if needed), then merges
   * the base branch in. With the author's GitHub token the commit is made by
   * GitHub as them (createCommitOnBranch, signed); otherwise by the app, with
   * the author and trailer from the session's user, never from the request.
   */
  async save(
    rc: RepoContext,
    actor: Actor,
    input: {
      branch?: string | null;
      files: { path: string; content: string }[];
      /** Blob sha of the file the author started from, to catch edits made elsewhere meanwhile. */
      expectSha?: string | null;
      message?: string;
    },
  ): Promise<{ branch: EditorBranch; sha: string; sync: SyncResult; diagnostics: Diagnostic[] }> {
    const files = input.files.map((f) => ({ path: checkEditablePath(f.path), content: f.content }));
    if (!files.length) throw new EditorError(400, 'Nothing to save.');
    for (const f of files) {
      const problems = wellFormedness(f.path, f.content);
      if (problems.length)
        throw new EditorError(422, `${f.path} is not well-formed XML, so it was not saved.`, {
          diagnostics: problems,
        });
    }
    const existing = input.branch
      ? await this.ownBranch(rc, actor.user, input.branch)
      : await this.activeBranch(rc, actor.user);
    // Refused here, before any write, when signed commits are required and the author has no token.
    const mode = await this.mode(rc, actor, existing, true);
    const branch = await this.ensureBranch(rc, actor, mode.writer, existing);
    const staleMessage =
      files.length === 1
        ? `${files[0]!.path} changed since you opened it (another save or a merge from ${rc.baseBranch}). Copy your text, reload, and apply it again.`
        : 'Your branch changed while saving. Reload and try again.';
    return this.locks.run(branch.branch, async () => {
      const head = await this.workingHead(rc, branch);
      if (input.expectSha !== undefined && files.length === 1) {
        const current = await this.readFile(rc, head, files[0]!.path);
        if (
          (current?.sha ?? null) !== (input.expectSha || null) &&
          current?.text !== files[0]!.content
        ) {
          throw new EditorError(409, staleMessage, { stale: true });
        }
      }
      const summary = input.message?.trim() || `Update ${files.map((f) => f.path).join(', ')}`;
      const headline = summary.split('\n')[0]!.slice(0, 120);
      let sha: string;
      if (mode.user) {
        sha = await this.commitAs(
          mode.user,
          branch,
          head,
          { headline, body: 'Saved in the OpenD web editor.' },
          files.map((f) => ({ path: rc.docsPrefix + f.path, content: f.content })),
          staleMessage,
        );
      } else {
        const { tree } = await this.commitTree(rc, head);
        const changes: TreeChange[] = [];
        for (const f of files)
          changes.push({
            path: rc.docsPrefix + f.path,
            sha: await mode.writer.createBlob(f.content),
          });
        const newTree = await mode.writer.createTree(tree, changes);
        sha = await mode.writer.createCommit({
          message: `${headline}\n\nSaved in the OpenD web editor.\n\n${coAuthorTrailer(actor.user)}`,
          tree: newTree,
          parents: [head],
          author: authorOf(actor.user),
        });
        if (!(await mode.writer.updateBranch(branch.branch, sha)))
          throw new EditorError(409, 'The branch moved while saving; try again.');
      }
      await updateEditorBranch(this.pool, branch.id, { headSha: sha });
      await this.audit(rc, actor, 'save', {
        branch: branch.branch,
        commitSha: sha,
        prNumber: branch.prNumber,
        detail: { files: files.map((f) => f.path), via: mode.via },
      });
      const sync = await this.syncWith(rc, actor, branch, mode);
      const draft = await this.build(rc, sync.sha ?? sha);
      return { branch, sha: sync.sha ?? sha, sync, diagnostics: draft.diagnostics };
    });
  }

  // ---- merge from the base branch --------------------------------------------

  /**
   * Merges the base branch into the author's branch (never a rebase). Authors
   * who may not write (signed commits required, no token) only get the state.
   */
  sync(rc: RepoContext, actor: Actor, branch: EditorBranch): Promise<SyncResult> {
    return this.locks.run(branch.branch, async () => {
      const mode = await this.mode(rc, actor, branch, false);
      if (mode.via === 'blocked') return this.mergeState(rc, branch);
      return this.syncWith(rc, actor, branch, mode);
    });
  }

  private syncWith(
    rc: RepoContext,
    actor: Actor,
    branch: EditorBranch,
    mode: WriteMode,
  ): Promise<SyncResult> {
    return mode.signedFlow
      ? this.syncSigned(rc, actor, branch, mode)
      : this.syncLocked(rc, actor, branch, mode.writer);
  }

  /** Where the branch stands against the base branch, without writing anything. */
  private async mergeState(rc: RepoContext, branch: EditorBranch): Promise<SyncResult> {
    const { behindBy } = await rc.gh.compare(rc.baseBranch, branch.branch);
    if (behindBy === 0) return { status: 'up-to-date' };
    const set = await this.conflicts(rc, branch);
    return { status: set.conflicts.length || set.structural.length ? 'conflict' : 'behind' };
  }

  /**
   * The signed flow: GitHub merges the base branch in (update-branch), which
   * needs the branch's pull request. Before there is one, the branch simply
   * stays behind; publishing merges it.
   */
  private async syncSigned(
    rc: RepoContext,
    actor: Actor,
    branch: EditorBranch,
    mode: WriteMode,
  ): Promise<SyncResult> {
    const state = await this.mergeState(rc, branch);
    if (state.status !== 'behind') return state;
    const pull = await this.openPull(rc, branch);
    if (!pull) return state;
    const set = await this.conflicts(rc, branch);
    const sha = await this.signedMerge(rc, actor, branch, mode, set, [], pull);
    return { status: 'merged', sha };
  }

  private async syncLocked(
    rc: RepoContext,
    actor: Actor,
    branch: EditorBranch,
    writer: GitHubClient,
  ): Promise<SyncResult> {
    const result = await writer.merge(
      branch.branch,
      rc.baseBranch,
      `Merge ${rc.baseBranch} into ${branch.branch}`,
    );
    if (result.status === 'up-to-date') return { status: 'up-to-date' };
    if (result.status === 'merged') {
      await updateEditorBranch(this.pool, branch.id, { headSha: result.sha });
      await this.audit(rc, actor, 'sync', {
        branch: branch.branch,
        commitSha: result.sha,
        prNumber: branch.prNumber,
      });
      return { status: 'merged', sha: result.sha };
    }
    // GitHub's merge refused. Files that only look conflicting at file level
    // may still merge line by line; if everything does, commit that merge.
    const set = await this.conflicts(rc, branch);
    if (set.conflicts.length === 0 && set.structural.length === 0) {
      const sha = await this.commitMerge(
        rc,
        actor,
        branch,
        writer,
        set,
        [],
        'Merged automatically',
      );
      return { status: 'merged', sha };
    }
    return { status: 'conflict' };
  }

  /** Works out, file by file, how the author's branch and the base branch differ from their merge base. */
  async conflicts(rc: RepoContext, branch: EditorBranch): Promise<ConflictSet> {
    const [oursSha, theirsSha] = await Promise.all([
      this.workingHead(rc, branch),
      this.workingHead(rc, null),
    ]);
    const { mergeBase } = await rc.gh.compare(theirsSha, oursSha);
    const files = async (sha: string) =>
      new Map((await this.commitTree(rc, sha)).entries.map((e) => [e.path, e.sha]));
    const [base, ours, theirs] = await Promise.all([
      files(mergeBase),
      files(oursSha),
      files(theirsSha),
    ]);
    const set: ConflictSet = {
      oursSha,
      theirsSha,
      baseSha: mergeBase,
      automatic: [],
      conflicts: [],
      structural: [],
    };
    const text = async (sha: string | undefined) =>
      sha ? (await this.blob(rc, sha)).toString('utf8') : null;
    for (const path of [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort()) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      if (o === t || o === b) continue; // already as on main
      if (t === b) {
        set.automatic.push({ path, sha: o ?? null });
        continue;
      }
      if (o === undefined) {
        set.structural.push({
          path,
          reason: 'You deleted this file, but it was changed on the main branch.',
        });
        continue;
      }
      if (t === undefined) {
        set.structural.push({
          path,
          reason: 'This file was removed on the main branch after you changed it.',
        });
        continue;
      }
      if (!isTextFile(path)) {
        set.structural.push({
          path,
          reason: 'This file is not text and was changed on both sides.',
        });
        continue;
      }
      const [bt, ot, tt] = await Promise.all([text(b), text(o), text(t)]);
      const merged = merge3(bt ?? '', ot!, tt!);
      if (merged.clean) {
        set.automatic.push({ path, content: merged.text, theirs: tt! });
        continue;
      }
      if (bt !== null) {
        // A section the author still has was deleted on main: not a choice between two texts.
        const theirsIds = elementIds(tt!);
        const oursIds = elementIds(ot!);
        const removed = [...elementIds(bt)].filter((id) => oursIds.has(id) && !theirsIds.has(id));
        if (removed.length) {
          set.structural.push({
            path,
            reason: `Sections you edited were deleted on the main branch (${removed.join(', ')}).`,
          });
          continue;
        }
      }
      set.conflicts.push({ path, base: bt, mine: ot!, theirs: tt!, merged: merged.text });
    }
    return set;
  }

  /** Commits a merge of the base branch into the author's branch with the given resolutions. */
  private async commitMerge(
    rc: RepoContext,
    actor: Actor,
    branch: EditorBranch,
    writer: GitHubClient,
    set: ConflictSet,
    choices: Choice[],
    note: string,
  ): Promise<string> {
    const changes: TreeChange[] = [];
    for (const a of set.automatic) {
      if (a.content !== undefined)
        changes.push({ path: a.path, sha: await writer.createBlob(a.content) });
      else changes.push({ path: a.path, sha: a.sha ?? null });
    }
    for (const c of choices) {
      const conflict = set.conflicts.find((x) => x.path === c.path)!;
      if (c.take === 'theirs') continue;
      const content = c.take === 'mine' ? conflict.mine : c.content;
      changes.push({ path: c.path, sha: await writer.createBlob(content) });
    }
    const { tree: theirsTree } = await this.commitTree(rc, set.theirsSha);
    const tree = changes.length ? await writer.createTree(theirsTree, changes) : theirsTree;
    const resolved = choices.map((c) => `- ${c.path}: ${describeChoice(c)}`);
    const sha = await writer.createCommit({
      message: `Merge ${rc.baseBranch} into ${branch.branch}\n\n${note}${resolved.length ? `:\n${resolved.join('\n')}` : '.'}\n\n${coAuthorTrailer(actor.user)}`,
      tree,
      parents: [set.oursSha, set.theirsSha],
      author: authorOf(actor.user),
    });
    if (!(await writer.updateBranch(branch.branch, sha)))
      throw new EditorError(409, 'The branch moved while merging; reload and try again.');
    await updateEditorBranch(this.pool, branch.id, { headSha: sha });
    await this.audit(rc, actor, choices.length ? 'resolve' : 'sync', {
      branch: branch.branch,
      commitSha: sha,
      prNumber: branch.prNumber,
      detail: { resolved: choices.map((c) => ({ path: c.path, take: c.take })) },
    });
    return sha;
  }

  /**
   * Commits the author's per-file choices as the merge of the base branch.
   * Refused when either side moved since the choices were shown, or when a
   * structural conflict needs a developer.
   */
  resolve(
    rc: RepoContext,
    actor: Actor,
    branch: EditorBranch,
    input: { oursSha: string; theirsSha: string; choices: Choice[] },
  ): Promise<string> {
    return this.locks.run(branch.branch, async () => {
      const mode = await this.mode(rc, actor, branch, true);
      const set = await this.conflicts(rc, branch);
      if (set.oursSha !== input.oursSha || set.theirsSha !== input.theirsSha)
        throw new EditorError(
          409,
          'Something changed while you were choosing. Review the files again.',
          { stale: true },
        );
      if (set.structural.length)
        throw new EditorError(
          409,
          'These changes need a developer to resolve them in the pull request.',
        );
      const choices: Choice[] = [];
      for (const conflict of set.conflicts) {
        const choice = input.choices.find((c) => c.path === conflict.path);
        if (!choice) throw new EditorError(400, `Choose a version of ${conflict.path}.`);
        if (choice.take === 'manual') {
          const problems = isEditable(conflict.path)
            ? wellFormedness(conflict.path, choice.content)
            : [];
          if (problems.length)
            throw new EditorError(422, `Your edit of ${conflict.path} is not well-formed XML.`, {
              diagnostics: problems,
            });
        }
        choices.push(choice);
      }
      if (mode.signedFlow) {
        // GitHub's update-branch works on a pull request: open a draft one if there is none yet.
        const pull =
          (await this.openPull(rc, branch)) ??
          (
            await this.upsertPull(rc, actor, branch, mode, {
              draft: true,
              note: `Draft opened by the OpenD web editor so GitHub can merge ${rc.baseBranch} into this branch. ${authorOf(actor.user).name} publishes it from the editor.`,
            })
          ).pull;
        return this.signedMerge(rc, actor, branch, mode, set, choices, pull);
      }
      return this.commitMerge(
        rc,
        actor,
        branch,
        mode.writer,
        set,
        choices,
        'Conflicts resolved in the OpenD web editor',
      );
    });
  }

  // ---- publish -------------------------------------------------------------

  private pullBody(
    rc: RepoContext,
    user: EditorUser,
    branch: EditorBranch,
    files: string[],
    note?: string,
  ): string {
    const a = authorOf(user);
    const list = files.length ? files.map((f) => `- \`${f}\``).join('\n') : '- (no file changes)';
    return [
      `Docs changes by **${a.name}** (${a.email}), made in the OpenD web editor.`,
      '',
      `Working branch: \`${branch.branch}\` (editor user ${user.id}).`,
      ...(note ? ['', `> ${note}`] : []),
      '',
      'Files changed:',
      list,
      '',
      coAuthorTrailer(user),
    ].join('\n');
  }

  /** Opens the branch's pull request, or updates the open one. */
  private async upsertPull(
    rc: RepoContext,
    actor: Actor,
    branch: EditorBranch,
    mode: WriteMode,
    options: { note?: string; draft?: boolean } = {},
  ): Promise<{ pull: PullRequest; created: boolean; files: string[] }> {
    const comparison = await rc.gh.compare(rc.baseBranch, branch.branch);
    const files = comparison.files.map((f) => f.path);
    if (comparison.aheadBy === 0 || files.length === 0)
      throw new EditorError(400, 'There is nothing to publish yet: your branch has no changes.');
    const title = `Docs: changes by ${authorOf(actor.user).name}`;
    const body = this.pullBody(rc, actor.user, branch, files, options.note);
    let pull =
      (branch.prNumber !== null ? await rc.gh.getPull(branch.prNumber) : null) ??
      (await rc.gh.findOpenPull(branch.branch, rc.baseBranch));
    if (pull && pull.state !== 'open') pull = null;
    let created = false;
    if (pull) {
      await mode.writer.updatePull(pull.number, { title, body });
    } else {
      pull = await mode.writer.createPull({
        title,
        body,
        head: branch.branch,
        base: rc.baseBranch,
        ...(options.draft ? { draft: true } : {}),
      });
      created = true;
    }
    if (branch.prNumber !== pull.number) {
      await updateEditorBranch(this.pool, branch.id, { prNumber: pull.number });
      branch.prNumber = pull.number;
    }
    return { pull, created, files };
  }

  /** The base branch's rules and the pull request's reviews and checks: what publishing still needs. */
  async reviewState(
    rc: RepoContext,
    branch: EditorBranch | null,
  ): Promise<{ pull: PullRequest | null; review: ReviewState }> {
    const requirements = await readRequirements(rc.gh, rc.baseBranch);
    const pull = branch?.prNumber ? await rc.gh.getPull(branch.prNumber) : null;
    const open = pull && pull.state === 'open' ? pull : null;
    const [reviews, checks] = open
      ? await Promise.all([rc.gh.listReviews(open.number), rc.gh.commitChecks(open.headSha)])
      : [[], []];
    return { pull: open, review: evaluateReview(requirements, open, reviews, checks) };
  }

  /**
   * Publishes everything saved on the branch: one pull request, merged at once
   * (squash, crediting the author) when the base branch's rules allow it.
   * GitHub makes and signs the squash commit.
   */
  publish(rc: RepoContext, actor: Actor, branch: EditorBranch): Promise<PublishOutcome> {
    return this.locks.run(branch.branch, async () => {
      const mode = await this.mode(rc, actor, branch, true);
      // The signed flow merges main in through the pull request, once it exists.
      const sync = mode.signedFlow
        ? await this.mergeState(rc, branch)
        : await this.syncLocked(rc, actor, branch, mode.writer);
      if (sync.status === 'conflict')
        throw new EditorError(
          409,
          `The ${rc.baseBranch} branch has changes that conflict with yours. Resolve them first.`,
          {
            conflicts: true,
          },
        );
      let head = await this.workingHead(rc, branch);
      const draft = await this.build(rc, head);
      if (hasErrors(draft.diagnostics))
        throw new EditorError(422, 'Fix the validation errors before publishing.', {
          diagnostics: draft.diagnostics.filter((d) => d.severity === 'error'),
        });
      const { pull, created, files } = await this.upsertPull(rc, actor, branch, mode);
      if (pull.draft && mode.user) await mode.user.markReadyForReview(pull);
      if (mode.signedFlow && sync.status === 'behind')
        head = await this.signedMerge(
          rc,
          actor,
          branch,
          mode,
          await this.conflicts(rc, branch),
          [],
          pull,
        );
      await this.audit(rc, actor, 'publish', {
        branch: branch.branch,
        commitSha: head,
        prNumber: pull.number,
        detail: { created, files, via: mode.via },
      });
      const { pull: fresh, review } = await this.reviewState(rc, branch);
      const outcome: PublishOutcome = { pull: fresh ?? pull, created, merged: false, review };
      if (!review.canMerge) return outcome;
      const result = await mode.writer.mergePull(pull.number, {
        title: `${pull.title} (#${pull.number})`,
        message: `${files.map((f) => `* ${f}`).join('\n')}\n\n${coAuthorTrailer(actor.user)}`,
        sha: head,
      });
      if (!result.merged) {
        outcome.mergeError = result.reason;
        return outcome;
      }
      await updateEditorBranch(this.pool, branch.id, { status: 'merged' });
      await this.audit(rc, actor, 'merge', {
        branch: branch.branch,
        commitSha: result.sha,
        prNumber: pull.number,
        detail: { method: 'squash', via: mode.via },
      });
      return { ...outcome, merged: true, mergeSha: result.sha };
    });
  }

  /** Opens (or updates) the pull request for a developer to resolve what the editor cannot. */
  escalate(rc: RepoContext, actor: Actor, branch: EditorBranch): Promise<PullRequest> {
    return this.locks.run(branch.branch, async () => {
      const mode = await this.mode(rc, actor, branch, true);
      const set = await this.conflicts(rc, branch);
      const note = `Needs a developer: merging ${rc.baseBranch} into this branch conflicts in ${[
        ...set.structural.map((s) => s.path),
        ...set.conflicts.map((c) => c.path),
      ].join(', ')}.`;
      const { pull } = await this.upsertPull(rc, actor, branch, mode, { note });
      if (pull.draft && mode.user) await mode.user.markReadyForReview(pull);
      await this.audit(rc, actor, 'escalate', {
        branch: branch.branch,
        commitSha: set.oursSha,
        prNumber: pull.number,
        detail: { structural: set.structural },
      });
      return pull;
    });
  }
}

function describeChoice(c: Choice): string {
  return c.take === 'mine'
    ? 'your version'
    : c.take === 'theirs'
      ? 'current version'
      : 'edited by hand';
}
