import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readBody, type GitHubApp, type GitHubBroker } from '@opend/worker';
import { storedInstallation, type StoredGitHubApp } from '@opend/store';
import type { AppContext } from './context.js';

/** GitHub limits app names to 34 characters. */
export const APP_NAME_MAX = 34;
/** GitHub's manifest codes live an hour; the state that guards them, too. */
const STATE_TTL_SECONDS = 60 * 60;

export interface GitHubUrls {
  web: string;
  api: string;
}

/** GitHub's web and API URLs: github.com, or the GitHub Enterprise Server the variables name. */
export function githubUrls(ctx: AppContext): GitHubUrls {
  const web = (ctx.env.githubWebUrl ?? 'https://github.com').replace(/\/+$/, '');
  const api = (
    ctx.env.githubApiUrl ??
    (new URL(web).hostname === 'github.com' ? 'https://api.github.com' : `${web}/api/v3`)
  ).replace(/\/+$/, '');
  return { web, api };
}

/**
 * The GitHub App manifest for Connect GitHub: the push webhook, the docs
 * site's and the editor's sign-in callbacks, the setup URL that receives the
 * installation, and the permissions the worker and editor need.
 */
export function buildManifest(options: {
  name: string;
  publicUrl: string;
  editorUrl?: string | undefined;
}): Record<string, unknown> {
  const base = options.publicUrl.replace(/\/+$/, '');
  const callbacks = [`${base}/auth/github/callback`];
  if (options.editorUrl)
    callbacks.push(`${options.editorUrl.replace(/\/+$/, '')}/auth/github/callback`);
  return {
    name: options.name,
    url: base,
    description: `OpenD docs at ${base}: builds on push, GitHub sign-in and the web editor.`,
    hook_attributes: { url: `${base}/webhooks/github`, active: true },
    redirect_url: `${base}/admin/github/manifest-callback`,
    callback_urls: callbacks,
    setup_url: `${base}/admin/github/installed`,
    setup_on_update: true,
    public: false,
    request_oauth_on_install: false,
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      administration: 'read',
      checks: 'read',
      statuses: 'write',
      metadata: 'read',
      email_addresses: 'read',
    },
    default_events: ['push'],
  };
}

/** Where the manifest form posts: an organization's app settings, or the signed-in user's. */
export function newAppUrl(web: string, owner: string | undefined, state: string): string {
  const path = owner
    ? `/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : '/settings/apps/new';
  return `${web}${path}?state=${encodeURIComponent(state)}`;
}

function stateKey(ctx: AppContext): Buffer {
  return createHmac('sha256', ctx.env.sessionSecret).update('opend-github-manifest-state').digest();
}

/** Binds the state to one staff session: a hash of its signed cookie, never the cookie itself. */
function sessionBinding(sessionCookie: string): string {
  return createHash('sha256').update(sessionCookie).digest('base64url').slice(0, 32);
}

/** A signed, short-lived state for the manifest flow, bound to the staff session that started it. */
export function signManifestState(
  ctx: AppContext,
  sessionCookie: string,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      b: sessionBinding(sessionCookie),
      e: Math.floor(now / 1000) + STATE_TTL_SECONDS,
      n: randomBytes(12).toString('base64url'),
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', stateKey(ctx)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Whether `state` was signed by us, has not expired, and belongs to this session. */
export function verifyManifestState(
  ctx: AppContext,
  state: string,
  sessionCookie: string,
  now = Date.now(),
): boolean {
  const [payload, sig, extra] = state.split('.');
  if (!payload || !sig || extra !== undefined) return false;
  const want = Buffer.from(createHmac('sha256', stateKey(ctx)).update(payload).digest('base64url'));
  const given = Buffer.from(sig);
  if (want.length !== given.length || !timingSafeEqual(want, given)) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      b?: unknown;
      e?: unknown;
    };
    if (typeof value.e !== 'number' || value.e < now / 1000) return false;
    const binding = Buffer.from(sessionBinding(sessionCookie));
    const bound = Buffer.from(typeof value.b === 'string' ? value.b : '');
    return binding.length === bound.length && timingSafeEqual(binding, bound);
  } catch {
    return false;
  }
}

/** What GitHub returns for a manifest code: the new app and its credentials. */
export interface ConvertedApp {
  app: StoredGitHubApp;
  privateKey: string;
  clientSecret: string;
  webhookSecret: string | null;
}

/**
 * Exchanges a manifest code (single-use, one hour) for the new app's id,
 * client credentials, private key and webhook secret.
 */
export async function convertManifestCode(
  urls: GitHubUrls,
  code: string,
  fetchImpl: typeof fetch,
): Promise<ConvertedApp> {
  const res = await fetchImpl(`${urls.api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  const body = (await readBody(res)) as Record<string, unknown> | null;
  if (!res.ok || !body) throw new Error(`GitHub app manifest conversion failed: ${res.status}`);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const id = typeof body.id === 'number' ? String(body.id) : str(body.id);
  const pem = str(body.pem);
  const clientId = str(body.client_id);
  const clientSecret = str(body.client_secret);
  if (!id || !pem || !clientId || !clientSecret)
    throw new Error('GitHub returned an incomplete app (no id, client or private key)');
  const owner = (body.owner as { login?: unknown } | undefined)?.login;
  return {
    app: {
      appId: id,
      slug: str(body.slug),
      name: str(body.name),
      clientId,
      htmlUrl: str(body.html_url),
      owner: typeof owner === 'string' ? owner : null,
      webUrl: urls.web,
      apiUrl: urls.api,
      createdAt: new Date().toISOString(),
    },
    privateKey: pem,
    clientSecret,
    webhookSecret: str(body.webhook_secret) || null,
  };
}

/**
 * Checks, as the app, that an installation id (from GitHub's redirect to the
 * setup URL, which anyone could forge) is an installation of our own app.
 * Returns its account login, or null when it is not.
 */
export async function verifyInstallation(
  app: GitHubApp,
  installationId: number,
): Promise<{ account: string | null } | null> {
  const res = await app.appRequest('GET', `/app/installations/${installationId}`);
  if (res.status !== 200) return null;
  const account = (res.data as { account?: { login?: unknown } } | null)?.account?.login;
  return { account: typeof account === 'string' ? account : null };
}

export interface PickableRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number | null;
}

/**
 * Repositories the site can be built from, for the docs-source picker: the
 * broker's list in managed hosting, or the connected app's installation.
 * `null` when there is nothing to pick from (not connected, or no installation yet).
 */
export async function pickableRepos(ctx: AppContext): Promise<PickableRepo[] | null> {
  const mode = ctx.github.mode();
  if (mode === 'broker') {
    const broker = ctx.github.broker as GitHubBroker;
    return (await broker.repos()).map((r) => ({ ...r }));
  }
  if (mode !== 'stored') return null;
  const installation = storedInstallation(ctx.settings.current);
  const app = ctx.github.app();
  if (!installation || !app) return null;
  return (await app.installationRepos(installation.id)).map((r) => ({
    ...r,
    installationId: installation.id,
  }));
}
