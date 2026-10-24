import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  RELEASE_LINES,
  pdfTemplateSchema,
  resolvePdfTemplate,
  siteThemeSchema,
  type ReleaseLines,
} from '@opend/model';
import { releaseLine } from '@opend/filter';
import {
  setRepoReleaseLines,
  SETTING,
  deleteSetting,
  putSetting,
  API_SCOPES,
  analyticsSummary,
  audit,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  countStaffReaders,
  createSetupToken,
  deleteOrg,
  deleteReader,
  enqueueJob,
  exportSite,
  importSite,
  ImportRefused,
  type SiteExport,
  getJob,
  getRepo,
  listAudit,
  listFeedback,
  listJobs,
  listLiveReleases,
  retireReleaseLine,
  listOrgs,
  listReaders,
  listRepos,
  setEntitlements,
  setReaderStaff,
  setRepoAccess,
  setRepoVersionPicker,
  upsertOrg,
  upsertReader,
  upsertRepo,
  withTransaction,
  type Pool,
} from '@opend/store';
import { accentProblem, appearance } from './appearance.js';
import type { AppContext } from './context.js';
import { settingSources } from './settings.js';

const ACTOR = 'admin-token';

/**
 * `PUT /admin/api/appearance`: each of `theme` and `pdf` is left as it is
 * when absent, reset with `null`, or replaced. `pdf` may be partial: the
 * named built-in template fills in the rest.
 */
const appearanceSchema = z.object({
  theme: siteThemeSchema.nullable().optional(),
  pdf: pdfTemplateSchema.partial().nullable().optional(),
});
export const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes');
const token = z.string().regex(/^[A-Za-z0-9_.:-]+$/);

export const entitlementsSchema = z.object({
  products: z.array(token).default([]),
  features: z.array(token).default([]),
  version: z.string().regex(/^v?\d+(\.\d+)*$/, 'a version such as 1.4'),
});

const pickerVersion = z
  .string()
  .max(32)
  .regex(/^v?\d+(\.\d+)*$/, 'a version such as 2.1');

/**
 * The site's version picker: `off` (no picker), `reader` (show each reader
 * their own version), `fixed` (every reader gets `version`) or `list`
 * (readers choose among `versions`, and their own).
 */
export const versionPickerSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }),
  z.object({ mode: z.literal('reader') }),
  z.object({ mode: z.literal('fixed'), version: pickerVersion }),
  z.object({
    mode: z.literal('list'),
    versions: z
      .array(pickerVersion)
      .min(1)
      .max(50)
      .transform((vs) => [...new Set(vs)]),
  }),
]);

const orgSchema = z.object({
  slug,
  name: z.string().min(1),
  entitlements: entitlementsSchema.optional(),
});
const readerSchema = z.object({
  orgSlug: slug,
  email: z.email(),
  name: z.string().min(1).optional(),
  /** Omitted: keep (new readers: not staff). */
  staff: z.boolean().optional(),
});
const staffSchema = z.object({ staff: z.boolean() });

/**
 * Who may read a site. `publicEntitlements` is what anonymous visitors of a
 * public site see: omitted keeps the current set, `null` clears it (then they
 * see only unconditioned content).
 */
export const accessSchema = z.object({
  access: z.enum(['private', 'public']),
  publicEntitlements: entitlementsSchema.nullable().optional(),
});
function urlWithProtocol(value: string, protocol: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === protocol && (protocol === 'file:' || url.hostname !== '');
  } catch {
    return false;
  }
}

/**
 * Where the worker may fetch a repository from: an `https://` clone URL, or,
 * outside production (tests and local trials), an absolute local path or a
 * `file:` URL. Other schemes (`http`, `ssh`, `ext::`) and relative paths are
 * refused.
 */
export function sourceUrlSchema(production: boolean) {
  return z
    .string()
    .refine(
      (v) =>
        urlWithProtocol(v, 'https:') ||
        (!production && (v.startsWith('/') || urlWithProtocol(v, 'file:'))),
      production
        ? 'an https:// clone URL'
        : 'an https:// clone URL, or a local path or file: URL outside production',
    );
}

/** How a repo groups releases into lines: `major` (the default) or `minor`. */
export const releaseLinesSchema = z.object({ releaseLines: z.enum(RELEASE_LINES) });

/**
 * Switches a repo's release-line granularity and moves its live releases to
 * their new lines, in the caller's transaction (see `setRepoReleaseLines`).
 * Null when the repo does not exist.
 */
