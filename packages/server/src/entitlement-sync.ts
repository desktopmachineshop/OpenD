import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  SyncError,
  recordDelivery,
  syncEntitlements,
  syncEntitlementsInTransaction,
  withTransaction,
  type EntitlementSnapshot,
  type Pool,
  type SyncMode,
  type SyncResult,
} from '@opend/store';
import { authorized, entitlementsSchema, parse, slug } from './admin.js';
import type { AppContext } from './context.js';

/**
 * Customer and licence data from billing or a CRM: a snapshot through the
 * admin API, signed change events or snapshots through a webhook, and a
 * nightly reconcile against an export URL.
 */

const readerSchema = z.union([
  z.email(),
  z.object({ email: z.email(), name: z.string().min(1).nullable().optional() }),
]);

const orgSchema = z.object({
  slug,
  name: z.string().min(1),
  entitlements: entitlementsSchema.nullable().optional(),
  readers: z.array(readerSchema).optional(),
});

/** `{ orgs: [{ slug, name, entitlements?, readers? }] }`, as a CRM export provides it. */
export const snapshotSchema = z.object({ orgs: z.array(orgSchema) });

const modeSchema = z.enum(['merge', 'replace']).default('merge');

const adminSyncSchema = snapshotSchema
  .extend({
    mode: modeSchema,
    dryRun: z.boolean().default(false),
    confirmReplace: z.boolean().optional(),
  })
  .refine((b) => b.mode !== 'replace' || b.dryRun || b.confirmReplace === true, {
    message:
      'mode "replace" removes every org and reader not in the snapshot: set confirmReplace: true, or dryRun: true to preview',
    path: ['confirmReplace'],
  });

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('org.upsert'), org: orgSchema, exactReaders: z.boolean().optional() }),
  z.object({ type: z.literal('org.delete'), slug }),
  z.object({
    type: z.literal('reader.add'),
    org: slug,
    email: z.email(),
    name: z.string().min(1).nullable().optional(),
  }),
  z.object({ type: z.literal('reader.remove'), email: z.email() }),
]);

/** Webhook body: change events, or a snapshot (`replace` only when asked for explicitly). */
export const entitlementWebhookSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('events'), events: z.array(eventSchema).min(1) }),
  snapshotSchema.extend({ type: z.literal('snapshot'), mode: modeSchema }),
]);

/** Accepted clock skew between the CRM and this server, and the replay window. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** `sha256=<hex>` over `<timestamp>.<raw body>`, so the timestamp cannot be swapped. */
export function signEntitlementPayload(
  secret: string,
  timestamp: string,
  body: string | Buffer,
): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return `sha256=${mac}`;
}

export type SignatureCheck = 'ok' | 'invalid' | 'stale';

/** Checks `X-OpenD-Signature` and `X-OpenD-Timestamp` in constant time. */
export function verifyEntitlementSignature(
  secret: string,
  body: Buffer,
  headers: { signature?: string; timestamp?: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): SignatureCheck {
  const { signature, timestamp } = headers;
  if (!signature?.startsWith('sha256=') || !timestamp || !/^\d{1,12}$/.test(timestamp)) {
    return 'invalid';
  }
  const expected = Buffer.from(signEntitlementPayload(secret, timestamp, body));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
  // Checked after the signature, so an unsigned request learns nothing about the clock.
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return 'stale';
  return 'ok';
}

function sendSyncError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (!(err instanceof SyncError)) return null;
  return reply.code(422).send({ error: err.message });
}

