/**
 * The GitHub operations the editor needs, scoped to one repository. The
 * production implementation (`RestGitHubClient`) calls the REST API as the
 * GitHub App installation; tests run it against `FakeGitHub`.
 */
export interface GitHubClient {
  readonly fullName: string;
  /** Head commit of a branch, or `null` when the branch does not exist. */
  branchSha(branch: string): Promise<string | null>;
  createBranch(branch: string, sha: string): Promise<void>;
  /** Fast-forwards a branch. Returns false when `sha` does not descend from the branch head. */
  updateBranch(branch: string, sha: string): Promise<boolean>;
  getCommit(sha: string): Promise<GitCommit>;
  /** Every file (blob) in a tree, recursively. */
  getTree(treeSha: string): Promise<TreeEntry[]>;
  getBlob(sha: string): Promise<Buffer>;
  createBlob(content: string): Promise<string>;
  /** A new tree from `baseTree` with the given files replaced, added or (sha `null`) deleted. */
  createTree(baseTree: string, changes: TreeChange[]): Promise<string>;
  createCommit(input: NewCommit): Promise<string>;
  /** Merges `head` into the branch `base` (POST /merges): never a rebase or force push. */
  merge(base: string, head: string, message: string): Promise<MergeResult>;
  /** Compares two commits or branches (`base...head`). */
  compare(base: string, head: string): Promise<Comparison>;
  findOpenPull(head: string, base: string): Promise<PullRequest | null>;
  getPull(number: number): Promise<PullRequest | null>;
  createPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<PullRequest>;
  updatePull(number: number, input: { title?: string; body?: string }): Promise<void>;
  listReviews(number: number): Promise<Review[]>;
  /** Squash-merges a pull request at exactly `sha`. */
  mergePull(number: number, input: SquashMerge): Promise<PullMergeResult>;
  /**
   * Merges the base branch into a pull request's branch on GitHub
   * (`PUT /pulls/{n}/update-branch`, the "Update branch" button), which GitHub
   * signs. Asynchronous: GitHub accepts it, then moves the branch.
   */
  updatePullBranch(number: number, expectedHeadSha: string): Promise<UpdateBranchResult>;
  /** Classic branch protection on a branch. */
  branchProtection(branch: string): Promise<RulesLookup<ProtectionRules>>;
  /** Whether classic branch protection requires signed commits on a branch. */
  requiredSignatures(branch: string): Promise<RulesLookup<boolean>>;
  /** Repository rulesets that apply to a branch. */
  branchRulesets(branch: string): Promise<RulesLookup<ProtectionRules>>;
  /** Commit statuses and check runs on a commit, one entry per context, latest wins. */
  commitChecks(sha: string): Promise<CheckResult[]>;
  /** A GitHub user's permission on the repository. */
  collaboratorPermission(login: string): Promise<Permission>;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: GitIdentity;
}

export interface TreeEntry {
  path: string;
  mode: string;
  sha: string;
}

export interface TreeChange {
  path: string;
  /** Blob sha, or `null` to delete the file. */
  sha: string | null;
  mode?: string;
}

/**
 * The GitHub operations made with an author's own GitHub user access token:
 * commits through GraphQL `createCommitOnBranch`, which GitHub authors as the
 * token's user and signs ("Verified").
 */
export interface UserGitHubClient extends GitHubClient {
  /** The GitHub login the token belongs to. */
  readonly login: string;
  /** Appends one commit to `branch`, only if its head is still `expectedHeadOid`. */
  commitOnBranch(input: BranchCommit): Promise<BranchCommitResult>;
  /** Marks a draft pull request ready for review. */
  markReadyForReview(pull: PullRequest): Promise<void>;
}

export interface BranchCommit {
  branch: string;
  expectedHeadOid: string;
  headline: string;
  body?: string;
  /** Files to add or replace, as text. */
  additions: { path: string; content: string }[];
  deletions: string[];
}

/** `stale`: the branch head was no longer `expectedHeadOid`. */
export type BranchCommitResult = { status: 'committed'; sha: string } | { status: 'stale' };

export type UpdateBranchResult =
  | { status: 'accepted' }
  /** GitHub cannot merge the base branch in without conflicts. */
  | { status: 'conflict'; message: string }
  /** The branch head moved, or there is nothing to merge. */
  | { status: 'refused'; message: string };

export interface NewCommit {
  message: string;
  tree: string;
  parents: string[];
  author: GitIdentity;
}

export type MergeResult =
  { status: 'merged'; sha: string } | { status: 'up-to-date' } | { status: 'conflict' };

export interface Comparison {
  mergeBase: string;
  aheadBy: number;
  behindBy: number;
  files: { path: string; status: string }[];
}

export interface PullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  /** `null` while GitHub is still computing it. */
  mergeable: boolean | null;
  draft: boolean;
  /** GraphQL node id. */
  nodeId: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  title: string;
  body: string;
}

export interface Review {
  user: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt: string | null;
}

export interface SquashMerge {
  title: string;
  message: string;
  sha: string;
}

export type PullMergeResult = { merged: true; sha: string } | { merged: false; reason: string };

export interface ProtectionRules {
  requiredApprovals: number;
  codeOwnerReview: boolean;
  requiredChecks: string[];
  /** Commits must carry verified signatures (`required_signatures`). */
  requiredSignatures: boolean;
}

/** Rules are readable (`ok`), absent (`none`, a 404), or hidden from the app (`forbidden`, a 403). */
export type RulesLookup<T> =
  { status: 'ok'; rules: T } | { status: 'none' } | { status: 'forbidden' };

export interface CheckResult {
  context: string;
  state: 'success' | 'pending' | 'failure';
}

export type Permission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

/** An unexpected GitHub API response. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
