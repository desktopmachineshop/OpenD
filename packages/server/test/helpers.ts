import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { PdfRenderer } from '@opend/pdf';
import { FsBlobStore, createTestDatabase, type TestDatabase } from '@opend/store';
import type { OidcProvider } from '../src/index.js';
import { createApp, type OpendApp, type ServerConfig } from '../src/index.js';

export const STARTER = join(import.meta.dirname, '../../../templates/docs-starter');
export const WEBHOOK_SECRET = 'webhook-secret';
export const ADMIN_TOKEN = 'admin-token-0123456789abcdef';

export interface Harness extends OpendApp {
  db: TestDatabase;
  blobDir: string;
  close(): Promise<void>;
}

export async function startHarness(
  url: string,
  options: {
    oidc?: OidcProvider | null;
    config?: Partial<ServerConfig>;
    pdf?: PdfRenderer;
    githubFetch?: typeof fetch;
    hostingFetch?: typeof fetch;
  } = {},
): Promise<Harness> {
  const db = await createTestDatabase(url);
  const blobDir = mkdtempSync(join(tmpdir(), 'opend-server-blobs-'));
  const config: ServerConfig = {
    databaseUrl: db.url,
    publicUrl: 'http://docs.test',
    port: 0,
    host: '127.0.0.1',
    sessionSecret: 'test-session-secret-0123456789abcdef',
    webhookSecret: WEBHOOK_SECRET,
    blobs: { kind: 'fs', dir: blobDir },
    adminToken: ADMIN_TOKEN,
    devLogin: true,
    production: false,
    ...options.config,
  };
  const deps: Parameters<typeof createApp>[1] = {
    pool: db.pool,
    blobs: new FsBlobStore(blobDir),
    log: () => {},
  };
  if (options.oidc !== undefined) deps.oidc = options.oidc;
  if (options.pdf) deps.pdf = options.pdf;
  if (options.githubFetch) deps.githubFetch = options.githubFetch;
  if (options.hostingFetch) deps.hostingFetch = options.hostingFetch;
  const opend = await createApp(config, deps);
  await opend.app.ready();
  return {
    ...opend,
    db,
    blobDir,
    close: async () => {
      await opend.app.close();
      await db.drop();
      rmSync(blobDir, { recursive: true, force: true });
    },
  };
}

export function pushPayload(fullName: string, ref: string, sha: string) {
  return JSON.stringify({ ref, after: sha, deleted: false, repository: { full_name: fullName } });
}

export function webhook(
  app: FastifyInstance,
  body: string,
  options: { secret?: string; delivery?: string; event?: string } = {},
) {
  const signature = `sha256=${createHmac('sha256', options.secret ?? WEBHOOK_SECRET)
    .update(body)
    .digest('hex')}`;
  return app.inject({
    method: 'POST',
    url: '/webhooks/github',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': options.event ?? 'push',
      'x-github-delivery': options.delivery ?? randomUUID(),
      'x-hub-signature-256': signature,
    },
  });
}

export function admin(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) {
  const request: Parameters<FastifyInstance['inject']>[0] = {
    method,
    url: `/admin/api${url}`,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  };
  if (payload) request.payload = payload;
  return app.inject(request);
}

/** The `name=value` pairs of a response's Set-Cookie headers, for a Cookie header. */
export function cookiesFrom(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

/** Signs in through the development login and returns the session cookie. */
export async function devLogin(app: FastifyInstance, email: string): Promise<string> {
  const readers = (await admin(app, 'GET', '/readers')).json() as { id: number; email: string }[];
  const reader = readers.find((r) => r.email === email);
  if (!reader) throw new Error(`no reader ${email}`);
  const res = await app.inject({
    method: 'POST',
    url: '/auth/dev',
    payload: `readerId=${reader.id}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (res.statusCode !== 302) throw new Error(`dev login failed: ${res.statusCode} ${res.body}`);
  return cookiesFrom(res);
}
