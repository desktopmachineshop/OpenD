import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReaderContext } from '@opend/model';
import { FsBlobStore, enqueueJob, testDatabaseUrl, upsertRepo } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { MARKERS } from '../../cli/test/markers.js';
import { applySeed, verifyEmbedToken } from '../src/index.js';
import { STARTER, cookiesFrom, startHarness, type Harness } from './helpers.js';

const url = testDatabaseUrl();
const SECRET = 'embed-secret-0123456789abcdef0123456789';
const HOST = 'https://app.example';
const DOCS = 'http://docs.test';

function token(
  claims: Record<string, unknown>,
  options: { secret?: string; aud?: string; ttl?: number; iat?: number } = {},
) {
  const iat = options.iat ?? Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(options.aud ?? DOCS)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (options.ttl ?? 300))
    .sign(new TextEncoder().encode(options.secret ?? SECRET));
}

describe('verifyEmbedToken', () => {
  it('accepts a valid token and names the reader', async () => {
    expect(
      await verifyEmbedToken(await token({ email: 'a@b.c', org: 'acme' }), SECRET, DOCS),
    ).toEqual({
      email: 'a@b.c',
      org: 'acme',
      expiresAt: expect.any(Number),
    });
    expect(
      await verifyEmbedToken(await token({ sub: 'a@b.c', org: 'acme' }), SECRET, DOCS),
    ).toMatchObject({ email: 'a@b.c' });
  });

  it.each<[string, () => Promise<string>, RegExp]>([
    [
      'wrong secret',
      () => token({ email: 'a@b.c', org: 'x' }, { secret: 'another-secret-0123456789abcdef0123' }),
      /invalid/,
    ],
    [
      'wrong audience',
      () => token({ email: 'a@b.c', org: 'x' }, { aud: 'https://other.example' }),
      /invalid/,
    ],
    [
      'expired',
      () =>
        token(
          { email: 'a@b.c', org: 'x' },
          { iat: Math.floor(Date.now() / 1000) - 3600, ttl: 300 },
        ),
      /expired/,
    ],
    ['too long-lived', () => token({ email: 'a@b.c', org: 'x' }, { ttl: 3600 }), /at most 600/],
    [
      // A short exp - iat span is not enough: a future iat would make the token live for days.
      'issued in the future',
      () => token({ email: 'a@b.c', org: 'x' }, { iat: Math.floor(Date.now() / 1000) + 86_400 }),
      /invalid/,
    ],
    ['no org', () => token({ email: 'a@b.c' }), /email\) and org/],
    ['not a JWT', async () => 'nope', /invalid/],
  ])('rejects %s', async (_label, make, message) => {
    await expect(verifyEmbedToken(await make(), SECRET, DOCS)).rejects.toThrow(message);
  });
});

const READERS: Record<string, { email: string; org: string; context: ReaderContext }> = {
  'v1-basic': {
    email: 'ann@acme.example',
    org: 'acme',
    context: { products: ['widget'], features: [], version: '1.4' },
  },
  'v2-pro': {
    email: 'gus@globex.example',
    org: 'globex',
    context: { products: ['widget', 'gadget'], features: ['sso', 'audit-log'], version: '2.1' },
  },
};

