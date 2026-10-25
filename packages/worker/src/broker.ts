import {
  gitHostsFor,
  readBody,
  type GitHubAccess,
  type GitHubResponse,
  type RepoRef,
  type TokenPermission,
} from './github.js';
import { onTokenHost } from './source.js';

export interface BrokerConfig {
  /** `OPEND_GITHUB_BROKER_URL`, e.g. `https://control.example/broker/v1`. */
  url: string;
  /** `OPEND_GITHUB_BROKER_SECRET`: this instance's bearer token. */
  secret: string;
  /** For GitHub Enterprise Server; default github.com. */
  apiUrl?: string;
  webUrl?: string;
}

/** A repository the tenant's installation can access, as `GET {broker}/repos` lists it. */
export interface BrokerRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
}

/** The site's custom domain as the control plane reports it (`GET {broker}/domain`). */
export interface BrokerDomain {
  domain: string | null;
  /** `none`, `attaching`, `awaiting-dns`, `live` or `error`. */
  status: BrokerDomainStatus;
  /** What to add at the DNS provider, each with whether it has propagated. */
  records: { type: string; name: string; value: string; propagated: boolean }[];
  /** ISO 8601, when the records were last checked. */
  checkedAt: string | null;
  /** The address the site keeps under the provider's domain. */
  defaultAddress: string | null;
  /** The site's address now: the custom domain once live. */
  publicUrl: string | null;
  available: boolean;
  unavailableReason: string | null;
  error: string | null;
}