export async function changeReleaseLines(
  db: Parameters<typeof setRepoReleaseLines>[0],
  repoId: number,
  lines: ReleaseLines,
  actor: string,
) {
  const result = await setRepoReleaseLines(db, repoId, lines, (v) => releaseLine(v, lines));
  if (result?.changed)
    await audit(db, actor, 'repo.release-lines', {
      repo: result.repo.fullName,
      releaseLines: lines,
    });
  return result?.repo ?? null;
}

export const repoSchema = (production: boolean) =>
  z.object({
    fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
    sourceUrl: sourceUrlSchema(production),
    installationId: z.number().int().positive().nullable().optional(),
    releaseRefs: z.array(z.string().min(1)).min(1).optional(),
    docsPath: z
      .string()
      .refine(
        (p) => !p.startsWith('/') && !p.split('/').includes('..'),
        'a path inside the repository',
      )
      .optional(),
    /** Omitted: keep the repo's release lines (new repos: major). */
    releaseLines: z.enum(RELEASE_LINES).optional(),
  });
const analyticsQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(30),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
  org: slug.optional(),
});
const feedbackQuery = analyticsQuery.extend({
  topic: z.string().min(1).optional(),
  comments: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  limit: z.coerce.number().int().min(1).max(10_000).default(100),
});

/** One CSV field: quoted, and defused so spreadsheets do not run it as a formula. */
export function csvField(value: unknown): string {
  let text = value instanceof Date ? value.toISOString() : String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const apiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.enum(API_SCOPES)).min(1),
    audience: z.enum(['staff', 'org', 'public']),
    org: slug.optional(),
    expiresInDays: z.number().int().min(1).max(3650).nullable().default(90),
  })
  .refine((k) => (k.audience === 'org') === (k.org !== undefined), {
    message: 'org is required for (and only for) the org audience',
    path: ['org'],
  });

const setupLinkSchema = z.object({
  minutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
});

/**
 * A one-time link that makes its visitor the first staff reader. Refused once
 * a staff reader exists (unless `force`), so it cannot quietly add more.
 */
export async function mintSetupLink(
  pool: Pool,
  publicUrl: string,
  options: { minutes: number; actor: string; force?: boolean },
): Promise<{ url: string; expiresAt: Date } | null> {
  if (!options.force && (await countStaffReaders(pool)) > 0) return null;
  return withTransaction(pool, async (db) => {
    const { token, expiresAt } = await createSetupToken(db, options);
    await audit(db, options.actor, 'admin.setup-link', {
      expiresAt,
      force: options.force === true,
    });
    return { url: `${publicUrl}/admin/setup?token=${token}`, expiresAt };
  });
}

const buildSchema = z.object({
  ref: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{40}$/, 'a full commit sha'),
});

