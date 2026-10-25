import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SECRET,
  SETTING,
  audit,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiAudience,
  clearEntitlements,
  consumeSetupToken,
  deleteOrg,
  deleteReader,
  deleteSecret,
  deleteSetting,
  findReaderByEmail,
  getReaderAccess,
  getRelease,
  listAudit,
  listEditorUsers,
  listJobs,
  listLiveReleases,
  listOrgs,
  listReaders,
  listRepos,
  putSecret,
  putSetting,
  setEditorUserDisabled,
  setEntitlements,
  setReaderStaff,
  setRepoAccess,
  setRepoVersionPicker,
  settingFlag,
  settingString,
  setupTokenValid,
  storedGitHubApp,
  storedInstallation,
  upsertEditorUser,
  upsertOrg,
  upsertReader,
  useHandoff,
  updateRepo,
  withTransaction,
  type Db,
  type Entitlements,
  type ReaderAccess,
  type Repo,
  type StoredRelease,
} from '@opend/store';
import { compareReleaseLines } from '@opend/filter';
import { BrokerError, type BrokerDomain } from '@opend/worker';
import {
  pdfTemplateSchema,
  PDF_TEMPLATES,
  publicationSlug,
  siteThemeSchema,
  type PdfTemplate,
} from '@opend/model';
import { publicationHref } from '@opend/render-html';
import {
  changeReleaseLines,
  declaredFields,
  entitlementsSchema,
  publicEntitlementsSchema,
  repoSchema,
  slug as slugSchema,
  versionPickerSchema,
} from './admin.js';
import {
  adminShell,
  apiPage,
  appearancePage,
  connectPage,
  domainPage,
  editorPage,
  githubPage,
  html,
  overviewPage,
  peoplePage,
  setupForm,
  signInSettingsPage,
  sitePage,
  sourcePage,
  type AdminSection,
  type Flash,
  type Html,
} from './admin-pages.js';
import { HANDOFF_PATH, verifyHandoff } from './admin-handoff.js';
import { autoConnect, forgetAutoConnect, queueReleaseBuilds, saveSource } from './auto-connect.js';
import { accentProblem, appearance, effectivePdfTemplate } from './appearance.js';
import { ADMIN_CSS } from './admin-style.js';
import { loginPath, safeReturnTo, setSession, siteSession } from './auth.js';
import { API_KEY_EMAIL_DOMAIN } from './api-writes.js';
import type { AppContext } from './context.js';
import { siteRepo } from './delivery.js';
import {
  APP_NAME_MAX,
  buildManifest,
  convertManifestCode,
  githubUrls,
  newAppUrl,
  pickableRepos,
  signManifestState,
  verifyInstallation,
  verifyManifestState,
} from './github-connect.js';
import { messagePage, signInAvailable, simplePage } from './pages.js';
import { settingSources, storedOidc } from './settings.js';

/** Admin pages: never cached, never framed, no script at all. */
function adminHeaders(formAction = "'self'"): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  };
}

/** A signed-in staff reader on the docs site's own session. */
interface Staff {
  access: ReaderAccess;
  /** The raw session cookie: CSRF tokens and the manifest state are bound to it. */
  cookie: string;
  csrf: string;
  actor: string;
}

/** Messages for `?done=` after a change: codes only, so no text travels in URLs. */
const DONE: Record<string, string> = {
  welcome:
    'Welcome. You are a staff reader: connect GitHub and choose the docs repository to get going.',
  access: 'Access saved. Every page follows it from now on.',
  versions: 'Version picker saved. Every page follows it from now on.',
  'release-lines':
    'Release lines saved. Live releases moved to their new lines; older versions come back with their next build.',
  'release-lines-same': 'Release lines unchanged.',
  repo: 'Docs repository saved.',
  'repo-build': 'Docs repository saved and a build queued. It goes live when it passes validation.',
  build: 'Build queued. It goes live when it passes validation.',
  'build-none': 'No branch or tag matches the release refs, so nothing was built.',
  org: 'Organization saved.',
  'org-deleted': 'Organization deleted.',
  reader: 'Reader saved.',
  'reader-deleted': 'Reader removed.',
  oidc: 'Company sign-in saved.',
  'oidc-deleted': 'Company sign-in removed.',
  signin: 'Sign-in options saved.',
  connected: 'GitHub App created. Install it on your docs repository next.',
  installed: 'GitHub App installed. Choose the docs repository below.',
  'auto-connected':
    'GitHub connected, and the docs repository with it: its opend.config.yaml says where the docs are and how the site is set up. Its builds are queued and go live when they pass validation.',
  disconnected: 'GitHub disconnected.',
  editor: 'Editor settings saved.',
  author: 'Author saved.',
  'key-revoked': 'API key revoked. Anything using it stops working at once.',
  theme: 'Theme saved. Every page uses it from now on.',
  'theme-reset': 'Theme reset: the site looks as the repository sets it.',
  pdf: 'PDF settings saved. Publications are printed again with them.',
  'pdf-template': 'Template applied. Adjust the settings below, or keep them as they are.',
  'pdf-reset': 'PDF template reset: publications follow the repository’s pdf settings.',
  domain:
    'Custom domain saved. The DNS records to add appear below in a few minutes; the site keeps its own address until they are in place.',
  'domain-removed': 'Custom domain removed. The site is back at its own address.',
};

const ORG_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** A hostname such as docs.example.com; the hosting provider checks the rest. */
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const token = z.string().regex(/^[A-Za-z0-9_.:-]+$/);

class InputError extends Error {}

/** A new key from the console form: its name, scopes, audience and expiry. */
function apiKeyInput(
  body: Record<string, string>,
  orgs: { slug: string }[],
): {
  name: string;
  scopes: string[];
  audience: ApiAudience;
  orgSlug: string | null;
  expiresAt: Date | null;
} {
  const name = (body.name ?? '').trim();
  if (!name || name.length > 100)
    throw new InputError('Give the key a name (up to 100 characters).');
  const access = body.access ?? 'read';
  if (!['read', 'write', 'publish'].includes(access))
    throw new InputError('Choose what the key can do.');
  const scopes = [access, ...(body.builds === '1' ? ['builds'] : [])];
  const audienceValue = body.audience ?? 'staff';
  let audience: ApiAudience;
  let orgSlug: string | null = null;
  if (audienceValue === 'staff' || audienceValue === 'public') audience = audienceValue;
  else if (
    audienceValue.startsWith('org:') &&
    orgs.some((o) => o.slug === audienceValue.slice(4))
  ) {
    audience = 'org';
    orgSlug = audienceValue.slice(4);
  } else throw new InputError('Choose whose view of the docs the key reads.');
  const days = body.expires === 'never' ? null : Number(body.expires ?? '90');
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650))
    throw new InputError('Choose when the key expires.');
  return {
    name,
    scopes,
    audience,
    orgSlug,
    expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000),
  };
}

function bodyOf(request: FastifyRequest): Record<string, string> {
  const body = request.body;
  if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) return {};
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
}

