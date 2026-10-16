import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, listAudit, listOrgs, listReaders, testDatabaseUrl } from '@opend/store';
import {
  applySeed,
  loadConfig,
  reconcileOptions,
  redactUrl,
  runReconcileCommand,
  signEntitlementPayload,
  verifyEntitlementSignature,
  type ServerConfig,
} from '../src/index.js';
import { admin, devLogin, startHarness, type Harness } from './helpers.js';

const url = testDatabaseUrl();
const SECRET = 'entitlement-webhook-secret-0123456789';
const now = () => Math.floor(Date.now() / 1000);

const SEED = `
orgs:
  - slug: acme
    name: Acme
    entitlements: { products: [widget], version: "1.4" }
    readers: [ann@acme.example, bob@acme.example]
  - slug: globex
    name: Globex
    entitlements: { products: [widget, gadget], features: [sso], version: "2.1" }
    readers: [gus@globex.example]
`;

const snapshot = {
  orgs: [
    {
      slug: 'acme',
      name: 'Acme Corp',
      entitlements: { products: ['widget'], version: '1.4' },
      readers: ['ann@acme.example'],
    },
  ],
};

describe('entitlement webhook signatures', () => {
  const body = Buffer.from('{"type":"events","events":[]}');
  const ts = String(now());

  it('accepts a signature over the timestamp and body', () => {
    const signature = signEntitlementPayload(SECRET, ts, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyEntitlementSignature(SECRET, body, { signature, timestamp: ts })).toBe('ok');
  });

  it('rejects forged, mismatched, missing and stale signatures', () => {
    const signature = signEntitlementPayload(SECRET, ts, body);
    const check = (headers: { signature?: string; timestamp?: string }, b = body, at = now()) =>
      verifyEntitlementSignature(SECRET, b, headers, at);
    expect(
      check({ signature: signEntitlementPayload('other-secret', ts, body), timestamp: ts }),
    ).toBe('invalid');
    expect(check({ signature, timestamp: ts }, Buffer.from('{}'))).toBe('invalid');
    // The timestamp is signed, so it cannot be refreshed by a replaying attacker.
    expect(check({ signature, timestamp: String(Number(ts) + 1) })).toBe('invalid');
    expect(check({ timestamp: ts })).toBe('invalid');
    expect(check({ signature })).toBe('invalid');
    expect(check({ signature, timestamp: 'yesterday' })).toBe('invalid');
    expect(check({ signature, timestamp: ts }, body, Number(ts) + 301)).toBe('stale');
    expect(check({ signature, timestamp: ts }, body, Number(ts) - 301)).toBe('stale');
    expect(check({ signature, timestamp: ts }, body, Number(ts) + 299)).toBe('ok');
  });
});

