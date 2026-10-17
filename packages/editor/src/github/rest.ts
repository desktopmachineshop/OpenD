import type { GitHubAccess, RepoRef } from '@opend/worker';
import {
  GitHubError,
  type CheckResult,
  type Comparison,
  type GitCommit,
  type GitHubClient,
  type MergeResult,
  type NewCommit,
  type Permission,
  type ProtectionRules,
  type PullMergeResult,
  type PullRequest,
  type Review,
  type RulesLookup,
  type SquashMerge,
  type TreeChange,
  type TreeEntry,
  type UpdateBranchResult,
} from './client.js';

type Json = Record<string, unknown>;

const enc = encodeURIComponent;
/** A branch in a URL path: GitHub takes slashes in branch names unescaped. */
const branchPath = (branch: string) => branch.split('/').map(enc).join('/');

function asPull(data: Json): PullRequest {
  const head = data.head as Json;
  const base = data.base as Json;
  return {
    number: data.number as number,
    url: data.html_url as string,
    state: data.state === 'open' ? 'open' : 'closed',
    merged: data.merged === true || typeof data.merged_at === 'string',
    mergeable: typeof data.mergeable === 'boolean' ? data.mergeable : null,
    draft: data.draft === true,
    nodeId: (data.node_id as string | undefined) ?? '',
    headSha: head.sha as string,
    headRef: head.ref as string,
    baseRef: base.ref as string,
    title: (data.title as string) ?? '',
    body: (data.body as string | null) ?? '',
  };
}

/**
 * The editor's GitHub operations over the REST API, with a `write`
 * installation token (from the GitHub App, or the managed-hosting broker).
 */
export class RestGitHubClient implements GitHubClient {
  readonly fullName: string;

  constructor(
    protected readonly github: Pick<GitHubAccess, 'request'>,
    protected readonly repo: RepoRef,
  ) {
    this.fullName = repo.fullName;
  }

  /** The error for an unexpected status. Subclasses turn some into messages for the author. */
  protected failure(method: string, path: string, status: number, message: string): Error {
    return new GitHubError(
      `GitHub ${method} ${path.split('?')[0]} failed: ${status}${message ? ` ${message}` : ''}`,
      status,
    );
  }

  protected async call(method: string, path: string, body?: unknown, ok: number[] = [200, 201]) {
    const res = await this.github.request(
      this.repo,
      method,
      `/repos/${this.fullName}${path}`,
      body,
      'write',
    );
    if (!ok.includes(res.status)) {
      const message =
        res.data && typeof res.data === 'object' && 'message' in res.data
          ? String((res.data as Json).message)
          : '';
      throw this.failure(method, path, res.status, message);
    }
    return res;
  }

  async branchSha(branch: string): Promise<string | null> {
    const res = await this.call(
      'GET',
      `/git/ref/heads/${branchPath(branch)}`,
      undefined,
      [200, 404],
    );
    if (res.status === 404) return null;
    return ((res.data as Json).object as Json).sha as string;
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    await this.call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
  }

  async updateBranch(branch: string, sha: string): Promise<boolean> {
    const res = await this.call(
      'PATCH',
      `/git/refs/heads/${branchPath(branch)}`,
      { sha, force: false },
      [200, 422],
    );
    return res.status === 200;
  }

  async getCommit(sha: string): Promise<GitCommit> {
    const data = (await this.call('GET', `/git/commits/${enc(sha)}`)).data as Json;
    const author = data.author as Json;
    return {
      sha: data.sha as string,
      tree: (data.tree as Json).sha as string,
      parents: (data.parents as Json[]).map((p) => p.sha as string),
      message: data.message as string,
      author: { name: author.name as string, email: author.email as string },
    };
  }

  async getTree(treeSha: string): Promise<TreeEntry[]> {
    const data = (await this.call('GET', `/git/trees/${enc(treeSha)}?recursive=1`)).data as Json;
    if (data.truncated) throw new Error('repository tree is too large to edit in the browser');
    return (data.tree as Json[])
      .filter((e) => e.type === 'blob')
      .map((e) => ({ path: e.path as string, mode: e.mode as string, sha: e.sha as string }));
  }

  async getBlob(sha: string): Promise<Buffer> {
    const data = (await this.call('GET', `/git/blobs/${enc(sha)}`)).data as Json;
    return Buffer.from(data.content as string, data.encoding === 'base64' ? 'base64' : 'utf8');
  }