export const BROKER_DOMAIN_STATUSES = [
  'none',
  'attaching',
  'awaiting-dns',
  'live',
  'error',
] as const;
export type BrokerDomainStatus = (typeof BROKER_DOMAIN_STATUSES)[number];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Reads a domain answer defensively: only known fields, the right types. */
function brokerDomain(body: unknown): BrokerDomain {
  const b = (body ?? {}) as Record<string, unknown>;
  const status = BROKER_DOMAIN_STATUSES.find((s) => s === b.status);
  if (!status) throw new BrokerError('the hosting provider returned no domain status', 502);
  return {
    domain: str(b.domain),
    status,
    records: (Array.isArray(b.records) ? (b.records as Record<string, unknown>[]) : [])
      .filter((r) => typeof r.name === 'string' && typeof r.value === 'string')
      .map((r) => ({
        type: str(r.type) ?? 'CNAME',
        name: r.name as string,
        value: r.value as string,
        propagated: r.propagated === true,
      })),
    checkedAt: str(b.checkedAt),
    defaultAddress: str(b.defaultAddress),
    publicUrl: str(b.publicUrl),
    available: b.available !== false,
    unavailableReason: str(b.unavailableReason),
    error: str(b.error),
  };
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Tokens are reused until this long before they expire. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Installation tokens from the managed-hosting token broker (see
 * docs/managed-github.md): the control plane owns the shared GitHub App and
 * mints tokens for the repositories in this tenant's installation.
 *
 * - `POST {url}/token` `{ repo, permissions }` → `{ token, expiresAt }`;
 *   404 when the repository is not in the installation, 401 for a bad secret.
 * - `GET {url}/repos` → `{ repos: [...] }`.
 * - `GET {url}/domain`, `PUT {url}/domain` `{ domain, actor? }` → the site's custom domain.
 */
export class GitHubBroker implements GitHubAccess {
  readonly gitHosts: readonly string[];
  private readonly url: string;
  private readonly apiUrl: string;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<string>>();
  private statusesNoted = false;

  constructor(
    private readonly config: BrokerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log?: (entry: Record<string, unknown>) => void,
  ) {
    this.url = config.url.replace(/\/+$/, '');
    this.apiUrl = (config.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.gitHosts = gitHostsFor(config.apiUrl, config.webUrl);
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${this.config.secret}`,
      'content-type': 'application/json',
    };
  }

  private refused(res: Response, what: string): BrokerError {
    if (res.status === 401)
      return new BrokerError(
        'the token broker refused this instance (OPEND_GITHUB_BROKER_SECRET)',
        401,
      );
    return new BrokerError(`token broker ${what} failed: ${res.status}`, res.status);
  }

  /** A token for `owner/name`, cached until 60 seconds before it expires. */
  async token(fullName: string, permission: TokenPermission): Promise<string> {
    const key = `${fullName.toLowerCase()}|${permission}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - Date.now() > EXPIRY_MARGIN_MS) return cached.token;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const fetching = (async () => {
      const res = await this.fetchImpl(`${this.url}/token`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ repo: fullName, permissions: permission }),
      });
      if (res.status === 404)
        throw new BrokerError(
          `${fullName} is not in this site's GitHub installation; install the app on it`,
          404,
        );
      if (!res.ok) throw this.refused(res, 'token request');
      const body = (await readBody(res)) as { token?: unknown; expiresAt?: unknown } | null;
      const expiresAt = typeof body?.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
      if (typeof body?.token !== 'string' || !body.token || Number.isNaN(expiresAt))
        throw new BrokerError('token broker returned no token', 502);
      this.tokens.set(key, { token: body.token, expiresAt });
      return body.token;
    })();
    this.pending.set(key, fetching);
    try {
      return await fetching;
    } finally {
      this.pending.delete(key);
    }
  }

  /** Repositories the tenant's installation can access. */
  async repos(): Promise<BrokerRepo[]> {
    const res = await this.fetchImpl(`${this.url}/repos`, { headers: this.headers() });
    if (!res.ok) throw this.refused(res, 'repository list');
    const body = (await readBody(res)) as { repos?: unknown } | null;
    if (!Array.isArray(body?.repos)) throw new BrokerError('token broker returned no repos', 502);
    return (body.repos as Record<string, unknown>[])
      .filter((r) => typeof r.fullName === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r.fullName))
      .map((r) => ({
        fullName: r.fullName as string,
        private: r.private === true,
        defaultBranch: typeof r.defaultBranch === 'string' ? r.defaultBranch : 'main',
        installationId: typeof r.installationId === 'number' ? r.installationId : 0,
      }));
  }

  /** The site's custom domain, its status and the DNS records to add. */
  async domain(): Promise<BrokerDomain> {
    const res = await this.fetchImpl(`${this.url}/domain`, { headers: this.headers() });
    if (!res.ok) throw await this.domainRefused(res);
    return brokerDomain(await readBody(res));
  }

  /**
   * Sets, changes or (null) removes the site's custom domain. `actor` is the staff
   * reader's email, for the provider's audit log; the broker secret authorizes.
   */
  async setDomain(domain: string | null, actor?: string): Promise<BrokerDomain> {
    const res = await this.fetchImpl(`${this.url}/domain`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ domain, ...(actor ? { actor } : {}) }),
    });
    if (!res.ok) throw await this.domainRefused(res);
    return brokerDomain(await readBody(res));
  }

  /** The provider's own message for a refused domain change (400, 409, 429), else the status. */
  private async domainRefused(res: Response): Promise<BrokerError> {
    const body = (await readBody(res).catch(() => null)) as { error?: unknown } | null;
    if ([400, 409, 429].includes(res.status) && typeof body?.error === 'string')
      return new BrokerError(body.error.slice(0, 300), res.status);
    return this.refused(res, 'domain request');
  }

  /**
   * The broker knows repositories by name, so the installation id is not
   * needed; a repository cloned from anywhere but a GitHub host gets no token.
   */
  async repoToken(repo: RepoRef, permission: TokenPermission): Promise<string | undefined> {
    if (repo.sourceUrl !== undefined && !onTokenHost(repo.sourceUrl, this.gitHosts))
      return undefined;
    return this.token(repo.fullName, permission);
  }

  async request(
    repo: RepoRef,
    method: string,
    path: string,
    body?: unknown,
    permission: TokenPermission = 'read',
  ): Promise<GitHubResponse> {
    const token = await this.token(repo.fullName, permission);
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
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, init);
    return { status: res.status, data: await readBody(res) };
  }

  /**
   * Broker tokens carry contents, pull requests and metadata only, not commit
   * statuses, so builds report no `opend/build` status in broker mode. Said
   * once in the log rather than failing every build.
   */
  async report(): Promise<void> {
    if (this.statusesNoted) return;
    this.statusesNoted = true;
    this.log?.({
      level: 'info',
      msg: 'commit statuses are not posted in broker mode (broker tokens have no statuses permission)',
    });
  }
}