describe('self-hosting configuration', () => {
  const base = { DATABASE_URL: 'postgres://localhost/opend', SESSION_SECRET: 'x'.repeat(32) };

  it('defaults to no polling and merge mode, and treats empty values as unset', () => {
    const config = loadConfig({ ...base, POLL_INTERVAL_SECONDS: '', OPEND_ADMIN_TOKEN: '' });
    expect(config.selfHosting).toEqual({ pollIntervalSeconds: 0, entitlementSyncMode: 'merge' });
    expect(config.adminToken).toBeUndefined();
  });

  it('reads polling and entitlement settings', () => {
    const config = loadConfig({
      ...base,
      POLL_INTERVAL_SECONDS: '60',
      ENTITLEMENT_WEBHOOK_SECRET: SECRET,
      ENTITLEMENT_SOURCE_URL: 'https://crm.example/export.json',
      ENTITLEMENT_SOURCE_TOKEN: 'crm-token',
      ENTITLEMENT_SYNC_MODE: 'replace',
    });
    expect(config.selfHosting).toEqual({
      pollIntervalSeconds: 60,
      entitlementWebhookSecret: SECRET,
      entitlementSource: { url: 'https://crm.example/export.json', token: 'crm-token' },
      entitlementSyncMode: 'replace',
    });
  });

  it('explains bad values', () => {
    expect(() => loadConfig({ ...base, POLL_INTERVAL_SECONDS: '5' })).toThrow(
      /POLL_INTERVAL_SECONDS must be 0 \(off\) or at least 10/,
    );
    expect(() => loadConfig({ ...base, ENTITLEMENT_WEBHOOK_SECRET: 'short' })).toThrow(
      /at least 32/,
    );
    expect(() => loadConfig({ ...base, ENTITLEMENT_SYNC_MODE: 'wipe' })).toThrow(
      /merge or replace/,
    );
    expect(() => loadConfig({ ...base, ENTITLEMENT_SOURCE_URL: 'not a url' })).toThrow(
      /ENTITLEMENT_SOURCE_URL/,
    );
  });

  it('only sends the export token to the configured origin', () => {
    const config = loadConfig({
      ...base,
      ENTITLEMENT_SOURCE_URL: 'https://crm.example/export.json',
      ENTITLEMENT_SOURCE_TOKEN: 'crm-token',
    });
    expect(reconcileOptions(config, {})).toEqual({
      url: 'https://crm.example/export.json',
      mode: 'merge',
      token: 'crm-token',
    });
    expect(
      reconcileOptions(config, { from: 'https://crm.example/other', mode: 'replace' }),
    ).toMatchObject({ token: 'crm-token', mode: 'replace' });
    expect(reconcileOptions(config, { from: 'https://elsewhere.example/x' }).token).toBeUndefined();
    expect(() => reconcileOptions(config, { mode: 'wipe' })).toThrow(/merge or replace/);
    expect(() => reconcileOptions(config, { from: 'file:///etc/passwd' })).toThrow(/http\(s\)/);
    expect(() => reconcileOptions(loadConfig(base), {})).toThrow(/ENTITLEMENT_SOURCE_URL/);
    expect(redactUrl('https://u:p@crm.example/export.json?token=x')).toBe(
      'https://crm.example/export.json',
    );
  });
});