  async createBlob(content: string): Promise<string> {
    const res = await this.call('POST', '/git/blobs', { content, encoding: 'utf-8' });
    return (res.data as Json).sha as string;
  }

  async createTree(baseTree: string, changes: TreeChange[]): Promise<string> {
    const res = await this.call('POST', '/git/trees', {
      base_tree: baseTree,
      tree: changes.map((c) => ({
        path: c.path,
        mode: c.mode ?? '100644',
        type: 'blob',
        sha: c.sha,
      })),
    });
    return (res.data as Json).sha as string;
  }

  async createCommit(input: NewCommit): Promise<string> {
    const res = await this.call('POST', '/git/commits', {
      message: input.message,
      tree: input.tree,
      parents: input.parents,
      author: input.author,
    });
    return (res.data as Json).sha as string;
  }

  async merge(base: string, head: string, message: string): Promise<MergeResult> {
    const res = await this.call(
      'POST',
      '/merges',
      { base, head, commit_message: message },
      [201, 204, 409],
    );
    if (res.status === 204) return { status: 'up-to-date' };
    if (res.status === 409) return { status: 'conflict' };
    return { status: 'merged', sha: (res.data as Json).sha as string };
  }

  async compare(base: string, head: string): Promise<Comparison> {
    const data = (await this.call('GET', `/compare/${enc(base)}...${enc(head)}`)).data as Json;
    return {
      mergeBase: (data.merge_base_commit as Json).sha as string,
      aheadBy: data.ahead_by as number,
      behindBy: data.behind_by as number,
      files: ((data.files as Json[] | undefined) ?? []).map((f) => ({
        path: f.filename as string,
        status: f.status as string,
      })),
    };
  }

  async findOpenPull(head: string, base: string): Promise<PullRequest | null> {
    const owner = this.fullName.split('/')[0]!;
    const data = (
      await this.call('GET', `/pulls?state=open&head=${enc(`${owner}:${head}`)}&base=${enc(base)}`)
    ).data as Json[];
    return data[0] ? asPull(data[0]) : null;
  }

  async getPull(number: number): Promise<PullRequest | null> {
    const res = await this.call('GET', `/pulls/${number}`, undefined, [200, 404]);
    return res.status === 404 ? null : asPull(res.data as Json);
  }

  async createPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<PullRequest> {
    return asPull((await this.call('POST', '/pulls', input)).data as Json);
  }

  async updatePull(number: number, input: { title?: string; body?: string }): Promise<void> {
    await this.call('PATCH', `/pulls/${number}`, input);
  }

  async listReviews(number: number): Promise<Review[]> {
    const data = (await this.call('GET', `/pulls/${number}/reviews?per_page=100`)).data as Json[];
    return data.map((r) => ({
      user: ((r.user as Json | null)?.login as string) ?? 'unknown',
      state: r.state as Review['state'],
      submittedAt: (r.submitted_at as string | null) ?? null,
    }));
  }

  async mergePull(number: number, input: SquashMerge): Promise<PullMergeResult> {
    const res = await this.call(
      'PUT',
      `/pulls/${number}/merge`,
      {
        merge_method: 'squash',
        commit_title: input.title,
        commit_message: input.message,
        sha: input.sha,
      },
      [200, 405, 409, 422],
    );
    const data = (res.data ?? {}) as Json;
    if (res.status === 200 && data.merged !== false)
      return { merged: true, sha: data.sha as string };
    return { merged: false, reason: String(data.message ?? `GitHub refused (${res.status})`) };
  }

  async updatePullBranch(number: number, expectedHeadSha: string): Promise<UpdateBranchResult> {
    const res = await this.call(
      'PUT',
      `/pulls/${number}/update-branch`,
      { expected_head_sha: expectedHeadSha },
      [202, 422],
    );
    if (res.status === 202) return { status: 'accepted' };
    const message = String(((res.data ?? {}) as Json).message ?? 'GitHub refused (422)');
    return /conflict/i.test(message)
      ? { status: 'conflict', message }
      : { status: 'refused', message };
  }

  async requiredSignatures(branch: string): Promise<RulesLookup<boolean>> {
    const res = await this.call(
      'GET',
      `/branches/${branchPath(branch)}/protection/required_signatures`,
      undefined,
      [200, 403, 404],
    );
    if (res.status === 404) return { status: 'none' };
    if (res.status === 403) return { status: 'forbidden' };
    return { status: 'ok', rules: (res.data as Json).enabled === true };
  }