export function registerEntitlementSync(app: FastifyInstance, ctx: AppContext): void {
  const adminToken = ctx.config.adminToken;
  if (adminToken) {
    app.register(
      async (scope) => {
        scope.addHook('onRequest', async (request, reply) => {
          if (!authorized(request, adminToken))
            return reply.code(401).send({ error: 'unauthorized' });
        });
        scope.put('/entitlements/sync', async (request, reply) => {
          const input = parse(adminSyncSchema, request.body, reply);
          if (!input) return reply;
          const { mode, dryRun, orgs } = input;
          try {
            const result = await syncEntitlements(
              ctx.pool,
              { snapshot: { orgs }, mode },
              { actor: 'admin-token', source: 'admin-api', dryRun },
            );
            if (!dryRun) ctx.caches.entitlementsChanged();
            return reply.send(result);
          } catch (err) {
            return sendSyncError(reply, err) ?? Promise.reject(err);
          }
        });
      },
      { prefix: '/admin/api' },
    );
  }

  app.register(async (scope) => {
    // The signature covers the raw bytes, so keep the body as a buffer here.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    scope.post('/webhooks/entitlements', async (request, reply) => {
      const secret = ctx.config.selfHosting?.entitlementWebhookSecret;
      if (!secret)
        return reply.code(503).send({ error: 'entitlement webhooks are not configured' });
      const body = request.body;
      if (!Buffer.isBuffer(body))
        return reply.code(415).send({ error: 'expected application/json' });
      const signature = request.headers['x-opend-signature'] as string | undefined;
      const check = verifyEntitlementSignature(secret, body, {
        signature,
        timestamp: request.headers['x-opend-timestamp'] as string | undefined,
      });
      if (check === 'stale') return reply.code(401).send({ error: 'timestamp outside tolerance' });
      if (check !== 'ok') return reply.code(401).send({ error: 'invalid signature' });
      const key = String(request.headers['idempotency-key'] ?? '');
      if (!/^[\x21-\x7e]{1,200}$/.test(key))
        return reply.code(400).send({ error: 'missing or invalid Idempotency-Key' });

      let json: unknown;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'invalid JSON' });
      }
      const payload = parse(entitlementWebhookSchema, json, reply);
      if (!payload) return reply;

      try {
        // The key and the signature are recorded with the change, so a failed
        // attempt can be retried and a repeated one changes nothing. The key is
        // not signed, so the signature (over the timestamp and body) is what
        // stops a captured request being replayed under a fresh key within the
        // timestamp window.
        const result = await withTransaction(ctx.pool, async (db) => {
          // Namespaced so neither can collide with a GitHub delivery id.
          if (!(await recordDelivery(db, `entitlements-signature:${signature}`, 'entitlements')))
            return null;
          if (!(await recordDelivery(db, `entitlements:${key}`, 'entitlements'))) return null;
          return syncEntitlementsInTransaction(
            db,
            payload.type === 'events'
              ? { events: payload.events }
              : { snapshot: { orgs: payload.orgs }, mode: payload.mode },
            { actor: 'entitlement-webhook', source: `webhook:${key}` },
          );
        });
        if (!result) return reply.send({ status: 'duplicate' });
        ctx.caches.entitlementsChanged();
        ctx.log({
          level: 'info',
          msg: 'entitlements synced',
          source: 'webhook',
          key,
          ...result.summary,
        });
        return reply.send({ status: 'applied', mode: result.mode, summary: result.summary });
      } catch (err) {
        return sendSyncError(reply, err) ?? Promise.reject(err);
      }
    });
  });
}

export interface ReconcileOptions {
  url: string;
  token?: string;
  mode: SyncMode;
  dryRun?: boolean;
  /** Apply an export with no orgs. Off by default: an empty export is more likely a CRM fault. */
  allowEmpty?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The export URL without credentials or query string, safe for the audit log. */
export function redactUrl(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

/** Fetches and validates a snapshot from a CRM or billing export. */
export async function fetchSnapshot(options: ReconcileOptions): Promise<EntitlementSnapshot> {
  const res = await (options.fetchImpl ?? fetch)(options.url, {
    headers: {
      accept: 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new Error(`${redactUrl(options.url)} returned ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${redactUrl(options.url)} did not return JSON`);
  }
  const parsed = snapshotSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 20)
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid snapshot from ${redactUrl(options.url)}:\n${problems}`);
  }
  return parsed.data;
}

/** Fetches a snapshot and applies it: `opend-server reconcile`, typically run nightly. */
export async function reconcile(pool: Pool, options: ReconcileOptions): Promise<SyncResult> {
  const snapshot = await fetchSnapshot(options);
  if (options.mode === 'replace' && snapshot.orgs.length === 0 && !options.allowEmpty) {
    throw new Error(
      `${redactUrl(options.url)} returned no orgs; refusing to apply it (use --allow-empty if that is intended)`,
    );
  }
  return syncEntitlements(
    pool,
    { snapshot, mode: options.mode },
    { actor: 'reconcile', source: redactUrl(options.url), dryRun: options.dryRun === true },
  );
}
