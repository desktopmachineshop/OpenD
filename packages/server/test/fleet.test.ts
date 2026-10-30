import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PdfRenderer } from '@opend/pdf';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '@opend/store';
import { createDocsRepo, type DocsRepo } from '@opend/worker';
import {
  loadFleetConfig,
  migrateFleet,
  startFleet,
  startFleetWorker,
  type Fleet,
  type FleetWorker,
} from '../src/index.js';
import { MARKERS } from '../../cli/test/markers.js';
import { STARTER, pushPayload } from './helpers.js';

const url = testDatabaseUrl();

const FLEET_TOKEN = 'fleet-token-0123456789abcdef0123456789';
const noPdf: PdfRenderer = {
  render: async () => {
    throw new Error('no PDFs in this test');
  },
  close: async () => {},
} as unknown as PdfRenderer;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const siteEnv = (name: string) => ({
  PUBLIC_URL: `http://${name}.docs.test`,
  SESSION_SECRET: `${name}-session-secret-0123456789abcdef`,
  OPEND_ADMIN_TOKEN: `${name}-admin-token-0123456789abcdef`,
  GITHUB_WEBHOOK_SECRET: `${name}-webhook-secret`,
  OPEND_DEV_LOGIN: '1',
  EDITOR_PUBLIC_URL: `http://${name}.edit.test`,
});

