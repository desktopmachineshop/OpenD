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
import type {
  GitHubClient,
  GitIdentity,
  PullRequest,
  TreeChange,
  TreeEntry,
} from './github/client.js';
import { elementIds, hasConflictMarkers, merge3 } from './merge.js';
import { evaluateReview, readRequirements, type ReviewState } from './rules.js';

/** An error with an HTTP status and a message fit to show the author. */
export class EditorError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Who is acting: the signed-in editor and their session, both from the server side. */
export interface Actor {
  user: EditorUser;
  sessionId: string;
}

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
  status: 'up-to-date' | 'merged' | 'conflict';
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
  /** Files that merged on their own, relative to the current version of main. */
  automatic: { path: string; sha?: string | null; content?: string }[];
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

  constructor(private readonly pool: Pool) {}

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
  private async ensureBranch(rc: RepoContext, actor: Actor): Promise<EditorBranch> {
    const existing = await this.activeBranch(rc, actor.user);
    if (existing) return existing;
    const base = await this.workingHead(rc, null);
    const name = `editor/${actor.user.id}/${slugify(actor.user.name || actor.user.email.split('@')[0]!)}-${randomBytes(3).toString('hex')}`;
    await rc.gh.createBranch(name, base);
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

  // ---- save ----------------------------------------------------------------

  /**
   * Commits files to the author's branch (creating it if needed), then merges
   * the base branch in. The commit's author and trailer come from the
   * session's user, never from the request.
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
    const branch = input.branch
      ? await this.ownBranch(rc, actor.user, input.branch)
      : await this.ensureBranch(rc, actor);
    return this.locks.run(branch.branch, async () => {
      const head = await this.workingHead(rc, branch);
      if (input.expectSha !== undefined && files.length === 1) {
        const current = await this.readFile(rc, head, files[0]!.path);
        if (
          (current?.sha ?? null) !== (input.expectSha || null) &&
          current?.text !== files[0]!.content
        ) {
          throw new EditorError(
            409,
            `${files[0]!.path} changed since you opened it (another save or a merge from ${rc.baseBranch}). Copy your text, reload, and apply it again.`,
            { stale: true },
          );
        }
      }
      const { tree } = await this.commitTree(rc, head);
      const changes: TreeChange[] = [];
      for (const f of files)
        changes.push({ path: rc.docsPrefix + f.path, sha: await rc.gh.createBlob(f.content) });
      const newTree = await rc.gh.createTree(tree, changes);
      const summary = input.message?.trim() || `Update ${files.map((f) => f.path).join(', ')}`;
      const sha = await rc.gh.createCommit({
        message: `${summary.split('\n')[0]!.slice(0, 120)}\n\nSaved in the OpenD web editor.\n\n${coAuthorTrailer(actor.user)}`,
        tree: newTree,
        parents: [head],
        author: authorOf(actor.user),
      });
      if (!(await rc.gh.updateBranch(branch.branch, sha)))
        throw new EditorError(409, 'The branch moved while saving; try again.');
      await updateEditorBranch(this.pool, branch.id, { headSha: sha });
      await this.audit(rc, actor, 'save', {
        branch: branch.branch,
        commitSha: sha,
        prNumber: branch.prNumber,
        detail: { files: files.map((f) => f.path) },
      });
      const sync = await this.syncLocked(rc, actor, branch);
      const draft = await this.build(rc, sync.sha ?? sha);
      return { branch, sha: sync.sha ?? sha, sync, diagnostics: draft.diagnostics };
    });
  }

  // ---- merge from the base branch --------------------------------------------

  /** Merges the base branch into the author's branch (never a rebase). */
  sync(rc: RepoContext, actor: Actor, branch: EditorBranch): Promise<SyncResult> {
    return this.locks.run(branch.branch, () => this.syncLocked(rc, actor, branch));
  }

  private async syncLocked(
    rc: RepoContext,
    actor: Actor,
    branch: EditorBranch,
  ): Promise<SyncResult> {
    const result = await rc.gh.merge(
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
      const sha = await this.commitMerge(rc, actor, branch, set, [], 'Merged automatically');
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
        set.automatic.push({ path, content: merged.text });
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
    set: ConflictSet,
    choices: Choice[],
    note: string,
  ): Promise<string> {
    const changes: TreeChange[] = [];
    for (const a of set.automatic) {
      if (a.content !== undefined)
        changes.push({ path: a.path, sha: await rc.gh.createBlob(a.content) });
      else changes.push({ path: a.path, sha: a.sha ?? null });
    }
    for (const c of choices) {
      const conflict = set.conflicts.find((x) => x.path === c.path)!;
      if (c.take === 'theirs') continue;
      const content = c.take === 'mine' ? conflict.mine : c.content;
      changes.push({ path: c.path, sha: await rc.gh.createBlob(content) });
    }
    const { tree: theirsTree } = await this.commitTree(rc, set.theirsSha);
    const tree = changes.length ? await rc.gh.createTree(theirsTree, changes) : theirsTree;
    const resolved = choices.map(
      (c) =>
        `- ${c.path}: ${c.take === 'mine' ? 'your version' : c.take === 'theirs' ? 'current version' : 'edited by hand'}`,
    );
    const sha = await rc.gh.createCommit({
      message: `Merge ${rc.baseBranch} into ${branch.branch}\n\n${note}${resolved.length ? `:\n${resolved.join('\n')}` : '.'}\n\n${coAuthorTrailer(actor.user)}`,
      tree,
      parents: [set.oursSha, set.theirsSha],
      author: authorOf(actor.user),
    });
    if (!(await rc.gh.updateBranch(branch.branch, sha)))
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
      return this.commitMerge(
        rc,
        actor,
        branch,
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
    note?: string,
  ): Promise<{ pull: PullRequest; created: boolean; files: string[] }> {
    const comparison = await rc.gh.compare(rc.baseBranch, branch.branch);
    const files = comparison.files.map((f) => f.path);
    if (comparison.aheadBy === 0 || files.length === 0)
      throw new EditorError(400, 'There is nothing to publish yet: your branch has no changes.');
    const title = `Docs: changes by ${authorOf(actor.user).name}`;
    const body = this.pullBody(rc, actor.user, branch, files, note);
    let pull =
      (branch.prNumber !== null ? await rc.gh.getPull(branch.prNumber) : null) ??
      (await rc.gh.findOpenPull(branch.branch, rc.baseBranch));
    if (pull && pull.state !== 'open') pull = null;
    let created = false;
    if (pull) {
      await rc.gh.updatePull(pull.number, { title, body });
    } else {
      pull = await rc.gh.createPull({ title, body, head: branch.branch, base: rc.baseBranch });
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
   */
  publish(rc: RepoContext, actor: Actor, branch: EditorBranch): Promise<PublishOutcome> {
    return this.locks.run(branch.branch, async () => {
      const sync = await this.syncLocked(rc, actor, branch);
      if (sync.status === 'conflict')
        throw new EditorError(
          409,
          `The ${rc.baseBranch} branch has changes that conflict with yours. Resolve them first.`,
          {
            conflicts: true,
          },
        );
      const head = await this.workingHead(rc, branch);
      const draft = await this.build(rc, head);
      if (hasErrors(draft.diagnostics))
        throw new EditorError(422, 'Fix the validation errors before publishing.', {
          diagnostics: draft.diagnostics.filter((d) => d.severity === 'error'),
        });
      const { pull, created, files } = await this.upsertPull(rc, actor, branch);
      await this.audit(rc, actor, 'publish', {
        branch: branch.branch,
        commitSha: head,
        prNumber: pull.number,
        detail: { created, files },
      });
      const { pull: fresh, review } = await this.reviewState(rc, branch);
      const outcome: PublishOutcome = { pull: fresh ?? pull, created, merged: false, review };
      if (!review.canMerge) return outcome;
      const result = await rc.gh.mergePull(pull.number, {
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
        detail: { method: 'squash' },
      });
      return { ...outcome, merged: true, mergeSha: result.sha };
    });
  }

  /** Opens (or updates) the pull request for a developer to resolve what the editor cannot. */
  escalate(rc: RepoContext, actor: Actor, branch: EditorBranch): Promise<PullRequest> {
    return this.locks.run(branch.branch, async () => {
      const set = await this.conflicts(rc, branch);
      const note = `Needs a developer: merging ${rc.baseBranch} into this branch conflicts in ${[
        ...set.structural.map((s) => s.path),
        ...set.conflicts.map((c) => c.path),
      ].join(', ')}.`;
      const { pull } = await this.upsertPull(rc, actor, branch, note);
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
