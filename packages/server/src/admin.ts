import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  audit,
  deleteOrg,
  deleteReader,
  enqueueJob,
  getJob,
  getRepo,
  listAudit,
  listJobs,
  listLiveReleases,
  listOrgs,
  listReaders,
  listRepos,
  setEntitlements,
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
});
const repoSchema = z.object({
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
  sourceUrl: z.string().min(1),
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
        const input = parse(repoSchema, request.body, reply);
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
    },
    { prefix: '/admin/api' },
  );
}