  async branchProtection(branch: string): Promise<RulesLookup<ProtectionRules>> {
    const res = await this.call(
      'GET',
      `/branches/${branchPath(branch)}/protection`,
      undefined,
      [200, 403, 404],
    );
    if (res.status === 404) return { status: 'none' };
    if (res.status === 403) return { status: 'forbidden' };
    const data = res.data as Json;
    const reviews = data.required_pull_request_reviews as Json | undefined;
    const checks = data.required_status_checks as Json | undefined;
    const contexts = new Set<string>((checks?.contexts as string[] | undefined) ?? []);
    for (const c of (checks?.checks as Json[] | undefined) ?? []) contexts.add(c.context as string);
    return {
      status: 'ok',
      rules: {
        // Protection with a review rule but no count still requires one approval.
        requiredApprovals: reviews
          ? ((reviews.required_approving_review_count as number | undefined) ?? 1)
          : 0,
        codeOwnerReview: reviews?.require_code_owner_reviews === true,
        requiredChecks: [...contexts],
        requiredSignatures: (data.required_signatures as Json | undefined)?.enabled === true,
      },
    };
  }

  async branchRulesets(branch: string): Promise<RulesLookup<ProtectionRules>> {
    const res = await this.call(
      'GET',
      `/rules/branches/${branchPath(branch)}`,
      undefined,
      [200, 403, 404],
    );
    if (res.status === 404) return { status: 'none' };
    if (res.status === 403) return { status: 'forbidden' };
    return { status: 'ok', rules: rulesFromRulesets(res.data as Json[]) };
  }

  async commitChecks(sha: string): Promise<CheckResult[]> {
    const out = new Map<string, CheckResult['state']>();
    const status = (await this.call('GET', `/commits/${enc(sha)}/status`)).data as Json;
    for (const s of (status.statuses as Json[] | undefined) ?? []) {
      const context = s.context as string;
      // Statuses come newest first; keep the latest per context.
      if (out.has(context)) continue;
      const state = s.state as string;
      out.set(
        context,
        state === 'success' ? 'success' : state === 'pending' ? 'pending' : 'failure',
      );
    }
    const runs = (await this.call('GET', `/commits/${enc(sha)}/check-runs?per_page=100`))
      .data as Json;
    for (const r of (runs.check_runs as Json[] | undefined) ?? []) {
      const name = r.name as string;
      if (out.has(name)) continue;
      const conclusion = r.conclusion as string | null;
      out.set(
        name,
        r.status !== 'completed'
          ? 'pending'
          : conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped'
            ? 'success'
            : 'failure',
      );
    }
    return [...out].map(([context, state]) => ({ context, state }));
  }

  async collaboratorPermission(login: string): Promise<Permission> {
    const res = await this.call(
      'GET',
      `/collaborators/${enc(login)}/permission`,
      undefined,
      [200, 403, 404],
    );
    if (res.status !== 200) return 'none';
    const data = res.data as Json;
    const role = (data.role_name as string | undefined) ?? (data.permission as string);
    const roles: Permission[] = ['admin', 'maintain', 'write', 'triage', 'read'];
    // A custom role name falls back to its base permission (admin, write or read).
    return roles.find((p) => p === role) ?? roles.find((p) => p === data.permission) ?? 'none';
  }
}

/** Merges the rules of every ruleset that applies to a branch. */
export function rulesFromRulesets(rules: Json[]): ProtectionRules {
  const out: ProtectionRules = {
    requiredApprovals: 0,
    codeOwnerReview: false,
    requiredChecks: [],
    requiredSignatures: false,
  };
  for (const rule of rules) {
    const p = (rule.parameters as Json | undefined) ?? {};
    if (rule.type === 'pull_request') {
      out.requiredApprovals = Math.max(
        out.requiredApprovals,
        (p.required_approving_review_count as number | undefined) ?? 0,
      );
      if (p.require_code_owner_review === true) out.codeOwnerReview = true;
    } else if (rule.type === 'required_signatures') {
      out.requiredSignatures = true;
    } else if (rule.type === 'required_status_checks') {
      for (const c of (p.required_status_checks as Json[] | undefined) ?? []) {
        const context = c.context as string;
        if (!out.requiredChecks.includes(context)) out.requiredChecks.push(context);
      }
    }
  }
  return out;
}
