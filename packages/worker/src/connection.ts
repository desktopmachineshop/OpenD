import { createHash } from 'node:crypto';
import { BrokerError, GitHubBroker, type BrokerConfig } from './broker.js';
import {
  GitHubApp,
  gitHostsFor,
  type CommitState,
  type GitHubAccess,
  type GitHubAppConfig,
  type GitHubResponse,
  type RepoRef,
  type TokenPermission,
} from './github.js';

/** Where installation tokens come from right now. */
export type GitHubMode = 'env' | 'broker' | 'stored' | 'none';

export interface GitHubConnectionOptions {
  /** `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`: always wins. */
  app?: GitHubAppConfig | null;
  /** `OPEND_GITHUB_BROKER_URL` and `…_SECRET`: managed hosting. */
  broker?: BrokerConfig | null;
  /** The app stored by Connect GitHub, read on every use so a new connection applies at once. */
  stored?: () => GitHubAppConfig | null;
  apiUrl?: string;
  webUrl?: string;
  fetch?: typeof fetch;
}

/**
 * The GitHub access a process uses, decided per call: the GitHub App from the
 * environment, else the token broker, else the app stored through Connect
 * GitHub in the admin console, else none (public or local sources only).
 */
export class GitHubConnection implements GitHubAccess {
  private readonly envApp: GitHubApp | null;
  readonly broker: GitHubBroker | null;
  private storedApp: { key: string; app: GitHubApp } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubConnectionOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.envApp = options.app ? new GitHubApp(options.app, this.fetchImpl) : null;
    this.broker =
      !this.envApp && options.broker ? new GitHubBroker(options.broker, this.fetchImpl) : null;
  }

  mode(): GitHubMode {
    if (this.envApp) return 'env';
    if (this.broker) return 'broker';
    return this.stored() ? 'stored' : 'none';
  }

  private stored(): GitHubApp | null {
    if (this.envApp || this.broker) return null;
    const config = this.options.stored?.() ?? null;
    if (!config) {
      this.storedApp = null;
      return null;
    }
    const key = createHash('sha256')
      .update(`${config.appId}\n${config.apiUrl ?? ''}\n${config.privateKey}`)
      .digest('hex');
    if (this.storedApp?.key !== key) {
      try {
        this.storedApp = { key, app: new GitHubApp(config, this.fetchImpl) };
      } catch {
        // An unreadable private key behaves as "not connected" rather than failing every build.
        this.storedApp = null;
        return null;
      }
    }
    return this.storedApp.app;
  }

  /** The local GitHub App (from the environment or Connect GitHub), if any. */
  app(): GitHubApp | null {
    return this.envApp ?? this.stored();
  }

  private current(): GitHubAccess | null {
    return this.envApp ?? this.broker ?? this.stored();
  }

  get gitHosts(): readonly string[] {
    return this.current()?.gitHosts ?? gitHostsFor(this.options.apiUrl, this.options.webUrl);
  }

  async repoToken(repo: RepoRef, permission: TokenPermission): Promise<string | undefined> {
    return (await this.current()?.repoToken(repo, permission)) ?? undefined;
  }

  async request(
    repo: RepoRef,
    method: string,
    path: string,
    body?: unknown,
    permission: TokenPermission = 'read',
  ): Promise<GitHubResponse> {
    const current = this.current();
    if (!current) throw new BrokerError('GitHub is not connected', 503);
    return current.request(repo, method, path, body, permission);
  }

  async report(repo: RepoRef, sha: string, state: CommitState, description: string) {
    await this.current()?.report(repo, sha, state, description);
  }
}
