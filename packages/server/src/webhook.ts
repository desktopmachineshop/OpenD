import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  enqueueJob,
  findRepoByName,
  recordDelivery,
  refMatches,
  withTransaction,
} from '@opend/store';
import type { AppContext } from './context.js';

/** Verifies GitHub's `X-Hub-Signature-256` header in constant time. */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `refs/heads/main` → `main`, `refs/tags/v1` → `v1`. */
export function shortRef(ref: string): string | null {
  const m = /^refs\/(?:heads|tags)\/(.+)$/.exec(ref);
  return m?.[1] ?? null;
}

interface PushPayload {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
}

/**
 * GitHub webhook receiver. It only verifies, records and queues: the build runs
 * in the worker, so a slow or failing build never times out GitHub's request.
 */
export function registerWebhook(app: FastifyInstance, ctx: AppContext): void {
  app.register(async (scope) => {
    // The signature covers the raw bytes, so keep the body as a buffer here.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    scope.post('/webhooks/github', async (request, reply) => {
      const secret = ctx.config.webhookSecret;
      if (!secret) return reply.code(503).send({ error: 'webhooks are not configured' });
      const body = request.body;
      if (!Buffer.isBuffer(body))
        return reply.code(415).send({ error: 'expected application/json' });
      if (
        !verifySignature(secret, body, request.headers['x-hub-signature-256'] as string | undefined)
      ) {
        return reply.code(401).send({ error: 'invalid signature' });
      }
      const event = String(request.headers['x-github-event'] ?? '');
      const delivery = String(request.headers['x-github-delivery'] ?? '');
      if (!delivery) return reply.code(400).send({ error: 'missing X-GitHub-Delivery' });

      let payload: PushPayload;
      try {
        payload = JSON.parse(body.toString('utf8')) as PushPayload;
      } catch {
        return reply.code(400).send({ error: 'invalid JSON' });
      }

      // Recording the delivery and queueing the build commit together, so a
      // redelivery after a failure here is not mistaken for a duplicate. The
      // response is sent only after the commit, so 202 means the job exists.
      const [code, result] = await withTransaction(
        ctx.pool,
        async (db): Promise<[number, Record<string, unknown>]> => {
          if (!(await recordDelivery(db, delivery, event))) return [200, { status: 'duplicate' }];
          if (event === 'ping') return [200, { status: 'pong' }];
          if (event !== 'push') return [202, { status: 'ignored', reason: `event ${event}` }];
          // GitHub's signature covers the body but not X-GitHub-Delivery, so a
          // captured push could be resent under a new delivery id to queue an
          // old commit again and roll its release line back. Every real push
          // has a different body, so the same signed body is only acted on once.
          const digest = createHash('sha256').update(body).digest('hex');
          if (!(await recordDelivery(db, `github-push-body:${digest}`, event)))
            return [200, { status: 'duplicate' }];

          const ref = payload.ref ? shortRef(payload.ref) : null;
          const sha = payload.after ?? '';
          const fullName = payload.repository?.full_name ?? '';
          if (payload.deleted || !ref || !/^[0-9a-f]{40}$/.test(sha)) {
            return [202, { status: 'ignored', reason: 'not a branch or tag update' }];
          }
          const repo = await findRepoByName(db, fullName);
          if (!repo) return [202, { status: 'ignored', reason: 'repository not registered' }];
          if (!refMatches(repo.releaseRefs, ref)) {
            return [202, { status: 'ignored', reason: `ref ${ref} does not publish` }];
          }
          const job = await enqueueJob(db, { repoId: repo.id, ref, sha });
          ctx.log({
            level: 'info',
            msg: 'build queued',
            job: job.id,
            repo: repo.fullName,
            ref,
            sha,
            delivery,
          });
          return [202, { status: 'queued', job: job.id }];
        },
      );
      return reply.code(code).send(result);
    });
  });
}