export function authorized(request: FastifyRequest, expected: string): boolean {
  const header = request.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function parse<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  void reply.code(400).send({
    error: 'invalid request',
    issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
  return null;
}

/**
 * Admin API for staff tooling, behind a bearer token until the staff login
 * arrives with the editor. Every change is written to the audit log.
 */
export function registerAdmin(app: FastifyInstance, ctx: AppContext): void {
  const adminToken = ctx.config.adminToken;
  if (!adminToken) return; // routes do not exist without a token

  app.register(
    async (scope) => {
      scope.addHook('onRequest', async (request, reply) => {
        if (!authorized(request, adminToken))
          return reply.code(401).send({ error: 'unauthorized' });
      });

      scope.get('/repos', async () => listRepos(ctx.pool));
      scope.post('/repos', async (request, reply) => {
        const input = parse(repoSchema(ctx.config.production), request.body, reply);
        if (!input) return reply;
        const repo = await withTransaction(ctx.pool, async (db) => {
          const { releaseLines, ...fields } = input;
          const r = await upsertRepo(db, fields);
          await audit(db, ACTOR, 'repo.upsert', input);
          return releaseLines ? await changeReleaseLines(db, r.id, releaseLines, ACTOR) : r;
        });
        ctx.caches.releaseChanged();
        return reply.code(201).send(repo);
      });
      scope.post('/repos/:id/builds', async (request, reply) => {
        const repo = await getRepo(ctx.pool, Number((request.params as { id: string }).id));
        if (!repo) return reply.code(404).send({ error: 'no such repo' });
        const input = parse(buildSchema, request.body, reply);
        if (!input) return reply;
        const job = await withTransaction(ctx.pool, async (db) => {
          const j = await enqueueJob(db, { repoId: repo.id, ...input });
          await audit(db, ACTOR, 'build.request', { repo: repo.fullName, ...input, job: j.id });
          return j;
        });
        return reply.code(202).send(job);
      });
      scope.put('/repos/:id/access', async (request, reply) => {
        const id = Number((request.params as { id: string }).id);
        const input = parse(accessSchema, request.body, reply);
        if (!input) return reply;
        const repo = await withTransaction(ctx.pool, async (db) => {
          const current = Number.isInteger(id) ? await getRepo(db, id) : null;
          if (!current) return null;
          const pub =
            input.publicEntitlements === undefined
              ? current.publicEntitlements
              : input.publicEntitlements;
          const r = await setRepoAccess(db, id, input.access, pub);
          await audit(db, ACTOR, 'repo.access', {
            repo: current.fullName,
            access: input.access,
            publicEntitlements: pub,
          });
          return r;
        });
        // Every cached view, page and publication is dropped; NOTIFY does the same on other replicas.
        ctx.caches.releaseChanged();
        return repo ? reply.send(repo) : reply.code(404).send({ error: 'no such repo' });
      });
      scope.put('/repos/:id/versions', async (request, reply) => {
        const id = Number((request.params as { id: string }).id);
        const picker = parse(versionPickerSchema, request.body, reply);
        if (!picker) return reply;
        const repo = await withTransaction(ctx.pool, async (db) => {
          const current = Number.isInteger(id) ? await getRepo(db, id) : null;
          if (!current) return null;
          const r = await setRepoVersionPicker(db, id, picker);
          await audit(db, ACTOR, 'repo.versions', {
            repo: current.fullName,
            versionPicker: picker,
          });
          return r;
        });
        // Pages show the picker, and readers may now be on another version: drop every cache.
        ctx.caches.releaseChanged();
        return repo ? reply.send(repo) : reply.code(404).send({ error: 'no such repo' });
      });
      scope.put('/repos/:id/release-lines', async (request, reply) => {
        const id = Number((request.params as { id: string }).id);
        const input = parse(releaseLinesSchema, request.body, reply);
        if (!input) return reply;
        const repo = Number.isSafeInteger(id)
          ? await withTransaction(ctx.pool, (db) =>
              changeReleaseLines(db, id, input.releaseLines, ACTOR),
            )
          : null;
        // Live releases may have moved to other lines: drop every cache.
        ctx.caches.releaseChanged();
        return repo ? reply.send(repo) : reply.code(404).send({ error: 'no such repo' });
      });
      scope.get('/repos/:id/releases', async (request) =>
        listLiveReleases(ctx.pool, Number((request.params as { id: string }).id)),
      );
      scope.delete('/repos/:id/releases/:line', async (request, reply) => {
        const params = request.params as { id: string; line: string };
        const id = Number(params.id);
        const found = await withTransaction(ctx.pool, async (db) => {
          const ok = Number.isInteger(id) && (await retireReleaseLine(db, id, params.line));
          if (ok)
            await audit(db, ACTOR, 'release.retire', { repoId: id, releaseLine: params.line });
          return ok;
        });
        ctx.caches.releaseChanged();
        return found
          ? reply.code(204).send()
          : reply.code(404).send({ error: 'no such live release line' });
      });

      scope.get('/builds', async (request) => {
        const q = request.query as { repoId?: string; limit?: string };
        const options: { repoId?: number; limit?: number } = {};
        if (q.repoId) options.repoId = Number(q.repoId);
        if (q.limit) options.limit = Math.min(200, Number(q.limit));
        return listJobs(ctx.pool, options);
      });
      scope.get('/builds/:id', async (request, reply) => {
        const job = await getJob(ctx.pool, Number((request.params as { id: string }).id));
        return job ?? reply.code(404).send({ error: 'no such build' });
      });

      scope.get('/orgs', async () => listOrgs(ctx.pool));
      scope.post('/orgs', async (request, reply) => {
        const input = parse(orgSchema, request.body, reply);
        if (!input) return reply;
        await withTransaction(ctx.pool, async (db) => {
          await upsertOrg(db, input);
          if (input.entitlements) await setEntitlements(db, input.slug, input.entitlements);
          await audit(db, ACTOR, 'org.upsert', input);
        });
        ctx.caches.entitlementsChanged();
        return reply.code(201).send({ slug: input.slug });
      });
      scope.put('/orgs/:slug/entitlements', async (request, reply) => {
        const orgSlug = (request.params as { slug: string }).slug;
        const input = parse(entitlementsSchema, request.body, reply);
        if (!input) return reply;
        const found = await withTransaction(ctx.pool, async (db) => {
          const ok = await setEntitlements(db, orgSlug, input);
          if (ok) await audit(db, ACTOR, 'entitlements.set', { org: orgSlug, ...input });
          return ok;
        });
        ctx.caches.entitlementsChanged();
        return found
          ? reply.send({ slug: orgSlug, ...input })
          : reply.code(404).send({ error: 'no such org' });
      });
      scope.delete('/orgs/:slug', async (request, reply) => {
        const orgSlug = (request.params as { slug: string }).slug;
        const found = await withTransaction(ctx.pool, async (db) => {
          const ok = await deleteOrg(db, orgSlug);
          if (ok) await audit(db, ACTOR, 'org.delete', { org: orgSlug });
          return ok;
        });
        ctx.caches.entitlementsChanged();
        return found ? reply.code(204).send() : reply.code(404).send({ error: 'no such org' });
      });

      scope.get('/readers', async () => listReaders(ctx.pool));
      scope.post('/readers', async (request, reply) => {
        const input = parse(readerSchema, request.body, reply);
        if (!input) return reply;
        const reader = await withTransaction(ctx.pool, async (db) => {
          const r = await upsertReader(db, input);
          if (r) await audit(db, ACTOR, 'reader.upsert', input);
          return r;
        });
        ctx.caches.entitlementsChanged();
        return reader
          ? reply.code(201).send(reader)
          : reply.code(404).send({ error: 'no such org' });
      });
      scope.put('/readers/:id/staff', async (request, reply) => {
        const id = Number((request.params as { id: string }).id);
        const input = parse(staffSchema, request.body, reply);
        if (!input) return reply;
        const reader = await withTransaction(ctx.pool, async (db) => {
          const r = Number.isInteger(id) ? await setReaderStaff(db, id, input.staff) : null;
          if (r) await audit(db, ACTOR, 'reader.staff', { id, email: r.email, staff: input.staff });
          return r;
        });
        ctx.caches.entitlementsChanged();
        return reader ? reply.send(reader) : reply.code(404).send({ error: 'no such reader' });
      });
      scope.delete('/readers/:id', async (request, reply) => {
        const id = Number((request.params as { id: string }).id);
        const found = await withTransaction(ctx.pool, async (db) => {
          const ok = await deleteReader(db, id);
          if (ok) await audit(db, ACTOR, 'reader.delete', { id });
          return ok;
        });
        ctx.caches.entitlementsChanged();
        return found ? reply.code(204).send() : reply.code(404).send({ error: 'no such reader' });
      });

      scope.get('/audit', async () => listAudit(ctx.pool));

      // Moving the site to another deployment (shared fleet → dedicated). The
      // export holds sealed secrets, API key hashes and readers: admin token only.
      scope.get('/export', async () => exportSite(ctx.pool));
      scope.post('/import', { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
        let counts: Record<string, number>;
        try {
          counts = await withTransaction(ctx.pool, async (db) => {
            const c = await importSite(db, request.body as SiteExport);
            await audit(db, ACTOR, 'site.import', { rows: c });
            return c;
          });
        } catch (err) {
          if (err instanceof ImportRefused) return reply.code(409).send({ error: err.message });
          throw err;
        }
        await ctx.reloadSettings();
        ctx.caches.releaseChanged();
        ctx.caches.entitlementsChanged();
        // Releases are not copied: request builds (POST /repos/:id/builds) or let the poller run.
        return reply.code(201).send({ imported: counts });
      });

      // The admin console's settings. Secrets are never returned: only whether each is set.
      scope.get('/settings', async () => {
        const snap = ctx.settings.current;
        return {
          values: snap.values,
          secrets: Object.fromEntries(Object.keys(snap.secrets).map((name) => [name, 'set'])),
          unreadable: snap.unreadable,
          sources: settingSources(ctx.env, snap),
          github: ctx.github.mode(),
        };
      });
      scope.post('/setup-links', async (request, reply) => {
        const input = parse(setupLinkSchema, request.body ?? {}, reply);
        if (!input) return reply;
        const link = await mintSetupLink(ctx.pool, ctx.env.publicUrl, {
          minutes: input.minutes,
          actor: ACTOR,
        });
        return link
          ? reply.code(201).send(link)
          : reply.code(409).send({ error: 'a staff reader exists; sign in as staff instead' });
      });

      // Site theme and PDF template, as on the console's Appearance page.
      const appearanceState = () => {
        const a = appearance(ctx);
        return { theme: a.theme, pdf: a.pdf, version: a.version };
      };
      scope.get('/appearance', async () => appearanceState());
      scope.put('/appearance', async (request, reply) => {
        const input = parse(appearanceSchema, request.body ?? {}, reply);
        if (!input) return reply;
        const problem = input.theme ? accentProblem(input.theme) : null;
        if (problem) return reply.code(400).send({ error: 'invalid request', issues: [problem] });
        const changes: [string, unknown][] = [];
        if (input.theme !== undefined) changes.push([SETTING.siteTheme, input.theme]);
        if (input.pdf !== undefined)
          changes.push([SETTING.pdfTemplate, input.pdf && resolvePdfTemplate(input.pdf)]);
        await withTransaction(ctx.pool, async (db) => {
          for (const [key, value] of changes) {
            if (value === null) await deleteSetting(db, key);
            else await putSetting(db, key, value, ACTOR);
            await audit(db, ACTOR, `settings.${key}`, value === null ? { reset: true } : value);
          }
        });
        await ctx.reloadSettings();
        return appearanceState();
      });

      // Public API keys (/api/v1). The token is in the creation response only.
      scope.get('/api-keys', async () => listApiKeys(ctx.pool));
      scope.post('/api-keys', async (request, reply) => {
        const input = parse(apiKeySchema, request.body ?? {}, reply);
        if (!input) return reply;
        if (input.org && !(await listOrgs(ctx.pool)).some((o) => o.slug === input.org))
          return reply.code(404).send({ error: 'no such org' });
        const created = await withTransaction(ctx.pool, async (db) => {
          const r = await createApiKey(db, {
            name: input.name,
            scopes: input.scopes,
            audience: input.audience,
            orgSlug: input.org ?? null,
            createdBy: ACTOR,
            expiresAt:
              input.expiresInDays === null
                ? null
                : new Date(Date.now() + input.expiresInDays * 86_400_000),
          });
          await audit(db, ACTOR, 'api-key.create', {
            id: r.key.id,
            name: r.key.name,
            scopes: r.key.scopes,
            audience: r.key.audience,
            orgSlug: r.key.orgSlug,
          });
          return r;
        });
        return reply.code(201).send({ ...created.key, token: created.token });
      });
      scope.delete('/api-keys/:id', async (request, reply) => {
        const id = Number((request.params as { id: string }).id);
        const revoked = await withTransaction(ctx.pool, async (db) => {
          const ok = Number.isSafeInteger(id) && (await revokeApiKey(db, id));
          if (ok) await audit(db, ACTOR, 'api-key.revoke', { id });
          return ok;
        });
        return revoked ? reply.code(204).send() : reply.code(404).send({ error: 'no such key' });
      });

      // Analytics: read-only, and still readable after OPEND_ANALYTICS=0 stops recording.
      const feedbackFilter = (q: z.infer<typeof feedbackQuery>) => ({
        days: q.days,
        limit: q.limit,
        withComment: q.comments,
        ...(q.org ? { orgSlug: q.org } : {}),
        ...(q.topic ? { topicId: q.topic } : {}),
      });
      scope.get('/analytics/summary', async (request, reply) => {
        const q = parse(analyticsQuery, request.query, reply);
        if (!q) return reply;
        const summary = await analyticsSummary(ctx.pool, {
          days: q.days,
          limit: q.limit,
          ...(q.org ? { orgSlug: q.org } : {}),
        });
        return { enabled: ctx.analytics.enabled, ...summary };
      });
      scope.get('/analytics/feedback', async (request, reply) => {
        const q = parse(feedbackQuery, request.query, reply);
        if (!q) return reply;
        return listFeedback(ctx.pool, feedbackFilter(q));
      });
      scope.get('/analytics/feedback.csv', async (request, reply) => {
        const q = parse(feedbackQuery, request.query, reply);
        if (!q) return reply;
        const rows = await listFeedback(ctx.pool, feedbackFilter(q));
        const header = ['at', 'topic', 'helpful', 'comment', 'surface', 'org', 'release_line'];
        const lines = [
          header.join(','),
          ...rows.map((r) =>
            [
              r.at,
              r.topicId,
              r.helpful ? 'yes' : 'no',
              r.comment,
              r.surface,
              r.orgSlug,
              r.releaseLine,
            ]
              .map(csvField)
              .join(','),
          ),
        ];
        return reply
          .headers({
            'content-disposition': 'attachment; filename="opend-feedback.csv"',
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
          })
          .type('text/csv; charset=utf-8')
          .send(`${lines.join('\r\n')}\r\n`);
      });
    },
    { prefix: '/admin/api' },
  );
}