/** The values of checkboxes named `<prefix>:<value>`. */
function checked(body: Record<string, string>, prefix: string): string[] {
  return Object.keys(body)
    .filter((k) => k.startsWith(`${prefix}:`))
    .map((k) => k.slice(prefix.length + 1))
    .filter((v) => token.safeParse(v).success);
}

/** Entitlements from a form: `null` when no version is given. */
/**
 * Entitlements from a form: none without a version. The public set's version
 * (`publicSet`) may also be `latest`, the newest live release line.
 */
function entitlementsFrom(body: Record<string, string>, publicSet = false): Entitlements | null {
  const version = (body.version ?? '').trim();
  if (!version) return null;
  const parsed = (publicSet ? publicEntitlementsSchema : entitlementsSchema).safeParse({
    products: checked(body, 'product'),
    features: checked(body, 'feature'),
    version,
  });
  if (!parsed.success)
    throw new InputError(
      publicSet
        ? 'Give the release version as a number such as 2.1, or latest.'
        : 'Give the release version as a number such as 2.1.',
    );
  return parsed.data;
}

/** The newest live release of a repo, for its title and declared attributes. */
async function newestRelease(ctx: AppContext, repo: Repo | null): Promise<StoredRelease | null> {
  if (!repo) return null;
  const live = (await listLiveReleases(ctx.pool, repo.id)).sort((a, b) =>
    compareReleaseLines(b.releaseLine, a.releaseLine),
  );
  return live[0] ? getRelease(ctx.pool, live[0].releaseId) : null;
}

function attributesOf(release: StoredRelease | null): { product: string[]; feature: string[] } {
  const attrs = release?.snapshot.attributes ?? {};
  return { product: attrs.product ?? [], feature: attrs.feature ?? [] };
}

/**
 * The admin console at `/admin`: server-rendered pages for staff readers to
 * run their site from the browser. Every change is a POST with the session's
 * CSRF token, is checked against the Origin, and is written to the audit log.
 * Anyone who is not a signed-in staff reader gets a 404 (anonymous visitors
 * are sent to sign in first).
 */
