import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';

export interface GitHubAppConfig {
  appId: string;
  /** PEM private key, PKCS#1 (as GitHub issues it) or PKCS#8. */
  privateKey: string;
  /** API base URL; set for GitHub Enterprise Server. */
  apiUrl?: string;
}

export type CommitState = 'pending' | 'success' | 'failure' | 'error';

/** Where build outcomes are reported. GitHub commit statuses in production. */
export interface StatusReporter {
  report(
    repo: { fullName: string; installationId: number | null },
    sha: string,
    state: CommitState,
    description: string,
  ): Promise<void>;
}

export const nullReporter: StatusReporter = { report: async () => {} };

/** Installation-token permissions: `read` for builds and polling, `write` for the editor. */
export type TokenPermission = 'read' | 'write';

/** What a token is minted for: a registered repository. */
export interface RepoRef {
  fullName: string;
  installationId: number | null;
  /** The clone URL; tokens are only ever sent to GitHub hosts (`gitHosts`). */
  sourceUrl?: string;
}

export interface GitHubResponse {
  status: number;
  /** Parsed JSON, the raw text when not JSON, or `null` when empty. */
  data: unknown;
}

/**
 * Access to repositories on GitHub as an installation: a local GitHub App
 * (`GitHubApp`), the managed-hosting token broker (`GitHubBroker`), or
 * whichever of them is configured right now (`GitHubConnection`).
 */
export interface GitHubAccess extends StatusReporter {
  /** Hosts git may send tokens to (see `gitAuthArgs`). */
  readonly gitHosts: readonly string[];
  /** An installation token for the repository, or `undefined` when it needs none. */
  repoToken(repo: RepoRef, permission: TokenPermission): Promise<string | undefined>;
  /**
   * Calls the REST API with a token for the repository. An error status is
   * returned, not thrown, so callers can act on 404, 409 or 422.
   */
  request(
    repo: RepoRef,
    method: string,
    path: string,
    body?: unknown,
    permission?: TokenPermission,
  ): Promise<GitHubResponse>;
}

/** `ghe.example/api/v3` → `ghe.example`, `api.github.com` → `github.com`. */
export function gitHostsFor(apiUrl?: string, webUrl?: string): readonly string[] {
  if (webUrl) return [new URL(webUrl).host];
  return [new URL(apiUrl ?? 'https://api.github.com').host.replace(/^api\./, '')];
}

/** Parses a response body: JSON, text, or `null` when empty. */
export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Minimal GitHub App client: installation tokens and commit statuses. */
export class GitHubApp implements GitHubAccess {
  private readonly key: KeyObject;
  readonly apiUrl: string;
  /**
   * Hosts that git may send this app's installation tokens to: `github.com`
   * for the public API, or the Enterprise host the API URL names
   * (`ghe.example/api/v3` → `ghe.example`, `api.acme.ghe.com` → `acme.ghe.com`).
   */
  readonly gitHosts: readonly string[];
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.key = createPrivateKey(config.privateKey.replace(/\\n/g, '\n'));
    this.apiUrl = (config.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.gitHosts = gitHostsFor(this.apiUrl);
  }

  get appId(): string {
    return this.config.appId;
  }

  private async appJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    // Backdated to allow for clock drift, and short-lived as GitHub requires.
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.config.appId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .sign(this.key);
  }

  private send(path: string, init: RequestInit & { token: string }): Promise<Response> {
    return this.fetchImpl(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${init.token}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
    });
  }

  private async api(path: string, init: RequestInit & { token: string }): Promise<Response> {
    const res = await this.send(path, init);
    if (!res.ok)
      throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} failed: ${res.status}`);
    return res;
  }

  /** An installation access token, cached until five minutes before it expires. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const res = await this.api(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      token: await this.appJwt(),
    });
    const body = (await res.json()) as { token: string; expires_at: string };
    this.tokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  /**
   * Calls the REST API as an installation. Unlike the other methods, an error
   * status is returned rather than thrown, so callers can act on 404, 409 or
   * 422. The body is parsed JSON, or `null` when empty.
   */
  async installationRequest(
    installationId: number,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GitHubResponse> {
    const init: RequestInit & { token: string } = {
      method,
      token: await this.installationToken(installationId),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.send(path, init);
    return { status: res.status, data: await readBody(res) };
  }

  /** Calls the REST API as the app itself (JWT), e.g. `GET /app/installations/:id`. */
  async appRequest(method: string, path: string): Promise<GitHubResponse> {
    const res = await this.send(path, { method, token: await this.appJwt() });
    return { status: res.status, data: await readBody(res) };
  }

  /** Repositories an installation can access, at most `limit`. */
  async installationRepos(
    installationId: number,
    limit = 300,
  ): Promise<{ fullName: string; private: boolean; defaultBranch: string }[]> {
    const out: { fullName: string; private: boolean; defaultBranch: string }[] = [];
    for (let page = 1; out.length < limit; page++) {
      const res = await this.installationRequest(
        installationId,
        'GET',
        `/installation/repositories?per_page=100&page=${page}`,
      );
      if (res.status !== 200) throw new Error(`GitHub repository list failed: ${res.status}`);
      const list = ((res.data as { repositories?: unknown[] } | null)?.repositories ?? []) as {
        full_name?: unknown;
        private?: unknown;
        default_branch?: unknown;
      }[];
      for (const r of list)
        if (typeof r.full_name === 'string')
          out.push({
            fullName: r.full_name,
            private: r.private === true,
            defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
          });
      if (list.length < 100) break;
    }
    return out.slice(0, limit);
  }

  async repoToken(repo: RepoRef): Promise<string | undefined> {
    return repo.installationId === null ? undefined : this.installationToken(repo.installationId);
  }

  async request(
    repo: RepoRef,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GitHubResponse> {
    if (repo.installationId === null)
      throw new Error(`${repo.fullName} has no GitHub App installation`);
    return this.installationRequest(repo.installationId, method, path, body);
  }

  async report(
    repo: { fullName: string; installationId: number | null },
    sha: string,
    state: CommitState,
    description: string,
  ): Promise<void> {
    if (repo.installationId === null) return;
    await this.api(`/repos/${repo.fullName}/statuses/${sha}`, {
      method: 'POST',
      token: await this.installationToken(repo.installationId),
      body: JSON.stringify({
        state,
        context: 'opend/build',
        // GitHub truncates nothing; it rejects descriptions over 140 characters.
        description: description.length > 140 ? `${description.slice(0, 139)}…` : description,
      }),
    });
  }
}
