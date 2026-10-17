import { readBody, type GitHubResponse, type RepoRef } from '@opend/worker';
import { EditorError } from '../errors.js';
import type { BranchCommit, BranchCommitResult, PullRequest, UserGitHubClient } from './client.js';
import { RestGitHubClient } from './rest.js';

/** Where an author's GitHub user access token comes from (the session's stored token). */
export interface UserTokenSource {
  readonly login: string;
  readonly githubId: number;
  /** A usable access token, refreshed first when it is about to expire. */
  token(): Promise<string>;
  /** GitHub refused the token (401): it was revoked or has expired for good. */
  revoked(): Promise<void>;
}

export const SIGN_IN_AGAIN =
  'Your GitHub sign-in has expired or was revoked. Sign in with GitHub again to save and publish.';

export function noWriteAccess(login: string, repo: string): string {
  return `GitHub does not let @${login} write to ${repo}. Ask a maintainer of the repository for write access, then try again.`;
}

/** `https://api.github.com` → `/graphql`; GitHub Enterprise `https://ghe/api/v3` → `https://ghe/api/graphql`. */
export function graphqlUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/$/, '');
  return /\/api\/v3$/.test(base) ? base.replace(/\/v3$/, '/graphql') : `${base}/graphql`;
}

const COMMIT_MUTATION = `mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

const READY_MUTATION = `mutation ($input: MarkPullRequestReadyForReviewInput!) {
  markPullRequestReadyForReview(input: $input) { pullRequest { isDraft } }
}`;

interface GraphQLError {
  type?: string;
  message?: string;
}

/**
 * The editor's GitHub operations with an author's own user access token
 * (GitHub App user-to-server token): the REST calls of `RestGitHubClient`
 * plus GraphQL `createCommitOnBranch`, whose commits GitHub authors as the
 * user and signs. The token can do only what both the user and the app may.
 */
export class RestUserGitHubClient extends RestGitHubClient implements UserGitHubClient {
  readonly login: string;

  constructor(
    private readonly source: UserTokenSource,
    repo: RepoRef,
    private readonly options: { apiUrl: string; fetch: typeof fetch },
  ) {
    const apiUrl = options.apiUrl.replace(/\/$/, '');
    const holder: { self?: RestUserGitHubClient } = {};
    super(
      {
        request: async (_repo, method, path, body) =>
          holder.self!.send(`${apiUrl}${path}`, method, body),
      },
      repo,
    );
    holder.self = this;
    this.login = source.login;
  }

  private async send(url: string, method: string, body?: unknown): Promise<GitHubResponse> {
    const token = await this.source.token();
    const init: RequestInit = {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.options.fetch(url, init);
    if (res.status === 401) {
      await this.source.revoked();
      throw new EditorError(401, SIGN_IN_AGAIN, { githubSignIn: true });
    }
    return { status: res.status, data: await readBody(res) };
  }

  protected override failure(method: string, path: string, status: number, message: string) {
    // The user (or the app on their behalf) may not write here.
    if (status === 403 || status === 404)
      return new EditorError(403, noWriteAccess(this.login, this.fullName), {
        noWriteAccess: true,
      });
    return super.failure(method, path, status, message);
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown> | null; errors: GraphQLError[] }> {
    const res = await this.send(graphqlUrl(this.options.apiUrl), 'POST', { query, variables });
    if (res.status !== 200) {
      if (res.status === 403 || res.status === 404)
        throw new EditorError(403, noWriteAccess(this.login, this.fullName), {
          noWriteAccess: true,
        });
      throw super.failure('POST', '/graphql', res.status, '');
    }
    const body = (res.data ?? {}) as { data?: Record<string, unknown> | null; errors?: unknown };
    return {
      data: body.data ?? null,
      errors: Array.isArray(body.errors) ? (body.errors as GraphQLError[]) : [],
    };
  }

  async commitOnBranch(input: BranchCommit): Promise<BranchCommitResult> {
    const { data, errors } = await this.graphql(COMMIT_MUTATION, {
      input: {
        branch: { repositoryNameWithOwner: this.fullName, branchName: input.branch },
        expectedHeadOid: input.expectedHeadOid,
        message: { headline: input.headline, ...(input.body ? { body: input.body } : {}) },
        fileChanges: {
          additions: input.additions.map((f) => ({
            path: f.path,
            contents: Buffer.from(f.content, 'utf8').toString('base64'),
          })),
          deletions: input.deletions.map((path) => ({ path })),
        },
      },
    });
    const oid = (
      (data?.createCommitOnBranch as { commit?: { oid?: unknown } } | null)?.commit ?? {}
    ).oid;
    if (typeof oid === 'string' && !errors.length) return { status: 'committed', sha: oid };
    const error = errors[0] ?? {};
    const message = error.message ?? '';
    if (error.type === 'STALE_DATA' || /expected branch to point to/i.test(message))
      return { status: 'stale' };
    if (
      error.type === 'FORBIDDEN' ||
      error.type === 'NOT_FOUND' ||
      /permission|not accessible|could not resolve/i.test(message)
    )
      throw new EditorError(403, noWriteAccess(this.login, this.fullName), {
        noWriteAccess: true,
      });
    throw super.failure('POST', '/graphql createCommitOnBranch', 200, message);
  }

  async markReadyForReview(pull: PullRequest): Promise<void> {
    if (!pull.draft) return;
    const { errors } = await this.graphql(READY_MUTATION, {
      input: { pullRequestId: pull.nodeId },
    });
    if (errors.length)
      throw super.failure(
        'POST',
        '/graphql markPullRequestReadyForReview',
        200,
        errors[0]!.message ?? '',
      );
  }
}
