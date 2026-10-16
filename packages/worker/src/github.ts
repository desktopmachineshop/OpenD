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

/** Minimal GitHub App client: installation tokens and commit statuses. */
export class GitHubApp implements StatusReporter {
  private readonly key: KeyObject;
  private readonly apiUrl: string;
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.key = createPrivateKey(config.privateKey.replace(/\\n/g, '\n'));
    this.apiUrl = (config.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
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

  private async api(path: string, init: RequestInit & { token: string }): Promise<Response> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${init.token}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
    });
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
