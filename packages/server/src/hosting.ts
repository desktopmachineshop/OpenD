import { readBody } from '@opend/worker';

/**
 * The managed host's site API (`OPEND_HOSTING_URL`, e.g. `https://opend.app/site/v1`), with
 * this site's own credential (`OPEND_HOSTING_TOKEN`). Independent of GitHub: every managed
 * site has it, whichever way it reaches its repositories. Self-hosted sites have none.
 *
 * - `GET {url}/domain`, `PUT {url}/domain` `{ domain, actor? }` → the site's custom domain.
 */
export interface HostingConfig {
  url: string;
  token: string;
}

export const HOSTING_DOMAIN_STATUSES = [
  'none',
  'attaching',
  'awaiting-dns',
  'live',
  'error',
] as const;
export type HostingDomainStatus = (typeof HOSTING_DOMAIN_STATUSES)[number];

/** The site's custom domain as the host reports it. */
export interface HostingDomain {
  domain: string | null;
  status: HostingDomainStatus;
  /** What to add at the DNS provider, each with whether it has propagated. */
  records: { type: string; name: string; value: string; propagated: boolean }[];
  /** ISO 8601, when the records were last checked. */
  checkedAt: string | null;
  /** The address the site keeps under the host's domain. */
  defaultAddress: string | null;
  /** The site's address now: the custom domain once live. */
  publicUrl: string | null;
  available: boolean;
  unavailableReason: string | null;
  error: string | null;
}

export class HostingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Reads a domain answer defensively: only known fields, the right types. */
function hostingDomain(body: unknown): HostingDomain {
  const b = (body ?? {}) as Record<string, unknown>;
  const status = HOSTING_DOMAIN_STATUSES.find((s) => s === b.status);
  if (!status) throw new HostingError('the hosting provider returned no domain status', 502);
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

export class HostingClient {
  private readonly url: string;

  constructor(
    private readonly config: HostingConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.url = config.url.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${this.config.token}`,
      'content-type': 'application/json',
    };
  }

  /** The site's custom domain, its status and the DNS records to add. */
  async domain(): Promise<HostingDomain> {
    const res = await this.fetchImpl(`${this.url}/domain`, { headers: this.headers() });
    if (!res.ok) throw await this.refused(res);
    return hostingDomain(await readBody(res));
  }

  /**
   * Sets, changes or (null) removes the site's custom domain. `actor` is the staff reader's
   * email, for the host's audit log; the site's credential authorizes.
   */
  async setDomain(domain: string | null, actor?: string): Promise<HostingDomain> {
    const res = await this.fetchImpl(`${this.url}/domain`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ domain, ...(actor ? { actor } : {}) }),
    });
    if (!res.ok) throw await this.refused(res);
    return hostingDomain(await readBody(res));
  }

  /** The host's own message for a refused change (400, 409, 429), else the status alone. */
  private async refused(res: Response): Promise<HostingError> {
    const body = (await readBody(res).catch(() => null)) as { error?: unknown } | null;
    if ([400, 409, 429].includes(res.status) && typeof body?.error === 'string')
      return new HostingError(body.error.slice(0, 300), res.status);
    if (res.status === 401)
      return new HostingError('the hosting provider refused this site (OPEND_HOSTING_TOKEN)', 401);
    return new HostingError(`hosting request failed: ${res.status}`, res.status);
  }
}