describe.skipIf(!url)('entitlement sync over HTTP', () => {
  let h: Harness;

  const sync = (payload: object) => admin(h.app, 'PUT', '/entitlements/sync', payload);
  const hook = (
    payload: object | string,
    options: { key?: string; timestamp?: number; secret?: string } = {},
  ) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const timestamp = String(options.timestamp ?? now());
    return h.app.inject({
      method: 'POST',
      url: '/webhooks/entitlements',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-opend-timestamp': timestamp,
        'x-opend-signature': signEntitlementPayload(options.secret ?? SECRET, timestamp, body),
        'idempotency-key': options.key ?? randomUUID(),
      },
    });
  };

  beforeAll(async () => {
    h = await startHarness(url!, {
      config: {
        selfHosting: {
          pollIntervalSeconds: 0,
          entitlementSyncMode: 'merge',
          entitlementWebhookSecret: SECRET,
        },
      },
    });
  });
  beforeEach(async () => {
    await h.db.pool.query('truncate orgs, audit_log, webhook_deliveries cascade');
    await applySeed(h.db.pool, SEED);
  });
  afterAll(async () => h?.close());

  it('requires the admin token and validates the snapshot', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/admin/api/entitlements/sync',
      payload: snapshot,
    });
    expect(res.statusCode).toBe(401);
    const bad = await sync({ orgs: [{ slug: 'Not A Slug', name: '' }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.join('\n')).toMatch(/orgs\.0\.slug/);
    const dup = await sync({
      orgs: [
        { slug: 'a', name: 'A', readers: ['x@y.example'] },
        { slug: 'b', name: 'B', readers: ['X@y.example'] },
      ],
    });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().error).toMatch(/listed in both a and b/);
  });

  it('merges by default, upserting only', async () => {
    const res = await sync(snapshot);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mode: 'merge',
      dryRun: false,
      summary: {
        orgs: { created: 0, updated: 1, removed: 0 },
        readers: { created: 0, updated: 0, removed: 0 },
      },
    });
    expect(await listReaders(h.db.pool)).toHaveLength(3);
  });

  it('replaces only with an explicit confirmation, and previews with dry run', async () => {
    const refused = await sync({ ...snapshot, mode: 'replace' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().issues.join()).toMatch(/confirmReplace/);

    const preview = await sync({ ...snapshot, mode: 'replace', dryRun: true });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      dryRun: true,
      summary: { orgs: { removed: 1, updated: 1 }, readers: { removed: 2 } },
      changes: {
        orgs: { removed: ['globex'] },
        readers: {
          removed: [
            { email: 'bob@acme.example', org: 'acme' },
            { email: 'gus@globex.example', org: 'globex' },
          ],
        },
      },
    });
    expect(await listReaders(h.db.pool)).toHaveLength(3);
    expect((await listAudit(h.db.pool)).map((a) => a.action)).toEqual(['seed.apply']);

    const applied = await sync({ ...snapshot, mode: 'replace', confirmReplace: true });
    expect(applied.statusCode).toBe(200);
    expect((await listOrgs(h.db.pool)).map((o) => o.slug)).toEqual(['acme']);
    const [entry] = await listAudit(h.db.pool);
    expect(entry).toMatchObject({
      actor: 'admin-token',
      action: 'entitlements.sync',
      detail: {
        mode: 'replace',
        source: 'admin-api',
        summary: { orgs: { updated: 1, removed: 1 }, readers: { removed: 2 } },
        orgsRemoved: ['globex'],
      },
    });
  });

  it('signs a reader out of their access as soon as a replace removes them', async () => {
    const cookie = await devLogin(h.app, 'gus@globex.example');
    const get = () => h.app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect((await get()).statusCode).not.toBe(302);
    await sync({ ...snapshot, mode: 'replace', confirmReplace: true });
    expect((await get()).statusCode).toBe(302);
  });

  it('accepts signed events and snapshots, once per idempotency key', async () => {
    const events = {
      type: 'events',
      events: [
        {
          type: 'org.upsert',
          org: { slug: 'newco', name: 'Newco', entitlements: { version: '2.0' } },
        },
        { type: 'reader.add', org: 'newco', email: 'nia@newco.example' },
        { type: 'reader.remove', email: 'bob@acme.example' },
      ],
    };
    const first = await hook(events, { key: 'crm-evt-1' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'applied',
      mode: 'events',
      summary: { orgs: { created: 1 }, readers: { created: 1, removed: 1 } },
    });
    const replay = await hook(events, { key: 'crm-evt-1' });
    expect(replay.json()).toEqual({ status: 'duplicate' });
    expect((await listReaders(h.db.pool)).map((r) => r.email).sort()).toEqual([
      'ann@acme.example',
      'gus@globex.example',
      'nia@newco.example',
    ]);
    const [entry] = await listAudit(h.db.pool);
    expect(entry).toMatchObject({
      actor: 'entitlement-webhook',
      detail: { mode: 'events', source: 'webhook:crm-evt-1' },
    });

    // A webhook snapshot merges unless it asks for replace explicitly.
    const merged = await hook({ type: 'snapshot', ...snapshot });
    expect(merged.json()).toMatchObject({ mode: 'merge', summary: { orgs: { removed: 0 } } });
    const replaced = await hook({ type: 'snapshot', mode: 'replace', ...snapshot });
    expect(replaced.json()).toMatchObject({
      mode: 'replace',
      summary: { orgs: { removed: 2 } },
    });
  });

  it('rejects bad signatures, stale timestamps and malformed requests', async () => {
    const events = { type: 'events', events: [{ type: 'org.delete', slug: 'acme' }] };
    expect((await hook(events, { secret: 'forged-secret' })).statusCode).toBe(401);
    const stale = await hook(events, { timestamp: now() - 600 });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error).toMatch(/timestamp/);
    expect((await hook(events, { key: '' })).statusCode).toBe(400);
    expect((await hook('{not json')).statusCode).toBe(400);
    expect((await hook({ type: 'events', events: [{ type: 'org.nuke' }] })).statusCode).toBe(400);
    expect(await listOrgs(h.db.pool)).toHaveLength(2);
  });

  it('does not record the key of a delivery that could not be applied, so it can be retried', async () => {
    const add = {
      type: 'events',
      events: [{ type: 'reader.add', org: 'initech', email: 'i@x.example' }],
    };
    const failed = await hook(add, { key: 'retry-me' });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().error).toMatch(/no such org initech/);
    const fixed = {
      type: 'events',
      events: [{ type: 'org.upsert', org: { slug: 'initech', name: 'Initech' } }, ...add.events],
    };
    expect((await hook(fixed, { key: 'retry-me' })).json()).toMatchObject({ status: 'applied' });
  });
});