export function registerAdminConsole(app: FastifyInstance, ctx: AppContext): void {
  const csrfFor = (cookie: string) =>
    createHmac('sha256', ctx.env.sessionSecret).update(`admin-csrf:${cookie}`).digest('base64url');

  const notFound = (reply: FastifyReply) =>
    reply
      .code(404)
      .headers(adminHeaders())
      .type('text/html; charset=utf-8')
      .send(messagePage('Not found', 'There is no page at this address.'));

  /** The staff reader, or null after sending the response (redirect or 404). */
  const staffOnly = async (request: FastifyRequest, reply: FastifyReply): Promise<Staff | null> => {
    const session = siteSession(request);
    // Read fresh, not from the reader cache, so revoking staff takes effect at once.
    const access = session ? await getReaderAccess(ctx.pool, session.readerId) : null;
    if (session && access?.reader.staff)
      return {
        access,
        cookie: session.cookie,
        csrf: csrfFor(session.cookie),
        actor: `staff:${access.reader.email}`,
      };
    if (!session && request.method === 'GET' && signInAvailable(ctx)) {
      void reply.redirect(loginPath(safeReturnTo(request.url)));
      return null;
    }
    void notFound(reply);
    return null;
  };

  /** Same-origin POSTs only, with the session's admin CSRF token. */
  const checkPost = (request: FastifyRequest, s: Staff): boolean => {
    const origin = request.headers.origin;
    if (origin && origin !== new URL(ctx.env.publicUrl).origin) return false;
    const sent = Buffer.from(bodyOf(request)._csrf ?? '');
    const want = Buffer.from(s.csrf);
    return sent.length === want.length && timingSafeEqual(sent, want);
  };

  const siteTitle = async () => {
    const release = await newestRelease(ctx, await siteRepo(ctx));
    return release?.snapshot.title || 'OpenD';
  };

  const warnings = (): string[] => {
    const unreadable = ctx.settings.current.unreadable;
    return unreadable.length
      ? [
          `Some stored secrets cannot be decrypted (${unreadable.join(', ')}): SESSION_SECRET or OPEND_SECRET_KEY changed since they were saved. Enter them again, or reconnect GitHub.`,
        ]
      : [];
  };

  type Page = { title: string; body: Html; formAction?: string };
  /** `created`: a key just made, whose token the API page shows this once. */
  const pages: Record<
    AdminSection,
    (s: Staff, created?: { name: string; token: string }) => Promise<Page>
  > = {
    overview: async () => {
      // Zero-touch setup: connects the docs repository when GitHub exposes exactly one.
      const auto = await autoConnect(ctx);
      const repos = await listRepos(ctx.pool);
      const repo = await siteRepo(ctx);
      const names = new Map(repos.map((r) => [r.id, r.fullName]));
      const readers = await listReaders(ctx.pool);
      return {
        title: 'Overview',
        body: overviewPage({
          repo,
          repoCount: repos.length,
          live: repo ? await listLiveReleases(ctx.pool, repo.id) : [],
          jobs: (await listJobs(ctx.pool, { limit: 10 })).map((j) => ({
            ...j,
            repoName: names.get(j.repoId) ?? '',
          })),
          readers: readers.length,
          staff: readers.filter((r) => r.staff).length,
          orgs: (await listOrgs(ctx.pool)).length,
          audit: await listAudit(ctx.pool, 10),
          github: settingSources(ctx.env, ctx.settings.current).github,
          publicUrl: ctx.env.publicUrl,
          autoConnect: auto,
        }),
      };
    },
    site: async (s) => {
      const repo = await siteRepo(ctx);
      const release = await newestRelease(ctx, repo);
      return {
        title: 'Site & access',
        body: sitePage({
          repo,
          repoCount: (await listRepos(ctx.pool)).length,
          siteTitle: release?.snapshot.title || 'OpenD',
          attributes: attributesOf(release),
          release: release?.snapshot.release ?? null,
          published: repo
            ? (await listLiveReleases(ctx.pool, repo.id))
                .sort((a, b) => compareReleaseLines(b.releaseLine, a.releaseLine))
                .map((r) => r.release)
            : [],
          publicUrl: ctx.env.publicUrl,
          csrf: s.csrf,
        }),
      };
    },
    domain: async (s) => {
      // Managed hosting attaches domains; the broker credential asks for this site only.
      const broker = ctx.github.broker;
      let domain: BrokerDomain | null = null;
      let loadError: string | null = null;
      if (broker) {
        try {
          domain = await broker.domain();
        } catch (err) {
          ctx.log({ level: 'warn', msg: 'custom domain status failed', error: String(err) });
          loadError =
            err instanceof BrokerError && err.status === 403
              ? 'Your hosting provider does not change this site right now (it may be suspended).'
              : 'Could not reach your hosting provider.';
        }
      }
      return {
        title: 'Custom domain',
        body: domainPage({
          managed: broker !== null,
          publicUrl: ctx.env.publicUrl,
          domain,
          loadError,
          csrf: s.csrf,
        }),
      };
    },
    source: async (s) => {
      await autoConnect(ctx);
      const repos = await listRepos(ctx.pool);
      const names = new Map(repos.map((r) => [r.id, r.fullName]));
      let picker = null;
      let pickerError: string | null = null;
      try {
        picker = await pickableRepos(ctx);
      } catch (err) {
        pickerError = `Could not list repositories from GitHub: ${err instanceof Error ? err.message : String(err)}`;
      }
      return {
        title: 'Docs source',
        body: sourcePage({
          repos,
          siteRepo: await siteRepo(ctx),
          picker,
          pickerError,
          mode: ctx.github.mode(),
          production: ctx.env.production,
          jobs: (await listJobs(ctx.pool, { limit: 10 })).map((j) => ({
            ...j,
            repoName: names.get(j.repoId) ?? '',
          })),
          csrf: s.csrf,
        }),
      };
    },
    people: async (s) => {
      const readers = await listReaders(ctx.pool);
      const count = new Map<string, number>();
      for (const r of readers) count.set(r.orgSlug, (count.get(r.orgSlug) ?? 0) + 1);
      return {
        title: 'People',
        body: peoplePage({
          orgs: (await listOrgs(ctx.pool)).map((o) => ({ ...o, readers: count.get(o.slug) ?? 0 })),
          readers,
          attributes: attributesOf(await newestRelease(ctx, await siteRepo(ctx))),
          me: s.access.reader.id,
          csrf: s.csrf,
        }),
      };
    },
    appearance: async (s) => {
      const release = await newestRelease(ctx, await siteRepo(ctx));
      const look = appearance(ctx);
      return {
        title: 'Appearance',
        body: appearancePage({
          theme: look.theme ?? siteThemeSchema.parse({}),
          themeStored: look.theme !== null,
          repoTheme: Boolean(release?.snapshot.theme),
          pdf: effectivePdfTemplate(look, release?.snapshot.pdf),
          pdfStored: look.pdf !== null,
          repoPdf: Boolean(release?.snapshot.pdf),
          publications: (release?.snapshot.publications ?? []).map((p) => ({
            title: p.title || publicationSlug(p.file),
            href: publicationHref(p),
          })),
          csrf: s.csrf,
        }),
      };
    },
    'sign-in': async (s) => {
      const snap = ctx.settings.current;
      const sources = settingSources(ctx.env, snap);
      const oidc = ctx.env.oidc ?? storedOidc(snap);
      const stored = snap.values[SETTING.oidc] as Record<string, unknown> | undefined;
      const app = ctx.github.mode() === 'stored' ? storedGitHubApp(snap) : null;
      return {
        title: 'Sign-in',
        body: signInSettingsPage({
          publicUrl: ctx.env.publicUrl,
          oidcSource: sources.oidc,
          oidc: oidc
            ? {
                issuer: oidc.issuer,
                clientId: oidc.clientId,
                displayName: oidc.displayName ?? '',
                icon: oidc.icon ?? 'key',
                secretSet: true,
              }
            : stored && typeof stored.issuer === 'string'
              ? {
                  issuer: stored.issuer,
                  clientId: typeof stored.clientId === 'string' ? stored.clientId : '',
                  displayName: typeof stored.displayName === 'string' ? stored.displayName : '',
                  icon: stored.icon === 'github' ? 'github' : 'key',
                  secretSet: false,
                }
              : null,
          githubSignIn: sources.githubSignIn,
          githubEnabled: settingFlag(snap, SETTING.signIn, 'github', true),
          githubAvailable:
            Boolean(app?.clientId && app.clientSecret) || sources.githubSignIn === 'env',
          managed: ctx.github.mode() === 'broker',
          devLoginAllowed: ctx.env.devLogin,
          devLoginOn: ctx.config.devLogin,
          canStoreSecrets: ctx.settings.canStoreSecrets,
          csrf: s.csrf,
        }),
      };
    },
    github: async (s) => {
      const snap = ctx.settings.current;
      const mode = ctx.github.mode();
      const app = mode === 'stored' ? storedGitHubApp(snap) : null;
      let repos = null;
      let reposError: string | null = null;
      try {
        repos = await pickableRepos(ctx);
      } catch (err) {
        reposError = `Could not list repositories: ${err instanceof Error ? err.message : String(err)}`;
      }
      const callbacks = [`${ctx.env.publicUrl}/auth/github/callback`];
      const allRepos = mode === 'broker' ? await listRepos(ctx.pool) : [];
      if (ctx.config.editorUrl) callbacks.push(`${ctx.config.editorUrl}/auth/github/callback`);
      return {
        title: 'GitHub',
        body: githubPage({
          mode,
          source:
            mode === 'broker'
              ? {
                  repos: allRepos,
                  siteRepo: await siteRepo(ctx),
                  picker: repos,
                  pickerError: null,
                  mode,
                  production: ctx.env.production,
                  jobs: [],
                  csrf: s.csrf,
                }
              : null,
          app: app
            ? {
                name: app.name,
                slug: app.slug,
                appId: app.appId,
                owner: app.owner,
                ownerIsOrg: app.ownerIsOrg === true,
                htmlUrl: app.htmlUrl,
                webUrl: app.webUrl,
              }
            : null,
          installation: storedInstallation(snap),
          installUrl: ctx.env.broker?.installUrl ?? null,
          repos,
          reposError,
          callbacks,
          defaultName: defaultAppName(ctx.env.publicUrl),
          webhook: settingSources(ctx.env, snap).webhook,
          editorUrl: ctx.config.editorUrl ?? null,
          csrf: s.csrf,
        }),
      };
    },
    api: async (s, created) => {
      return {
        title: 'API & AI',
        body: apiPage({
          keys: await listApiKeys(ctx.pool),
          orgs: (await listOrgs(ctx.pool)).map((o) => ({ slug: o.slug, name: o.name })),
          created: created ?? null,
          apiBase: `${ctx.env.publicUrl}/api/v1`,
          mcpUrl: ctx.env.mcpUrl ?? null,
          csrf: s.csrf,
        }),
      };
    },
    editor: async (s) => {
      const snap = ctx.settings.current;
      const sources = settingSources(ctx.env, snap);
      return {
        title: 'Editor',
        body: editorPage({
          urlSource: sources.editorUrl,
          url: ctx.config.editorUrl ?? '',
          editLinks: ctx.config.editLinks !== false,
          sourceLinks: ctx.config.sourceLinks === true,
          sourceLinksEnv: ctx.env.sourceLinks === true,
          // API keys' own editor users are listed on the API page, not as authors.
          users: (await listEditorUsers(ctx.pool)).filter(
            (u) => !u.email.endsWith(`@${API_KEY_EMAIL_DOMAIN}`),
          ),
          github: ctx.github.mode(),
          publicUrl: ctx.env.publicUrl,
          csrf: s.csrf,
        }),
      };
    },
  };

  const show = async (
    reply: FastifyReply,
    s: Staff,
    section: AdminSection,
    flash: Flash | null,
    status = 200,
    created?: { name: string; token: string },
  ) => {
    const page = await pages[section](s, created);
    return reply
      .code(status)
      .headers(adminHeaders(page.formAction))
      .type('text/html; charset=utf-8')
      .send(
        adminShell(
          {
            title: page.title,
            section,
            siteTitle: await siteTitle(),
            reader: s.access.reader,
            csrf: s.csrf,
            flash,
            warnings: warnings(),
          },
          page.body,
        ),
      );
  };

  const doneFlash = (request: FastifyRequest): Flash | null => {
    const code = (request.query as { done?: unknown }).done;
    return typeof code === 'string' && DONE[code] ? { kind: 'ok', message: DONE[code] } : null;
  };

  const ROUTES: [string, AdminSection][] = [
    ['/admin', 'overview'],
    ['/admin/site', 'site'],
    ['/admin/domain', 'domain'],
    ['/admin/source', 'source'],
    ['/admin/people', 'people'],
    ['/admin/appearance', 'appearance'],
    ['/admin/sign-in', 'sign-in'],
    ['/admin/github', 'github'],
    ['/admin/editor', 'editor'],
    ['/admin/api-keys', 'api'],
  ];
  for (const [path, section] of ROUTES) {
    app.get(path, async (request, reply) => {
      const s = await staffOnly(request, reply);
      if (!s) return reply;
      return show(reply, s, section, doneFlash(request));
    });
  }
  app.get('/admin/', async (_request, reply) => reply.redirect('/admin'));
  // Integrations: where the managed-hosting control plane returns after Connect GitHub
  // (`?github=connected`); the GitHub page, with a success notice.
  app.get('/admin/integrations', async (request, reply) => {
    const s = await staffOnly(request, reply);
    if (!s) return reply;
    const connected = (request.query as { github?: unknown }).github === 'connected';
    if (connected) {
      // The hosting provider linked an installation: with exactly one repository, connect it now.
      forgetAutoConnect(ctx.pool);
      const auto = await autoConnect(ctx);
      if (auto.status === 'connected') return reply.redirect('/admin?done=auto-connected', 303);
    }
    return show(
      reply,
      s,
      'github',
      connected
        ? { kind: 'ok', message: 'GitHub connected. Choose the docs repository below.' }
        : doneFlash(request),
    );
  });

  /**
   * A POST action: staff, Origin and CSRF checked; `run` makes the change
   * (and audits it) and returns the `?done=` code. Input errors re-render the
   * section with the message.
   */
  const action = (
    path: string,
    section: AdminSection,
    run: (s: Staff, body: Record<string, string>) => Promise<string>,
  ) => {
    app.post(path, async (request, reply) => {
      const s = await staffOnly(request, reply);
      if (!s) return reply;
      if (!checkPost(request, s))
        return reply
          .code(403)
          .headers(adminHeaders())
          .type('text/html; charset=utf-8')
          .send(
            messagePage('Form expired', 'Reload the page and try again.', {
              href: '/admin',
              text: 'Back to the admin console',
            }),
          );
      try {
        const done = await run(s, bodyOf(request));
        const target = ROUTES.find((r) => r[1] === section)![0];
        return reply.redirect(`${target}?done=${encodeURIComponent(done)}`, 303);
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return show(reply, s, section, { kind: 'error', message: err.message }, 400);
      }
    });
  };

  const changed = async () => {
    await ctx.reloadSettings();
  };

  // ---- custom domain (managed hosting) ---------------------------------------

  /** Asks the hosting provider to change the domain; its refusals become form errors. */
  const changeDomain = async (s: Staff, domain: string | null): Promise<void> => {
    const broker = ctx.github.broker;
    if (!broker)
      throw new InputError(
        'This site is self-hosted: its address is PUBLIC_URL, served by your reverse proxy.',
      );
    try {
      await broker.setDomain(domain, s.access.reader.email);
    } catch (err) {
      if (!(err instanceof BrokerError)) throw err;
      ctx.log({ level: 'warn', msg: 'custom domain change refused', error: err.message });
      throw new InputError(
        [400, 409, 429].includes(err.status)
          ? err.message
          : 'Your hosting provider could not change the domain right now. Try again in a minute.',
      );
    }
    await audit(ctx.pool, s.actor, domain ? 'domain.set' : 'domain.remove', { domain });
  };

  action('/admin/domain', 'domain', async (s, body) => {
    const domain = (body.domain ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!DOMAIN.test(domain))
      throw new InputError('Enter a domain name such as docs.example.com, without https://.');
    await changeDomain(s, domain);
    return 'domain';
  });

  action('/admin/domain/remove', 'domain', async (s) => {
    await changeDomain(s, null);
    return 'domain-removed';
  });

  // ---- site & access -------------------------------------------------------

  action('/admin/site/access', 'site', async (s, body) => {
    const repo = await siteRepo(ctx);
    if (!repo) throw new InputError('Register the docs repository first.');
    // Fields the repository's opend.config.yaml declares keep its values (their inputs are disabled).
    const owned = declaredFields(repo, ['access', 'publicEntitlements']);
    const access = owned.includes('access') ? repo.access : body.access;
    if (access !== 'private' && access !== 'public')
      throw new InputError('Choose private or public.');
    const pub = owned.includes('publicEntitlements')
      ? repo.publicEntitlements
      : entitlementsFrom(body, true);
    await withTransaction(ctx.pool, async (db) => {
      await setRepoAccess(db, repo.id, access, pub);
      await audit(db, s.actor, 'repo.access', {
        repo: repo.fullName,
        access,
        publicEntitlements: pub,
      });
    });
    // Every cached view and page is dropped; NOTIFY does the same on other replicas.
    ctx.caches.releaseChanged();
    return 'access';
  });

  action('/admin/site/versions', 'site', async (s, body) => {
    const declared = await siteRepo(ctx);
    if (declared && declaredFields(declared, ['versionPicker']).length)
      throw new InputError(
        'The version picker is set by opend.config.yaml (site.versionPicker): change it in the docs repository.',
      );
    const versions = (body.versions ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const parsed = versionPickerSchema.safeParse(
      body.mode === 'fixed'
        ? { mode: 'fixed', version: (body.fixedVersion ?? '').trim() }
        : body.mode === 'list'
          ? { mode: 'list', versions }
          : { mode: body.mode },
    );
    if (!parsed.success)
      throw new InputError(
        body.mode === 'fixed' || body.mode === 'list'
          ? 'Give each version as a number such as 2.1.'
          : 'Choose what readers can pick.',
      );
    const repo = await siteRepo(ctx);
    if (!repo) throw new InputError('Register the docs repository first.');
    await withTransaction(ctx.pool, async (db) => {
      await setRepoVersionPicker(db, repo.id, parsed.data);
      await audit(db, s.actor, 'repo.versions', {
        repo: repo.fullName,
        versionPicker: parsed.data,
      });
    });
    ctx.caches.releaseChanged();
    return 'versions';
  });

  action('/admin/site/release-lines', 'site', async (s, body) => {
    const lines = body.releaseLines;
    if (lines !== 'major' && lines !== 'minor')
      throw new InputError('Choose release lines by major or by minor version.');
    const repo = await siteRepo(ctx);
    if (!repo) throw new InputError('Register the docs repository first.');
    if (declaredFields(repo, ['releaseLines']).length)
      throw new InputError(
        'Release lines are set by opend.config.yaml (site.releaseLines): change them in the docs repository.',
      );
    if (repo.releaseLines === lines) return 'release-lines-same';
    // The same change, and audit entry, as PUT /admin/api/repos/:id/release-lines.
    await withTransaction(ctx.pool, (db) => changeReleaseLines(db, repo.id, lines, s.actor));
    // Live releases may have moved to other lines: drop every cache.
    ctx.caches.releaseChanged();
    return 'release-lines';
  });

  // ---- appearance ----------------------------------------------------------

  /** Form text with the browser's CRLF line breaks made plain newlines. */
  const css = (value: string | undefined) => (value ?? '').replace(/\r\n?/g, '\n');

  const saveAppearance = async (s: Staff, key: string, value: unknown) => {
    await withTransaction(ctx.pool, async (db) => {
      if (value === null) await deleteSetting(db, key);
      else await putSetting(db, key, value, s.actor);
      await audit(db, s.actor, `settings.${key}`, value === null ? { reset: true } : value);
    });
    await changed();
  };

  action('/admin/appearance/theme', 'appearance', async (s, body) => {
    const parsed = siteThemeSchema.safeParse({
      preset: body.preset,
      font: body.font,
      headingFont: body.headingFont,
      radius: body.radius,
      width: body.width,
      colorScheme: body.colorScheme,
      customCss: css(body.customCss),
      ...(body.customAccent === '1' ? { accent: body.accent } : {}),
      ...(body.customAccentDark === '1' ? { accentDark: body.accentDark } : {}),
    });
    if (!parsed.success)
      throw new InputError(
        `Check the theme: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    const problem = accentProblem(parsed.data);
    if (problem) throw new InputError(problem);
    await saveAppearance(s, SETTING.siteTheme, parsed.data);
    return 'theme';
  });

  action('/admin/appearance/theme/reset', 'appearance', async (s) => {
    await saveAppearance(s, SETTING.siteTheme, null);
    return 'theme-reset';
  });

  action('/admin/appearance/pdf/template', 'appearance', async (s, body) => {
    const id = body.template as PdfTemplate['template'];
    if (!Object.hasOwn(PDF_TEMPLATES, id ?? '')) throw new InputError('Choose a template.');
    // The template's settings, keeping the print CSS already saved.
    const current = appearance(ctx).pdf;
    await saveAppearance(s, SETTING.pdfTemplate, {
      ...PDF_TEMPLATES[id].settings,
      customCss: current?.customCss ?? '',
    });
    return 'pdf-template';
  });

  action('/admin/appearance/pdf', 'appearance', async (s, body) => {
    const parsed = pdfTemplateSchema.safeParse({
      template: body.template,
      pageSize: body.pageSize,
      orientation: body.orientation,
      margins: body.margins,
      fontSize: body.fontSize,
      cover: body.cover,
      coverNote: (body.coverNote ?? '').trim(),
      toc: body.toc === '1',
      chapterBreaks: body.chapterBreaks === '1',
      header: (body.header ?? '').trim(),
      footer: (body.footer ?? '').trim(),
      pageNumbers: body.pageNumbers === '1',
      font: body.font,
      customCss: css(body.pdfCss),
    });
    if (!parsed.success)
      throw new InputError(
        `Check the PDF settings: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    await saveAppearance(s, SETTING.pdfTemplate, parsed.data);
    return 'pdf';
  });

  action('/admin/appearance/pdf/reset', 'appearance', async (s) => {
    await saveAppearance(s, SETTING.pdfTemplate, null);
    return 'pdf-reset';
  });

  // ---- docs source ---------------------------------------------------------

  const queueBuilds = async (s: Staff, repo: Repo): Promise<number> => {
    try {
      return await queueReleaseBuilds(ctx, repo, s.actor);
    } catch (err) {
      throw new InputError(
        `Could not read the repository’s branches: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  action('/admin/source', 'source', async (s, body) => {
    const releaseRefs = (body.releaseRefs ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    let input: { fullName: string; sourceUrl: string; installationId: number | null };
    if (body.from === 'github') {
      // Never trust a posted installation id: take it from GitHub's (or the broker's) own list.
      let list;
      try {
        list = await pickableRepos(ctx);
      } catch (err) {
        throw new InputError(
          `Could not list repositories: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const picked = list?.find(
        (r) => r.fullName.toLowerCase() === (body.repo ?? '').toLowerCase(),
      );
      if (!picked)
        throw new InputError('Choose one of the repositories the GitHub App can access.');
      input = {
        fullName: picked.fullName,
        sourceUrl: `${githubUrls(ctx).web}/${picked.fullName}.git`,
        installationId:
          picked.installationId && picked.installationId > 0 ? picked.installationId : null,
      };
    } else {
      const id = (body.installationId ?? '').trim();
      input = {
        fullName: (body.fullName ?? '').trim(),
        sourceUrl: (body.sourceUrl ?? '').trim(),
        installationId: ctx.github.mode() === 'env' && id ? Number(id) : null,
      };
    }
    const docsPath = (body.docsPath ?? '.').trim() || '.';
    // The same repository and folder keep the release refs their opend.config.yaml declares
    // (the form's field is disabled for them, so it sends none).
    const same = (await listRepos(ctx.pool)).find(
      (r) => r.fullName.toLowerCase() === input.fullName.toLowerCase() && r.docsPath === docsPath,
    );
    const parsed = repoSchema(ctx.env.production).safeParse({
      ...input,
      releaseRefs:
        same && declaredFields(same, ['releaseRefs']).length ? same.releaseRefs : releaseRefs,
      docsPath,
    });
    if (!parsed.success)
      throw new InputError(
        `Check the repository: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    const value = { ...parsed.data, installationId: parsed.data.installationId ?? null };
    const current = await siteRepo(ctx);
    // Changing the site's repository keeps its row: access settings and history stay.
    const repo = await withTransaction(ctx.pool, (db) =>
      saveSource(db, value, { current, pinned: Boolean(ctx.env.siteRepo), actor: s.actor }),
    );
    ctx.caches.releaseChanged();
    if (body.build !== '1') return 'repo';
    return (await queueBuilds(s, repo)) > 0 ? 'repo-build' : 'build-none';
  });

  action('/admin/source/rebuild', 'source', async (s, body) => {
    const repo = (await listRepos(ctx.pool)).find((r) => r.id === Number(body.repoId));
    if (!repo) throw new InputError('No such repository.');
    return (await queueBuilds(s, repo)) > 0 ? 'build' : 'build-none';
  });

  // ---- people --------------------------------------------------------------

  action('/admin/people/orgs', 'people', async (s, body) => {
    const slug = slugSchema.safeParse((body.slug ?? '').trim());
    const name = (body.name ?? '').trim();
    if (!slug.success)
      throw new InputError('The short name takes lowercase letters, digits and dashes.');
    if (!name) throw new InputError('Give the organization a name.');
    const entitlements = entitlementsFrom(body);
    await withTransaction(ctx.pool, async (db) => {
      await upsertOrg(db, { slug: slug.data, name });
      if (entitlements) await setEntitlements(db, slug.data, entitlements);
      else await clearEntitlements(db, slug.data);
      await audit(db, s.actor, 'org.upsert', { slug: slug.data, name, entitlements });
    });
    ctx.caches.entitlementsChanged();
    return 'org';
  });

  action('/admin/people/orgs/delete', 'people', async (s, body) => {
    const slug = body.slug ?? '';
    if (slug === s.access.orgSlug) throw new InputError('You cannot delete your own organization.');
    await withTransaction(ctx.pool, async (db) => {
      if (await deleteOrg(db, slug)) await audit(db, s.actor, 'org.delete', { org: slug });
    });
    ctx.caches.entitlementsChanged();
    return 'org-deleted';
  });

  action('/admin/people/readers', 'people', async (s, body) => {
    const email = z.email().safeParse((body.email ?? '').trim());
    if (!email.success) throw new InputError('Give a valid email address.');
    const input = {
      orgSlug: body.orgSlug ?? '',
      email: email.data,
      name: (body.name ?? '').trim() || null,
      // Unchecked keeps an existing reader's role; only a check grants staff.
      ...(body.staff === '1' ? { staff: true } : {}),
    };
    const reader = await withTransaction(ctx.pool, async (db) => {
      const r = await upsertReader(db, input);
      if (r) await audit(db, s.actor, 'reader.upsert', input);
      return r;
    });
    if (!reader) throw new InputError('Choose an existing organization.');
    ctx.caches.entitlementsChanged();
    return 'reader';
  });

  action('/admin/people/readers/staff', 'people', async (s, body) => {
    const id = Number(body.id);
    if (id === s.access.reader.id) throw new InputError('You cannot change your own role.');
    const staff = body.staff === '1';
    await withTransaction(ctx.pool, async (db) => {
      const r = Number.isInteger(id) ? await setReaderStaff(db, id, staff) : null;
      if (r) await audit(db, s.actor, 'reader.staff', { id, email: r.email, staff });
    });
    ctx.caches.entitlementsChanged();
    return 'reader';
  });

  action('/admin/people/readers/delete', 'people', async (s, body) => {
    const id = Number(body.id);
    if (id === s.access.reader.id) throw new InputError('You cannot remove yourself.');
    await withTransaction(ctx.pool, async (db) => {
      if (Number.isInteger(id) && (await deleteReader(db, id)))
        await audit(db, s.actor, 'reader.delete', { id });
    });
    ctx.caches.entitlementsChanged();
    return 'reader-deleted';
  });

  // ---- sign-in -------------------------------------------------------------

  const needSecrets = () => {
    const box = ctx.settings.secretBox;
    if (!box)
      throw new InputError('Secrets cannot be stored: set OPEND_SECRET_KEY or SESSION_SECRET.');
    return box;
  };

  action('/admin/sign-in/oidc', 'sign-in', async (s, body) => {
    if (ctx.env.oidc) throw new InputError('Company sign-in is set by environment variables.');
    const box = needSecrets();
    const issuer = (body.issuer ?? '').trim();
    let url: URL;
    try {
      url = new URL(issuer);
    } catch {
      throw new InputError('Give the issuer as a URL, such as https://login.example.com.');
    }
    if (url.protocol !== 'https:' && (ctx.env.production || url.protocol !== 'http:'))
      throw new InputError('The issuer must be an https:// URL.');
    const clientId = (body.clientId ?? '').trim();
    const displayName = (body.displayName ?? '').trim();
    const secret = body.clientSecret ?? '';
    if (!clientId) throw new InputError('Give the client id.');
    if (displayName.length > 60) throw new InputError('Keep the button label under 60 characters.');
    if (!secret && !ctx.settings.current.secrets[SECRET.oidcClientSecret])
      throw new InputError('Give the client secret.');
    const value = {
      issuer,
      clientId,
      ...(displayName ? { displayName } : {}),
      icon: body.icon === 'github' ? 'github' : 'key',
    };
    await withTransaction(ctx.pool, async (db) => {
      await putSetting(db, SETTING.oidc, value, s.actor);
      if (secret) await putSecret(db, box, SECRET.oidcClientSecret, secret, s.actor);
      await audit(db, s.actor, 'settings.oidc', { ...value, secretChanged: Boolean(secret) });
    });
    await changed();
    return 'oidc';
  });

  action('/admin/sign-in/oidc/delete', 'sign-in', async (s) => {
    await withTransaction(ctx.pool, async (db) => {
      await deleteSetting(db, SETTING.oidc);
      await deleteSecret(db, SECRET.oidcClientSecret);
      await audit(db, s.actor, 'settings.oidc.delete');
    });
    await changed();
    return 'oidc-deleted';
  });

  action('/admin/sign-in/options', 'sign-in', async (s, body) => {
    const snap = ctx.settings.current;
    const value = {
      // Only what the form showed changes; the rest keeps its stored value.
      github:
        body.githubShown === '1'
          ? body.github === '1'
          : settingFlag(snap, SETTING.signIn, 'github', true),
      // Stored either way; it only has an effect where OPEND_DEV_LOGIN allows it.
      devLogin: ctx.env.devLogin
        ? body.devLogin === '1'
        : settingFlag(snap, SETTING.signIn, 'devLogin', true),
    };
    await withTransaction(ctx.pool, async (db) => {
      await putSetting(db, SETTING.signIn, value, s.actor);
      await audit(db, s.actor, 'settings.signin', value);
    });
    await changed();
    return 'signin';
  });

  // ---- GitHub: Connect GitHub (manifest flow) ------------------------------

  app.get('/admin/github/connect', async (request, reply) => {
    const s = await staffOnly(request, reply);
    if (!s) return reply;
    const fail = (message: string) => show(reply, s, 'github', { kind: 'error', message }, 400);
    if (ctx.github.mode() !== 'none') return reply.redirect('/admin/github');
    if (!ctx.settings.canStoreSecrets)
      return fail('Secrets cannot be stored: set OPEND_SECRET_KEY or SESSION_SECRET.');
    const q = request.query as { name?: unknown; owner?: unknown };
    const name = typeof q.name === 'string' ? q.name.trim() : '';
    const owner = typeof q.owner === 'string' ? q.owner.trim() : '';
    if (!name || name.length > APP_NAME_MAX)
      return fail(`Give the app a name of at most ${APP_NAME_MAX} characters.`);
    if (owner && !ORG_SLUG.test(owner)) return fail('That is not a GitHub organization name.');
    const urls = githubUrls(ctx);
    const manifest = buildManifest({
      name,
      publicUrl: ctx.env.publicUrl,
      editorUrl: ctx.config.editorUrl,
    });
    const action = newAppUrl(urls.web, owner || undefined, signManifestState(ctx, s.cookie));
    const body = connectPage({
      action,
      manifest: JSON.stringify(manifest),
      name,
      owner: owner || null,
    });
    return reply
      .headers(adminHeaders(`'self' ${new URL(urls.web).origin}`))
      .type('text/html; charset=utf-8')
      .send(
        adminShell(
          {
            title: 'Connect GitHub',
            section: 'github',
            siteTitle: await siteTitle(),
            reader: s.access.reader,
            csrf: s.csrf,
            warnings: warnings(),
          },
          body,
        ),
      );
  });

  // GitHub sends the browser back here with a one-time code after the app is created.
  app.get('/admin/github/manifest-callback', async (request, reply) => {
    const s = await staffOnly(request, reply);
    if (!s) return reply;
    const fail = (message: string) => show(reply, s, 'github', { kind: 'error', message }, 400);
    const q = request.query as { code?: unknown; state?: unknown };
    if (typeof q.state !== 'string' || !verifyManifestState(ctx, q.state, s.cookie)) {
      ctx.log({ level: 'warn', msg: 'github manifest state rejected', actor: s.actor });
      return fail(
        'This link did not come from a Connect GitHub you started, or it expired. Start again.',
      );
    }
    if (typeof q.code !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(q.code))
      return fail('GitHub sent no code. Start again.');
    if (ctx.github.mode() !== 'none') return fail('GitHub is already connected.');
    const box = ctx.settings.secretBox;
    if (!box) return fail('Secrets cannot be stored: set OPEND_SECRET_KEY or SESSION_SECRET.');
    let created;
    try {
      created = await convertManifestCode(githubUrls(ctx), q.code, ctx.githubFetch);
    } catch (err) {
      ctx.log({ level: 'warn', msg: 'github manifest conversion failed', error: String(err) });
      return fail('GitHub did not accept the code (it works once, for an hour). Start again.');
    }
    await withTransaction(ctx.pool, async (db) => {
      await putSetting(db, SETTING.githubApp, created.app, s.actor);
      await deleteSetting(db, SETTING.githubInstallation);
      await putSecret(db, box, SECRET.githubPrivateKey, created.privateKey, s.actor);
      await putSecret(db, box, SECRET.githubClientSecret, created.clientSecret, s.actor);
      if (created.webhookSecret)
        await putSecret(db, box, SECRET.githubWebhookSecret, created.webhookSecret, s.actor);
      await audit(db, s.actor, 'github.connect', {
        appId: created.app.appId,
        slug: created.app.slug,
        owner: created.app.owner,
      });
    });
    await changed();
    ctx.log({
      level: 'info',
      msg: 'github app connected',
      appId: created.app.appId,
      slug: created.app.slug,
    });
    if (!created.app.slug) return reply.redirect('/admin/github?done=connected', 303);
    return reply.redirect(
      `${created.app.webUrl}/apps/${encodeURIComponent(created.app.slug)}/installations/new`,
      303,
    );
  });

  // GitHub's setup URL after an installation. The id is checked with GitHub, never trusted.
  app.get('/admin/github/installed', async (request, reply) => {
    const s = await staffOnly(request, reply);
    if (!s) return reply;
    const fail = (message: string) => show(reply, s, 'github', { kind: 'error', message }, 400);
    const q = request.query as { installation_id?: unknown; setup_action?: unknown };
    const githubApp = ctx.github.mode() === 'stored' ? ctx.github.app() : null;
    if (!githubApp) return reply.redirect('/admin/github');
    if (q.setup_action === 'request')
      return fail('An owner of the account must approve the installation on GitHub first.');
    const id = Number(q.installation_id);
    if (!Number.isSafeInteger(id) || id <= 0) return fail('GitHub sent no installation.');
    let installation;
    try {
      installation = await verifyInstallation(githubApp, id);
    } catch (err) {
      return fail(
        `Could not check the installation with GitHub: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!installation) return fail('That installation does not belong to this site’s GitHub App.');
    // A repository registered before GitHub was connected has no installation, and the
    // worker and editor cannot reach it until it gets one: attach every registered
    // repository this installation can access. Best effort; picking the source again also works.
    let reachable = new Set<string>();
    try {
      const repos = await githubApp.installationRepos(id);
      reachable = new Set(repos.map((r) => r.fullName.toLowerCase()));
    } catch {
      // Listing failed; the docs-source page still attaches the repository when picked.
    }
    const registered = (await listRepos(ctx.pool)).filter(
      (r) => r.installationId !== id && reachable.has(r.fullName.toLowerCase()),
    );
    await withTransaction(ctx.pool, async (db: Db) => {
      for (const r of registered) {
        await updateRepo(db, r.id, { ...r, installationId: id });
        await audit(db, s.actor, 'repo.upsert', { fullName: r.fullName, installationId: id });
      }
      await putSetting(
        db,
        SETTING.githubInstallation,
        { id, account: installation.account },
        s.actor,
      );
      await audit(db, s.actor, 'github.install', {
        installationId: id,
        account: installation.account,
      });
    });
    await changed();
    // Zero-touch setup: with exactly one repository in the installation, connect it now.
    forgetAutoConnect(ctx.pool);
    const auto = await autoConnect(ctx);
    if (auto.status === 'connected') return reply.redirect('/admin?done=auto-connected', 303);
    return reply.redirect('/admin/source?done=installed', 303);
  });

  action('/admin/github/disconnect', 'github', async (s) => {
    if (ctx.github.mode() !== 'stored') throw new InputError('No GitHub App is connected here.');
    await withTransaction(ctx.pool, async (db) => {
      await deleteSetting(db, SETTING.githubApp);
      await deleteSetting(db, SETTING.githubInstallation);
      for (const name of [
        SECRET.githubPrivateKey,
        SECRET.githubClientSecret,
        SECRET.githubWebhookSecret,
      ])
        await deleteSecret(db, name);
      await audit(db, s.actor, 'github.disconnect');
    });
    await changed();
    return 'disconnected';
  });

  // ---- editor --------------------------------------------------------------

  action('/admin/editor', 'editor', async (s, body) => {
    const snap = ctx.settings.current;
    let url = settingString(snap, SETTING.editor, 'url');
    if (!ctx.env.editorUrl) {
      const given = (body.url ?? '').trim();
      if (!given) url = undefined;
      else {
        let parsed: URL;
        try {
          parsed = new URL(given);
        } catch {
          throw new InputError('Give the editor’s address as a URL.');
        }
        const site = new URL(ctx.env.publicUrl);
        if (
          !['https:', 'http:'].includes(parsed.protocol) ||
          (ctx.env.production && parsed.protocol !== 'https:')
        )
          throw new InputError('The editor’s address must be an https:// URL.');
        const sameHost = ctx.env.production
          ? parsed.hostname === site.hostname
          : parsed.host === site.host;
        if (sameHost) throw new InputError('The editor needs its own host name, not this site’s.');
        url = parsed.origin;
      }
    }
    const value = {
      ...(url ? { url } : {}),
      editLinks: body.editLinks === '1',
      sourceLinks: body.sourceLinks === '1',
    };
    await withTransaction(ctx.pool, async (db) => {
      await putSetting(db, SETTING.editor, value, s.actor);
      await audit(db, s.actor, 'settings.editor', value);
    });
    await changed();
    return 'editor';
  });

  action('/admin/editor/users', 'editor', async (s, body) => {
    const email = z.email().safeParse((body.email ?? '').trim());
    if (!email.success) throw new InputError('Give a valid email address.');
    const github = (body.github ?? '').trim().replace(/^@/, '');
    if (github && !GITHUB_LOGIN.test(github)) throw new InputError('That is not a GitHub login.');
    const input = {
      email: email.data,
      name: (body.name ?? '').trim() || null,
      githubLogin: github || null,
    };
    await withTransaction(ctx.pool, async (db) => {
      await upsertEditorUser(db, input);
      await audit(db, s.actor, 'editor.user', input);
    });
    return 'author';
  });

  action('/admin/editor/users/disable', 'editor', async (s, body) => {
    const disabled = body.disabled === '1';
    await withTransaction(ctx.pool, async (db) => {
      if (await setEditorUserDisabled(db, body.email ?? '', disabled))
        await audit(db, s.actor, disabled ? 'editor.user.disable' : 'editor.user.enable', {
          email: body.email,
        });
    });
    return 'author';
  });

  // ---- the first staff reader: one-time setup links ------------------------

  // Referrer-Policy stays same-origin (not no-referrer): browsers then send the Origin
  // header the POST is checked against, and the page links nowhere else.
  const setupPage = (reply: FastifyReply, status: number, body: string) =>
    reply
      .code(status)
      .headers(adminHeaders())
      .type('text/html; charset=utf-8')
      .send(simplePage('Admin setup', body, ADMIN_CSS));
  const badLink = (reply: FastifyReply) =>
    setupPage(
      reply,
      404,
      html`<h1>Link not valid</h1>
        <p>
          This setup link was already used, has expired, or is not one. Ask for a new one:
          <code>opend-server admin-link</code>.
        </p>`.value,
    );

  // ---- API keys ------------------------------------------------------------

  // Not an `action`: the new key's token is shown once in this response, never in a URL.
  app.post('/admin/api-keys', async (request, reply) => {
    const s = await staffOnly(request, reply);
    if (!s) return reply;
    if (!checkPost(request, s))
      return reply
        .code(403)
        .headers(adminHeaders())
        .type('text/html; charset=utf-8')
        .send(messagePage('Form expired', 'Reload the page and try again.'));
    try {
      const input = apiKeyInput(bodyOf(request), await listOrgs(ctx.pool));
      const created = await withTransaction(ctx.pool, async (db) => {
        const r = await createApiKey(db, { ...input, createdBy: s.actor });
        await audit(db, s.actor, 'api-key.create', {
          id: r.key.id,
          name: r.key.name,
          scopes: r.key.scopes,
          audience: r.key.audience,
          orgSlug: r.key.orgSlug,
        });
        return r;
      });
      return show(reply, s, 'api', null, 200, { name: created.key.name, token: created.token });
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      return show(reply, s, 'api', { kind: 'error', message: err.message }, 400);
    }
  });

  action('/admin/api-keys/revoke', 'api', async (s, body) => {
    const id = Number(body.id);
    await withTransaction(ctx.pool, async (db) => {
      if (Number.isSafeInteger(id) && (await revokeApiKey(db, id)))
        await audit(db, s.actor, 'api-key.revoke', { id });
    });
    return 'key-revoked';
  });

  app.get('/admin/setup', async (request, reply) => {
    const tokenValue = (request.query as { token?: unknown }).token;
    if (typeof tokenValue !== 'string' || !(await setupTokenValid(ctx.pool, tokenValue)))
      return badLink(reply);
    return setupPage(reply, 200, setupForm(tokenValue));
  });

  app.post('/admin/setup', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origin !== new URL(ctx.env.publicUrl).origin) return badLink(reply);
    const body = bodyOf(request);
    const tokenValue = body.token ?? '';
    const email = z.email().safeParse((body.email ?? '').trim());
    if (!email.success) {
      if (!(await setupTokenValid(ctx.pool, tokenValue))) return badLink(reply);
      return setupPage(reply, 400, setupForm(tokenValue, 'Give a valid email address.'));
    }
    const name = (body.name ?? '').trim() || null;
    const reader = await withTransaction(ctx.pool, async (db) => {
      // The token is used up in the same transaction that grants staff: it works exactly once.
      if (!(await consumeSetupToken(db, tokenValue))) return null;
      const existing = await findReaderByEmail(db, email.data);
      let r;
      if (existing) r = await setReaderStaff(db, existing.id, true);
      else {
        const orgs = await listOrgs(db);
        if (!orgs.some((o) => o.slug === 'staff'))
          await upsertOrg(db, { slug: 'staff', name: 'Staff' });
        r = await upsertReader(db, { orgSlug: 'staff', email: email.data, name, staff: true });
      }
      if (r) await audit(db, 'setup-link', 'admin.setup', { email: r.email, id: r.id });
      return r;
    });
    if (!reader) return badLink(reply);
    ctx.caches.entitlementsChanged();
    setSession(reply, ctx, reader.id);
    ctx.log({ level: 'info', msg: 'first staff reader set up', reader: reader.id });
    return reply.redirect('/admin?done=welcome', 303);
  });

  // Signed in from the managed service's account panel (admin-handoff.ts): staff,
  // or the site's owner there, who becomes staff. Each handoff works once.
  const adminToken = ctx.config.adminToken;
  if (adminToken)
    app.get(HANDOFF_PATH, async (request, reply) => {
      const token = (request.query as { token?: unknown }).token;
      const claims =
        typeof token === 'string' ? verifyHandoff(token, adminToken, ctx.env.publicUrl) : null;
      const refuse = (text: string) =>
        setupPage(
          reply,
          403,
          html`<h1>Could not sign you in</h1>
            <p>${text}</p>`.value,
        );
      if (!claims)
        return refuse(
          'This sign-in link has expired or is not valid. Open the admin again from your account.',
        );
      const reader = await withTransaction(ctx.pool, async (db) => {
        if (!(await useHandoff(db, claims.jti, new Date(claims.exp * 1000)))) return 'used';
        const existing = await findReaderByEmail(db, claims.email);
        if (existing?.staff) return existing;
        if (!claims.owner) return null;
        let r;
        if (existing) r = await setReaderStaff(db, existing.id, true);
        else {
          const orgs = await listOrgs(db);
          if (!orgs.some((o) => o.slug === 'staff'))
            await upsertOrg(db, { slug: 'staff', name: 'Staff' });
          r = await upsertReader(db, {
            orgSlug: 'staff',
            email: claims.email,
            name: null,
            staff: true,
          });
        }
        if (r) await audit(db, 'account-panel', 'admin.owner-staff', { email: r.email, id: r.id });
        return r ?? null;
      });
      if (reader === 'used')
        return refuse(
          'This sign-in link was already used. Open the admin again from your account.',
        );
      if (!reader)
        return refuse(`${claims.email} is not on this site’s staff. Ask its staff to add you.`);
      if (claims.owner) ctx.caches.entitlementsChanged();
      setSession(reply, ctx, reader.id);
      ctx.log({ level: 'info', msg: 'signed in from the account panel', reader: reader.id });
      return reply.redirect('/admin', 303);
    });
}

/** "OpenD docs.example.com", within GitHub's 34-character limit. */
export function defaultAppName(publicUrl: string): string {
  const host = new URL(publicUrl).hostname.replace(/^www\./, '');
  const name = `OpenD ${host}`;
  return name.length <= APP_NAME_MAX ? name : name.slice(0, APP_NAME_MAX).replace(/[.-]+$/, '');
}