describe.skipIf(!url)('a fleet of sites', () => {
  let db: TestDatabase;
  let fleet: Fleet;
  let worker: FleetWorker;
  let docs: DocsRepo;
  let blobDir: string;
  let port = 0;

  const call = (
    host: string,
    method: string,
    path: string,
    options: { body?: string | object; headers?: Record<string, string> } = {},
  ): Promise<Res> =>
    new Promise((resolve, reject) => {
      const body =
        options.body === undefined
          ? undefined
          : typeof options.body === 'string'
            ? options.body
            : JSON.stringify(options.body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            host,
            ...(typeof options.body === 'object' ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c.toString('utf8')));
          res.on('end', () =>
            resolve({ status: res.statusCode!, headers: res.headers, body: data }),
          );
        },
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  const fleetApi = (method: string, path: string, body?: object) =>
    call('fleet.test', method, `/fleet/api${path}`, {
      ...(body ? { body } : {}),
      headers: { authorization: `Bearer ${FLEET_TOKEN}` },
    });
  const siteAdmin = (site: string, method: string, path: string, body?: object, token = site) =>
    call(`${site}.docs.test`, method, `/admin/api${path}`, {
      ...(body ? { body } : {}),
      headers: { authorization: `Bearer ${token}-admin-token-0123456789abcdef` },
    });
  const signIn = async (site: string, email: string): Promise<string> => {
    const readers = JSON.parse((await siteAdmin(site, 'GET', '/readers')).body) as {
      id: number;
      email: string;
    }[];
    const reader = readers.find((r) => r.email === email)!;
    const res = await call(`${site}.docs.test`, 'POST', '/auth/dev', {
      body: `readerId=${reader.id}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(302);
    const set = res.headers['set-cookie'];
    return (Array.isArray(set) ? set : [set!]).map((c) => c.split(';')[0]).join('; ');
  };

  beforeAll(async () => {
    db = await createTestDatabase(url!);
    blobDir = mkdtempSync(join(tmpdir(), 'opend-fleet-blobs-'));
    const config = loadFleetConfig({
      DATABASE_URL: db.url,
      OPEND_FLEET_KEY: 'fleet-key-0123456789abcdef0123456789',
      OPEND_FLEET_TOKEN: FLEET_TOKEN,
      OPEND_FLEET_HOST: 'fleet.test',
      // One running site at a time, so every switch between sites restarts one.
      OPEND_FLEET_MAX_SITES: '1',
      OPEND_FLEET_REDIRECTS: 'www.docs.test=https://docs.test',
      BLOB_DIR: blobDir,
      NODE_ENV: 'test',
    });
    fleet = await startFleet(config, { log: () => {}, pdf: noPdf });
    await new Promise<void>((resolve) => fleet.server.listen(0, '127.0.0.1', resolve));
    port = (fleet.server.address() as AddressInfo).port;
    worker = await startFleetWorker(config, { log: () => {}, sweepMs: 60_000 });
    docs = createDocsRepo(STARTER);
    docs.commit({ 'notes.txt': 'fleet test' });
  });
  afterAll(async () => {
    await worker?.stop();
    await fleet?.close();
    await db?.drop();
    docs?.remove();
    rmSync(blobDir, { recursive: true, force: true });
  });

  it('creates sites through the fleet admin API', async () => {
    expect((await call('fleet.test', 'GET', '/fleet/api/sites')).status).toBe(401);
    for (const name of ['a', 'b']) {
      const res = await fleetApi('POST', '/sites', {
        slug: name,
        hosts: [`${name}.docs.test`],
        editorHosts: [`${name}.edit.test`],
        env: siteEnv(name),
      });
      expect(res.status, res.body).toBe(201);
      expect(JSON.parse(res.body)).toMatchObject({ slug: name, schema: `site_${name}` });
      expect(res.body).not.toContain('session-secret');
    }
    expect(
      (await fleetApi('POST', '/sites', { slug: 'c', hosts: ['a.docs.test'], env: siteEnv('c') }))
        .status,
    ).toBe(409);
    // Settings that are not a valid site configuration leave nothing behind.
    const bad = await fleetApi('POST', '/sites', {
      slug: 'bad',
      hosts: ['bad.docs.test'],
      env: { PUBLIC_URL: 'http://bad.docs.test' },
    });
    expect(bad.status).toBe(400);
    const { rows } = await db.pool.query(
      "select 1 from information_schema.schemata where schema_name = 'site_bad'",
    );
    expect(rows).toHaveLength(0);
    expect((await call('nowhere.test', 'GET', '/')).status).toBe(404);
    expect(JSON.parse((await call('fleet.test', 'GET', '/healthz')).body)).toMatchObject({
      status: 'ok',
    });
  });

  it('keeps each site’s admin token, readers and sessions to itself', async () => {
    for (const site of ['a', 'b']) {
      expect(
        (
          await siteAdmin(site, 'POST', '/orgs', {
            slug: 'acme',
            name: `Acme ${site}`,
            entitlements: { products: ['widget'], features: [], version: '2.1' },
          })
        ).status,
      ).toBe(201);
      expect(
        (await siteAdmin(site, 'POST', '/readers', { email: 'ann@acme.example', orgSlug: 'acme' }))
          .status,
      ).toBe(201);
    }
    expect((await siteAdmin('b', 'GET', '/readers', undefined, 'a')).status).toBe(401);
    const res = await siteAdmin('a', 'POST', '/repos', {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['main'],
    });
    expect(res.status, res.body).toBe(201);
    const body = pushPayload('acme/docs', 'refs/heads/main', docs.head());
    const signature = `sha256=${createHmac('sha256', 'a-webhook-secret').update(body).digest('hex')}`;
    const hook = await call('a.docs.test', 'POST', '/webhooks/github', {
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signature,
      },
    });
    expect(hook.status, hook.body).toBe(202);
    await worker.drain();

    const ann = await signIn('a', 'ann@acme.example');
    const page = await call('a.docs.test', 'GET', '/topics/install.html', {
      headers: { cookie: ann },
    });
    expect(page.status).toBe(200);
    // Per-reader filtering holds behind the fleet's router as on a single site.
    const topics = [
      'overview',
      'install',
      'configure',
      'gadget-pairing',
      'configure-sso',
      'audit-log',
    ]
      .map((t) => `/topics/${t}.html`)
      .concat(['/topics/release-notes-1.html', '/topics/release-notes-2.html']);
    const html = (
      await Promise.all(
        topics.map((t) => call('a.docs.test', 'GET', t, { headers: { cookie: ann } })),
      )
    )
      .map((r) => r.body)
      .join('\n');
    const context = { products: ['widget'], features: [], version: '2.1' };
    for (const [phrase, rule] of MARKERS) expect(html.includes(phrase), phrase).toBe(rule(context));
    // Site A's session means nothing on site B, though both have ann in acme.
    const onB = await call('b.docs.test', 'GET', '/topics/install.html', {
      headers: { cookie: ann },
    });
    expect(onB.status).toBe(302);
    // B published nothing: its signed-in reader sees that, not A's docs.
    const annB = await signIn('b', 'ann@acme.example');
    const bPage = await call('b.docs.test', 'GET', '/', { headers: { cookie: annB } });
    expect(bPage.body).not.toContain('Install');
    expect(bPage.body).toContain('No documentation site is configured yet');

    const key = JSON.parse(
      (
        await siteAdmin('a', 'POST', '/api-keys', {
          name: 'k',
          scopes: ['read'],
          audience: 'staff',
        })
      ).body,
    ) as { token: string };
    const auth = { authorization: `Bearer ${key.token}` };
    expect((await call('a.docs.test', 'GET', '/api/v1/topics', { headers: auth })).status).toBe(
      200,
    );
    expect((await call('b.docs.test', 'GET', '/api/v1/topics', { headers: auth })).status).toBe(
      401,
    );
  });

  it('migrates every site schema with the registry', async () => {
    await db.pool.query("delete from site_a.schema_migrations where id = '009_api_keys'");
    await db.pool.query('drop table site_a.api_keys');
    const config = loadFleetConfig({
      DATABASE_URL: db.url,
      OPEND_FLEET_KEY: 'fleet-key-0123456789abcdef0123456789',
      OPEND_FLEET_TOKEN: FLEET_TOKEN,
      OPEND_FLEET_HOST: 'fleet.test',
    });
    const results = await migrateFleet(config, () => {});
    expect(results).toEqual(
      expect.arrayContaining([
        { site: 'a', ran: ['009_api_keys'] },
        { site: 'b', ran: [] },
      ]),
    );
  });

  it('redirects the hosts it is told to, keeping path and query', async () => {
    const res = await call('WWW.docs.test', 'GET', '/pricing?plan=team');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://docs.test/pricing?plan=team');
    expect((await call('nowhere.docs.test', 'GET', '/')).status).toBe(404);
    for (const bad of [
      'www.docs.test',
      'www.docs.test=http://docs.test',
      'x=https://docs.test/path',
    ])
      expect(() =>
        loadFleetConfig({
          DATABASE_URL: 'postgres://x',
          OPEND_FLEET_KEY: 'fleet-key-0123456789abcdef0123456789',
          OPEND_FLEET_TOKEN: FLEET_TOKEN,
          OPEND_FLEET_HOST: 'fleet.test',
          OPEND_FLEET_REDIRECTS: bad,
        }),
      ).toThrow(/OPEND_FLEET_REDIRECTS/);
  });

  it('forwards hosts it holds to a dedicated instance elsewhere', async () => {
    const seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[] =
      [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        if (req.url === '/moved') {
          res.writeHead(302, { location: `${origin}/topics/a.html` });
          return res.end();
        }
        res.writeHead(201, {
          'content-type': 'text/plain',
          'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
        });
        res.end(`hello from upstream: ${body}`);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    try {
      expect(
        (await fleetApi('PUT', '/forwards/own.docs.test', { upstream: 'http://evil.example' }))
          .status,
      ).toBe(400);
      // A site's host cannot be forwarded, and a forwarded host cannot be given to a site.
      expect((await fleetApi('PUT', '/forwards/a.docs.test', { upstream: origin })).status).toBe(
        409,
      );
      const set = await fleetApi('PUT', '/forwards/Own.Docs.Test', { upstream: `${origin}/` });
      expect(set.status).toBe(200);
      expect(JSON.parse(set.body)).toEqual({ host: 'own.docs.test', upstream: origin });
      expect(
        (
          await fleetApi('POST', '/sites', {
            slug: 'own',
            hosts: ['own.docs.test'],
            env: siteEnv('own'),
          })
        ).status,
      ).toBe(409);
      expect(JSON.parse((await fleetApi('GET', '/forwards')).body)).toEqual([
        { host: 'own.docs.test', upstream: origin },
      ]);

      const res = await call('own.docs.test', 'POST', '/search?q=x', {
        body: 'payload',
        headers: { 'content-type': 'text/plain', cookie: 'sid=abc' },
      });
      expect(res.status).toBe(201);
      expect(res.body).toBe('hello from upstream: payload');
      expect(res.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
      const got = seen.at(-1)!;
      expect(got).toMatchObject({ method: 'POST', url: '/search?q=x' });
      expect(got.headers).toMatchObject({
        host: origin.slice('http://'.length),
        'x-forwarded-host': 'own.docs.test',
        'x-forwarded-proto': 'https',
        cookie: 'sid=abc',
      });
      const moved = await call('own.docs.test', 'GET', '/moved');
      expect(moved.headers.location).toBe('https://own.docs.test/topics/a.html');

      expect((await fleetApi('DELETE', '/forwards/own.docs.test')).status).toBe(204);
      expect((await call('own.docs.test', 'GET', '/')).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
    // An upstream that is down is a 502, not a crash.
    await fleetApi('PUT', '/forwards/down.docs.test', { upstream: origin });
    expect((await call('down.docs.test', 'GET', '/')).status).toBe(502);
    await fleetApi('DELETE', '/forwards/down.docs.test');
  });

  it('pauses, restarts after settings change and deletes a site', async () => {
    expect((await fleetApi('POST', '/sites/b/suspend')).status).toBe(200);
    expect((await call('b.docs.test', 'GET', '/')).status).toBe(503);
    expect((await call('b.edit.test', 'GET', '/')).status).toBe(503);
    expect((await fleetApi('POST', '/sites/b/resume')).status).toBe(200);
    expect((await call('b.docs.test', 'GET', '/healthz')).status).toBe(200);

    const patched = await fleetApi('PATCH', '/sites/b', {
      env: { ...siteEnv('b'), OPEND_ADMIN_TOKEN: 'b2-admin-token-0123456789abcdef' },
    });
    expect(patched.status, patched.body).toBe(200);
    expect((await siteAdmin('b', 'GET', '/readers')).status).toBe(401);
    expect((await siteAdmin('b', 'GET', '/readers', undefined, 'b2')).status).toBe(200);

    expect((await fleetApi('DELETE', '/sites/b')).status).toBe(204);
    expect((await call('b.docs.test', 'GET', '/')).status).toBe(404);
    const { rows } = await db.pool.query(
      "select 1 from information_schema.schemata where schema_name = 'site_b'",
    );
    expect(rows).toHaveLength(0);
    // Site A is untouched.
    expect((await siteAdmin('a', 'GET', '/readers')).status).toBe(200);
  });
});