describe.skipIf(!url)('opend-server reconcile', () => {
  let h: Harness;
  let server: Server;
  let exportUrl: string;
  let served: unknown = snapshot;
  const authHeaders: (string | undefined)[] = [];
  let config: ServerConfig;

  beforeAll(async () => {
    h = await startHarness(url!);
    server = createServer((req, res) => {
      authHeaders.push(req.headers.authorization);
      if (req.url === '/broken') return void res.writeHead(500).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(served));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    exportUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/export.json`;
    config = loadConfig({
      DATABASE_URL: h.db.url,
      SESSION_SECRET: 'x'.repeat(32),
      ENTITLEMENT_SOURCE_URL: exportUrl,
      ENTITLEMENT_SOURCE_TOKEN: 'crm-token',
    });
  });
  beforeEach(async () => {
    await h.db.pool.query('truncate orgs, audit_log cascade');
    await applySeed(h.db.pool, SEED);
    served = snapshot;
    authHeaders.length = 0;
  });
  afterAll(async () => {
    await h?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('fetches the export with the bearer token and merges it', async () => {
    const logs: Record<string, unknown>[] = [];
    const result = await runReconcileCommand(config, {}, { log: (e) => void logs.push(e) });
    expect(authHeaders).toEqual(['Bearer crm-token']);
    expect(result.summary.orgs).toEqual({ created: 0, updated: 1, removed: 0 });
    expect(logs[0]).toMatchObject({ msg: 'reconcile applied', mode: 'merge', source: exportUrl });
    const [entry] = await listAudit(h.db.pool);
    expect(entry).toMatchObject({ actor: 'reconcile', detail: { source: exportUrl } });
  });

  it('replaces, and other replicas drop the removed reader through NOTIFY', async () => {
    const cookie = await devLogin(h.app, 'gus@globex.example');
    const get = () => h.app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect((await get()).statusCode).not.toBe(302); // now cached as allowed
    // A separate connection pool, as the reconcile cron service would have.
    const pool = createPool(h.db.url);
    try {
      const preview = await runReconcileCommand(
        config,
        { mode: 'replace', dryRun: true },
        { pool, log: () => {} },
      );
      expect(preview.summary.orgs.removed).toBe(1);
      expect(await listOrgs(h.db.pool)).toHaveLength(2);
      await runReconcileCommand(config, { mode: 'replace' }, { pool, log: () => {} });
    } finally {
      await pool.end();
    }
    expect((await listOrgs(h.db.pool)).map((o) => o.slug)).toEqual(['acme']);
    await expect.poll(async () => (await get()).statusCode).toBe(302);
  });

  it('refuses an empty export in replace mode and reports fetch errors', async () => {
    served = { orgs: [] };
    await expect(
      runReconcileCommand(config, { mode: 'replace' }, { log: () => {} }),
    ).rejects.toThrow(/returned no orgs/);
    expect(await listOrgs(h.db.pool)).toHaveLength(2);
    const allowed = await runReconcileCommand(
      config,
      { mode: 'replace', allowEmpty: true, dryRun: true },
      { log: () => {} },
    );
    expect(allowed.summary.orgs.removed).toBe(2);

    served = { orgs: [{ slug: 'acme' }] };
    await expect(runReconcileCommand(config, {}, { log: () => {} })).rejects.toThrow(
      /invalid snapshot[\s\S]*orgs\.0\.name/,
    );
    await expect(
      runReconcileCommand(
        config,
        { from: exportUrl.replace('export.json', 'broken') },
        {
          log: () => {},
        },
      ),
    ).rejects.toThrow(/returned 500/);
  });
});
