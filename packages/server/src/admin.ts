import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  analyticsSummary,
  audit,
  deleteOrg,
  deleteReader,
  enqueueJob,
  getJob,
  getRepo,
  listAudit,
  listFeedback,
  listJobs,
  listLiveReleases,
  listOrgs,
  listReaders,
  listRepos,
  setEntitlements,
  setReaderStaff,
  setRepoAccess,
  upsertOrg,
  upsertReader,
  upsertRepo,
  withTransaction,
} from '@opend/store';
import type { AppContext } from './context.js';

const ACTOR = 'admin-token';
export const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes');
const token = z.string().regex(/^[A-Za-z0-9_.:-]+$/);

export const entitlementsSchema = z.object({
  products: z.array(token).default([]),
  features: z.array(token).default([]),
  version: z.string().regex(/^v?\d+(\.\d+)*$/, 'a version such as 1.4'),
});

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

const repoSchema = (production: boolean) =>
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
          const r = await upsertRepo(db, input);
          await audit(db, ACTOR, 'repo.upsert', input);
          return r;
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
      scope.get('/repos/:id/releases', async (request) =>
        listLiveReleases(ctx.pool, Number((request.params as { id: string }).id)),
      );

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