describe.skipIf(!url)('embedded help (hosted)', () => {
  let h: Harness;
  let docs: DocsRepo;
  const sessions: Record<string, string> = {};
  const get = (path: string, headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'GET', url: path, headers });

  beforeAll(async () => {
    h = await startHarness(url!, { config: { embed: { secret: SECRET, origins: [HOST] } } });
    docs = createDocsRepo(STARTER);
    const repo = await upsertRepo(h.db.pool, {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['main', 'v*'],
    });
    await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'main', sha: docs.head() });
    const config = readFileSync(join(docs.dir, 'opend.config.yaml'), 'utf8');
    const v1 = docs.commit({
      'opend.config.yaml': config.replace(/^release: .*$/m, 'release: "1.4"'),
    });
    await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'v1', sha: v1 });
    const deps = { pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} };
    expect(await processNext(deps)).toBe('published');
    expect(await processNext(deps)).toBe('published');
    await applySeed(
      h.db.pool,
      `orgs:
  - { slug: acme, name: Acme, entitlements: { products: [widget], version: "1.4" }, readers: [ann@acme.example] }
  - { slug: globex, name: Globex, entitlements: { products: [widget, gadget], features: [sso, audit-log], version: "2.1" }, readers: [gus@globex.example] }
`,
    );
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  const exchange = async (t: string) =>
    h.app.inject({
      method: 'POST',
      url: '/embed/session',
      headers: { authorization: `Bearer ${t}` },
    });

  it('serves the widget and frame scripts', async () => {
    const widget = await get('/embed/opend-help.js');
    expect(widget.statusCode).toBe(200);
    expect(widget.body).toContain('OpenDHelp');
    expect((await get('/embed/frame.js')).body).toContain('opend:need-token');
  });

  it('asks the host for a token when the frame has no session', async () => {
    const res = await get(
      `/embed/context?app=console&key=settings.sso&host=${encodeURIComponent(HOST)}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-need-token="1"');
    expect(res.body).toContain(`data-host-origin="${HOST}"`);
    expect(res.headers['content-security-policy']).toContain(`frame-ancestors ${HOST}`);
    const foreign = await get('/embed/context?app=console&key=x&host=https%3A%2F%2Fevil.example');
    expect(foreign.statusCode).toBe(401);
    expect(foreign.body).not.toContain('data-need-token');
  });

  it('exchanges a host token for a partitioned embed session', async () => {
    expect((await h.app.inject({ method: 'POST', url: '/embed/session' })).statusCode).toBe(401);
    expect(
      (
        await exchange(
          await token({ email: 'ann@acme.example', org: 'acme' }, { secret: 'x'.repeat(40) }),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (await exchange(await token({ email: 'nobody@acme.example', org: 'acme' }))).statusCode,
    ).toBe(403);
    expect(
      (await exchange(await token({ email: 'ann@acme.example', org: 'globex' }))).statusCode,
    ).toBe(403);

    for (const [name, reader] of Object.entries(READERS)) {
      const res = await exchange(await token({ email: reader.email, org: reader.org }));
      expect(res.statusCode).toBe(204);
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/^opend_embed=/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=None');
      expect(cookie).toContain('Partitioned');
      sessions[name] = cookiesFrom(res);
    }
  });

  it('stops accepting a cached token once it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.now();
      const t = await token({ email: 'ann@acme.example', org: 'acme' }, { ttl: 20 });
      expect((await exchange(t)).statusCode).toBe(204);
      // Past exp and the 30 second clock tolerance, but well inside the cache's own TTL.
      vi.setSystemTime(start + 55_000);
      expect((await exchange(t)).statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves contexts per reader inside the frame', async () => {
    const ctxPage = (reader: string, query: string) =>
      get(`/embed/context?app=console&${query}&host=${encodeURIComponent(HOST)}`, {
        cookie: sessions[reader]!,
      });
    expect((await ctxPage('v2-pro', 'key=settings.sso')).body).toContain(
      'Configure single sign-on',
    );
    const v1 = await ctxPage('v1-basic', 'key=settings.sso');
    expect(v1.body).toContain('Configure the hub');
    expect(v1.body).not.toContain('single sign-on');
    expect((await ctxPage('v1-basic', 'path=/whats-new')).body).toContain('Release notes for 1.x');
    expect((await ctxPage('v2-pro', 'path=/whats-new')).body).toContain('Release notes for 2.x');
    const asset = await get('/_assets/images/logo.svg', { cookie: sessions['v1-basic']! });
    expect(asset.statusCode).toBe(200);
  });

  describe.each(Object.entries(READERS))('leak markers over embed pages: %s', (name, reader) => {
    let html: string;
    beforeAll(async () => {
      const cookie = { cookie: sessions[name]! };
      const topics = [
        'overview',
        'install',
        'configure',
        'gadget-pairing',
        'configure-sso',
        'audit-log',
        'release-notes-1',
        'release-notes-2',
      ];
      const keys = [
        'overview',
        'setup.install',
        'settings',
        'settings.sso',
        'settings.audit',
        'devices.gadget',
        'whats-new',
      ];
      const pages = await Promise.all([
        ...topics.map((t) => get(`/embed/topics/topics/${t}.html`, cookie)),
        ...keys.map((k) => get(`/embed/context?app=console&key=${k}`, cookie)),
        ...['pair', 'sso', 'installer', 'audit', 'release'].map((q) =>
          get(`/embed/search?q=${q}`, cookie),
        ),
      ]);
      html = pages.map((p) => p.body).join('\n');
    });
    // '>Gadget<' is the Gadget heading in the site navigation, which panels do not have.
    it.each(MARKERS.filter(([phrase]) => phrase !== '>Gadget<'))('%s', (phrase, rule) => {
      expect(html.includes(phrase)).toBe(rule(reader.context));
    });
  });

  it('keeps the docs site itself unframeable', async () => {
    const page = await get('/topics/overview.html', { cookie: sessions['v2-pro']! });
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  describe('JSON API', () => {
    it('answers CORS preflights for allowed origins only', async () => {
      const ok = await h.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/help/context',
        headers: { origin: HOST },
      });
      expect(ok.statusCode).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe(HOST);
      expect(ok.headers['access-control-allow-headers']).toBe('authorization');
      const bad = await h.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/help/context',
        headers: { origin: 'https://evil.example' },
      });
      expect(bad.statusCode).toBe(403);
      expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('returns filtered help for a context, a topic and a search', async () => {
      const auth = (reader: keyof typeof READERS) =>
        token({ email: READERS[reader]!.email, org: READERS[reader]!.org }).then((t) => ({
          authorization: `Bearer ${t}`,
          origin: HOST,
        }));
      const v1 = await get(
        '/api/v1/help/context?app=console&key=settings.sso',
        await auth('v1-basic'),
      );
      expect(v1.statusCode).toBe(200);
      expect(v1.headers['access-control-allow-origin']).toBe(HOST);
      expect(v1.json()).toMatchObject({
        topicId: 'topics/configure',
        key: 'settings',
        via: 'parent',
        fullUrl: `${DOCS}/topics/configure.html`,
      });
      const pro = (
        await get('/api/v1/help/context?app=console&path=/settings/sso', await auth('v2-pro'))
      ).json();
      expect(pro).toMatchObject({
        topicId: 'topics/configure-sso',
        title: 'Configure single sign-on',
      });
      expect(pro.html).toContain('<article');
      expect(
        (await get('/api/v1/help/topics/topics/gadget-pairing', await auth('v1-basic'))).statusCode,
      ).toBe(404);
      const hits = (await get('/api/v1/help/search?q=pair', await auth('v1-basic'))).json() as {
        hits: unknown[];
      };
      expect(hits.hits).toEqual([]);
      // Postgres search: the last word completes as a prefix.
      const found = (await get('/api/v1/help/search?q=setup%20wiza', await auth('v2-pro'))).json();
      expect(found.query).toBe('setup wiza');
      expect(found.hits[0]).toMatchObject({ topicId: 'topics/install', score: expect.any(Number) });
      expect(found.hits[0].snippet).toContain('setup wizard');
    });

    it('requires a valid token and an allowed origin', async () => {
      expect((await get('/api/v1/help/search?q=x', { origin: HOST })).statusCode).toBe(401);
      const t = await token({ email: 'ann@acme.example', org: 'acme' });
      expect(
        (
          await get('/api/v1/help/search?q=x', {
            origin: 'https://evil.example',
            authorization: `Bearer ${t}`,
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  // Last: it publishes a new 2.x release with a key that points at a nested topic.
  it('opens a context that points at a section of a page at its anchor', async () => {
    const config = readFileSync(join(STARTER, 'opend.config.yaml'), 'utf8');
    const map = readFileSync(join(STARTER, 'maps/user-guide.ditamap'), 'utf8');
    const sha = docs.commit({
      'opend.config.yaml': config,
      'maps/user-guide.ditamap': map.replace(
        '<topicref href="../topics/overview.dita"/>',
        '<topicref href="../topics/overview.dita"/>\n  <topicref href="../topics/limits.dita"/>',
      ),
      'topics/limits.dita': `<reference id="limits"><title>Limits</title><refbody><p>Intro</p></refbody>
  <reference id="quotas"><title>Quotas</title>
    <prolog><resourceid appname="console" appid="settings.quotas"/></prolog>
    <refbody><p>Quota details</p></refbody>
  </reference>
</reference>`,
    });
    const repo = (await h.db.pool.query<{ id: number }>('select id from repos')).rows[0]!;
    await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'main', sha });
    const deps = { pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} };
    expect(await processNext(deps)).toBe('published');
    h.ctx.caches.releaseChanged();
    const res = await get(
      `/embed/context?app=console&key=settings.quotas&host=${encodeURIComponent(HOST)}`,
      { cookie: sessions['v2-pro']! },
    );
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(
      `/embed/topics/topics/limits.html?host=${encodeURIComponent(HOST)}&app=console#quotas`,
    );
    expect(res.headers['content-security-policy']).toContain(`frame-ancestors ${HOST}`);
  });
});

describe.skipIf(!url)('embedded help when not configured', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness(url!);
  });
  afterAll(() => h?.close());

  it('does not exist', async () => {
    expect(
      (await h.app.inject({ method: 'GET', url: '/embed/opend-help.js' })).statusCode,
    ).not.toBe(200);
    expect((await h.app.inject({ method: 'POST', url: '/embed/session' })).statusCode).toBe(404);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/v1/help/search?q=x' })).statusCode,
    ).not.toBe(200);
  });
});
