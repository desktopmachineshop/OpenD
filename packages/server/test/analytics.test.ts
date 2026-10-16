import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsBlobStore, enqueueJob, testDatabaseUrl, upsertRepo } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import {
  applySeed,
  createApp,
  csvField,
  startAnalyticsPurge,
  type OpendApp,
} from '../src/index.js';
import { STARTER, admin, cookiesFrom, devLogin, startHarness, type Harness } from './helpers.js';

const url = testDatabaseUrl();
const SECRET = 'embed-secret-0123456789abcdef0123456789';
const HOST = 'https://app.example';
const DOCS = 'http://docs.test';
/** Sent on every request, so the tests can show it is never stored. */
const CLIENT_IP = '203.0.113.77';

const token = (email: string, org: string) => {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, org })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(DOCS)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(new TextEncoder().encode(SECRET));
};

/** The `_csrf` value of the feedback form on a page. */
function csrfFrom(res: LightMyRequestResponse): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(res.body);
  if (!m) throw new Error(`no feedback form in ${res.statusCode} page`);
  return m[1]!;
}

describe.skipIf(!url)('docs analytics and feedback', () => {
  let h: Harness;
  let docs: DocsRepo;
  /** Site sessions: gus sees everything in 2.x, ann has 1.x without SSO. */
  let gus: string;
  let ann: string;
  /** Embed session for gus. */
  let gusEmbed: string;
  let gusBearer: string;

  // Each request waits for its (unawaited) analytics insert, so row order is request order.
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await h.app.inject({
      method: 'GET',
      url: path,
      headers: { 'x-forwarded-for': CLIENT_IP, ...headers },
    });
    await h.ctx.analytics.flush();
    return res;
  };
  const post = (path: string, form: Record<string, string>, headers: Record<string, string>) =>
    h.app.inject({
      method: 'POST',
      url: path,
      payload: new URLSearchParams(form).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': CLIENT_IP,
        ...headers,
      },
    });
  const events = async () => {
    await h.ctx.analytics.flush();
    const { rows } = await h.db.pool.query<{
      kind: string;
      surface: string;
      org_slug: string;
      release_line: string;
      topic_id: string | null;
      query: string | null;
      result_count: number | null;
    }>(
      'select kind, surface, org_slug, release_line, topic_id, query, result_count from analytics_events order by id',
    );
    return rows;
  };
  const clear = async () => {
    await h.ctx.analytics.flush();
    await h.db.pool.query('truncate analytics_events, analytics_feedback');
  };

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
    gus = await devLogin(h.app, 'gus@globex.example');
    ann = await devLogin(h.app, 'ann@acme.example');
    gusBearer = await token('gus@globex.example', 'globex');
    const exchange = await h.app.inject({
      method: 'POST',
      url: '/embed/session',
      headers: { authorization: `Bearer ${gusBearer}` },
    });
    expect(exchange.statusCode).toBe(204);
    gusEmbed = cookiesFrom(exchange);
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  describe('recording', () => {
    beforeAll(clear);

    it('records site page views with the org and release line', async () => {
      const page = await get('/topics/overview.html', { cookie: gus });
      expect(page.statusCode).toBe(200);
      expect((await get('/topics/configure.html', { cookie: ann })).statusCode).toBe(200);
      // Not found and hidden pages are not views.
      expect((await get('/topics/nope.html', { cookie: gus })).statusCode).toBe(404);
      expect((await get('/topics/configure-sso.html', { cookie: ann })).statusCode).toBe(404);
      expect(await events()).toEqual([
        expect.objectContaining({
          kind: 'view',
          surface: 'site',
          org_slug: 'globex',
          release_line: '2',
          topic_id: 'topics/overview',
        }),
        expect.objectContaining({
          kind: 'view',
          surface: 'site',
          org_slug: 'acme',
          release_line: '1',
          topic_id: 'topics/configure',
        }),
      ]);
    });

    it('records embed panel views and searches', async () => {
      await clear();
      const cookie = { cookie: gusEmbed };
      expect((await get('/embed/topics/topics/install.html', cookie)).statusCode).toBe(200);
      expect((await get('/embed/context?app=console&key=settings.sso', cookie)).statusCode).toBe(
        200,
      );
      expect((await get('/embed/search?q=%20%20Pair%20', cookie)).statusCode).toBe(200);
      expect((await get('/embed/search?q=frobnicate', cookie)).statusCode).toBe(200);
      // An empty search box is not a search.
      expect((await get('/embed/search?q=', cookie)).statusCode).toBe(200);
      const rows = await events();
      expect(rows.map((r) => [r.kind, r.surface, r.topic_id ?? r.query])).toEqual([
        ['view', 'embed', 'topics/install'],
        ['view', 'embed', 'topics/configure-sso'],
        ['search', 'embed', 'pair'],
        ['search', 'embed', 'frobnicate'],
      ]);
      expect(rows[2]!.result_count).toBeGreaterThan(0);
      expect(rows[3]!.result_count).toBe(0);
    });

    it('records JSON API views and searches', async () => {
      await clear();
      const auth = { authorization: `Bearer ${gusBearer}`, origin: HOST };
      expect((await get('/api/v1/help/topics/topics/install', auth)).statusCode).toBe(200);
      expect(
        (await get('/api/v1/help/context?app=console&key=settings.sso', auth)).statusCode,
      ).toBe(200);
      expect((await get('/api/v1/help/topics/topics/nope', auth)).statusCode).toBe(404);
      expect((await get('/api/v1/help/search?q=SSO', auth)).statusCode).toBe(200);
      expect(
        (await events()).map((r) => [r.kind, r.surface, r.org_slug, r.topic_id ?? r.query]),
      ).toEqual([
        ['view', 'api', 'globex', 'topics/install'],
        ['view', 'api', 'globex', 'topics/configure-sso'],
        ['search', 'api', 'globex', 'sso'],
      ]);
    });

    it.each([
      ['DNT', { dnt: '1' }],
      ['Sec-GPC', { 'sec-gpc': '1' }],
    ])('skips views and searches when the browser sends %s', async (_name, optOut) => {
      await clear();
      expect((await get('/topics/overview.html', { cookie: gus, ...optOut })).statusCode).toBe(200);
      expect(
        (await get('/embed/topics/topics/install.html', { cookie: gusEmbed, ...optOut }))
          .statusCode,
      ).toBe(200);
      expect((await get('/embed/search?q=pair', { cookie: gusEmbed, ...optOut })).statusCode).toBe(
        200,
      );
      const auth = { authorization: `Bearer ${gusBearer}`, origin: HOST, ...optOut };
      expect((await get('/api/v1/help/search?q=sso', auth)).statusCode).toBe(200);
      expect(await events()).toEqual([]);
      // DNT: 0 is not an opt-out.
      await get('/topics/overview.html', { cookie: gus, dnt: '0' });
      expect(await events()).toHaveLength(1);
    });

    it('never fails or blocks a page when the analytics insert fails', async () => {
      await clear();
      const logged: Record<string, unknown>[] = [];
      const original = h.ctx.log;
      h.ctx.log = (e) => logged.push(e);
      await h.db.pool.query('alter table analytics_events rename to analytics_events_away');
      try {
        const page = await get('/topics/overview.html', { cookie: gus });
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('<h1 class="title">');
        const search = await get('/embed/search?q=pair', { cookie: gusEmbed });
        expect(search.statusCode).toBe(200);
        await h.ctx.analytics.flush();
      } finally {
        await h.db.pool.query('alter table analytics_events_away rename to analytics_events');
        h.ctx.log = original;
      }
      expect(logged.filter((e) => e.msg === 'analytics insert failed')).toHaveLength(2);
    });
  });

  describe('feedback', () => {
    beforeAll(clear);

    it('shows the form at the bottom of topic pages for signed-in readers', async () => {
      const page = await get('/topics/overview.html', { cookie: gus });
      expect(page.body).toContain('Was this page helpful?');
      expect(page.body).toMatch(/<\/article><section class="opend-feedback"/);
      expect(page.body).toContain('name="topic" value="topics/overview"');
      expect(page.body).toContain('name="return" value="/topics/overview.html"');
      expect(page.body).toContain('maxlength="1000"');
      // Works without JavaScript: the site still runs no scripts.
      expect(page.body).not.toContain('<script');
      expect(page.headers['content-security-policy']).not.toContain('script-src');
      const missing = await get('/topics/nope.html', { cookie: gus });
      expect(missing.body).not.toContain('class="opend-feedback"');
      const panel = await get(
        `/embed/topics/topics/install.html?host=${encodeURIComponent(HOST)}`,
        {
          cookie: gusEmbed,
        },
      );
      expect(panel.body).toContain('name="surface" value="embed"');
      expect(panel.body).toContain(
        `name="return" value="/embed/topics/topics/install.html?host=${encodeURIComponent(HOST)}"`,
      );
    });

    it('requires a signed-in reader and a valid CSRF token from our own origin', async () => {
      const csrf = csrfFrom(await get('/topics/overview.html', { cookie: gus }));
      const form = {
        topic: 'topics/overview',
        helpful: 'yes',
        return: '/topics/overview.html',
        _csrf: csrf,
      };
      expect((await post('/_opend/feedback', form, {})).statusCode).toBe(401);
      expect(
        (await post('/_opend/feedback', { ...form, _csrf: '' }, { cookie: gus })).statusCode,
      ).toBe(403);
      expect(
        (await post('/_opend/feedback', { ...form, _csrf: `${csrf}x` }, { cookie: gus }))
          .statusCode,
      ).toBe(403);
      // Another reader's token does not work with this session.
      const annCsrf = csrfFrom(await get('/topics/configure.html', { cookie: ann }));
      expect(
        (await post('/_opend/feedback', { ...form, _csrf: annCsrf }, { cookie: gus })).statusCode,
      ).toBe(403);
      expect(
        (await post('/_opend/feedback', form, { cookie: gus, origin: 'https://evil.example' }))
          .statusCode,
      ).toBe(403);
      expect(
        (await h.db.pool.query('select count(*)::int as n from analytics_feedback')).rows[0].n,
      ).toBe(0);

      const ok = await post('/_opend/feedback', form, { cookie: gus, origin: DOCS });
      expect(ok.statusCode).toBe(303);
      expect(ok.headers.location).toBe('/topics/overview.html?feedback=thanks#opend-feedback');
      const thanks = await get('/topics/overview.html?feedback=thanks', { cookie: gus });
      expect(thanks.body).toContain('Thanks for your feedback.');
      expect(thanks.body).not.toContain('name="_csrf"');
    });

    it('accepts a comment with No, from the site and the help panel', async () => {
      const csrf = csrfFrom(await get('/topics/install.html', { cookie: gus }));
      const comment = '<script>alert(1)</script> =HYPERLINK("http://evil") needs an example';
      const res = await post(
        '/_opend/feedback',
        {
          topic: 'topics/install',
          helpful: 'no',
          comment,
          _csrf: csrf,
          return: '//evil.example/x',
        },
        { cookie: gus },
      );
      expect(res.statusCode).toBe(303);
      // Off-site return targets fall back to the site root.
      expect(res.headers.location).toBe('/?feedback=thanks#opend-feedback');

      const panelPath = `/embed/topics/topics/configure-sso.html?host=${encodeURIComponent(HOST)}&app=console`;
      const panel = await get(panelPath, { cookie: gusEmbed });
      const embedRes = await post(
        '/_opend/feedback',
        {
          topic: 'topics/configure-sso',
          helpful: 'no',
          surface: 'embed',
          return: panelPath,
          _csrf: csrfFrom(panel),
        },
        { cookie: gusEmbed, origin: DOCS },
      );
      expect(embedRes.statusCode).toBe(303);
      expect(embedRes.headers.location).toBe(`${panelPath}&feedback=thanks#opend-feedback`);

      const tooLong = await post(
        '/_opend/feedback',
        { topic: 'topics/install', helpful: 'no', comment: 'x'.repeat(1001), _csrf: csrf },
        { cookie: gus },
      );
      expect(tooLong.statusCode).toBe(400);
      const bad = await post(
        '/_opend/feedback',
        { topic: 'topics/install', helpful: 'maybe', _csrf: csrf },
        { cookie: gus },
      );
      expect(bad.statusCode).toBe(400);

      const list = (await admin(h.app, 'GET', '/analytics/feedback?days=7')).json() as {
        topicId: string;
        helpful: boolean;
        comment: string | null;
        surface: string;
      }[];
      expect(list.map((f) => [f.topicId, f.helpful, f.surface, f.comment])).toEqual([
        ['topics/configure-sso', false, 'embed', null],
        ['topics/install', false, 'site', comment],
        ['topics/overview', true, 'site', null],
      ]);
      const forInstall = (
        await admin(h.app, 'GET', '/analytics/feedback?topic=topics/install')
      ).json() as unknown[];
      expect(forInstall).toHaveLength(1);
      const commented = (
        await admin(h.app, 'GET', '/analytics/feedback?comments=1')
      ).json() as unknown[];
      expect(commented).toHaveLength(1);

      const csv = await admin(h.app, 'GET', '/analytics/feedback.csv?topic=topics/install');
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toContain('attachment');
      const lines = csv.body.trim().split('\r\n');
      expect(lines[0]).toBe('at,topic,helpful,comment,surface,org,release_line');
      expect(lines[1]).toContain(
        '"topics/install","no","<script>alert(1)</script> =HYPERLINK(""http://evil"") needs an example","site","globex","2"',
      );
    });

    it('gives the same 404 for a hidden topic as for a missing one', async () => {
      const csrf = csrfFrom(await get('/topics/configure.html', { cookie: ann }));
      const send = (topic: string) =>
        post(
          '/_opend/feedback',
          { topic, helpful: 'no', comment: 'hi', _csrf: csrf },
          { cookie: ann },
        );
      const hidden = await send('topics/configure-sso');
      const missing = await send('topics/does-not-exist');
      expect(hidden.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(hidden.body).toBe(missing.body);
      expect(hidden.headers['content-type']).toBe(missing.headers['content-type']);
      expect(hidden.headers['content-length']).toBe(missing.headers['content-length']);
      expect(hidden.body).not.toContain('configure-sso');
      // The same topic is fine for a reader who can see it (gus did above).
      const n = await h.db.pool.query(
        "select count(*)::int as n from analytics_feedback where org_slug = 'acme'",
      );
      expect(n.rows[0].n).toBe(0);
    });
  });

  describe('admin summary', () => {
    it('aggregates top pages, searches, zero-result searches and helpfulness', async () => {
      await clear();
      for (let i = 0; i < 3; i++) await get('/topics/overview.html', { cookie: gus });
      await get('/topics/install.html', { cookie: gus });
      await get('/embed/topics/topics/install.html', { cookie: gusEmbed });
      await get('/topics/configure.html', { cookie: ann });
      await get('/embed/search?q=pair', { cookie: gusEmbed });
      await get('/embed/search?q=PAIR', { cookie: gusEmbed });
      await get('/embed/search?q=frobnicate', { cookie: gusEmbed });
      const csrf = csrfFrom(await get('/topics/overview.html', { cookie: gus }));
      for (const helpful of ['yes', 'yes', 'no'])
        await post(
          '/_opend/feedback',
          { topic: 'topics/overview', helpful, _csrf: csrf },
          { cookie: gus },
        );
      await post(
        '/_opend/feedback',
        { topic: 'topics/install', helpful: 'no', _csrf: csrf },
        { cookie: gus },
      );
      await h.ctx.analytics.flush();

      const res = await admin(h.app, 'GET', '/analytics/summary?days=30');
      expect(res.statusCode).toBe(200);
      const summary = res.json();
      expect(summary).toMatchObject({
        enabled: true,
        days: 30,
        totals: { views: 7, searches: 3, feedback: 4 },
        topPages: [
          { topicId: 'topics/overview', views: 4 },
          { topicId: 'topics/install', views: 2 },
          { topicId: 'topics/configure', views: 1 },
        ],
        zeroResultSearches: [{ query: 'frobnicate', searches: 1 }],
        helpfulness: [
          { topicId: 'topics/install', helpful: 0, unhelpful: 1, ratio: 0 },
          { topicId: 'topics/overview', helpful: 2, unhelpful: 1, ratio: 0.667 },
        ],
      });
      expect(summary.topSearches[0]).toMatchObject({ query: 'pair', searches: 2 });
      expect(summary.viewsBySurface).toEqual([
        { surface: 'site', views: 6 },
        { surface: 'embed', views: 1 },
      ]);
      const acme = (await admin(h.app, 'GET', '/analytics/summary?org=acme')).json();
      expect(acme.totals).toEqual({ views: 1, searches: 0, feedback: 0 });
      expect((await admin(h.app, 'GET', '/analytics/summary?days=0')).statusCode).toBe(400);
      const anon = await h.app.inject({ method: 'GET', url: '/admin/api/analytics/summary' });
      expect(anon.statusCode).toBe(401);
    });

    it('stores no reader email, id or IP address', async () => {
      const columns = await h.db.pool.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_name in ('analytics_events', 'analytics_feedback') order by table_name, ordinal_position`,
      );
      const names = columns.rows.map((c) => c.column_name);
      expect(names).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/email|reader|ip|user|agent/)]),
      );
      const dump = JSON.stringify(
        (
          await h.db.pool.query(
            `select row_to_json(e) as r from analytics_events e
             union all select row_to_json(f) from analytics_feedback f`,
          )
        ).rows,
      );
      expect(dump).toContain('globex');
      const readers = await h.db.pool.query<{ id: number; email: string }>(
        'select id, email from readers',
      );
      for (const r of readers.rows) expect(dump).not.toContain(r.email);
      expect(dump).not.toContain(CLIENT_IP);
      expect(dump).not.toContain('127.0.0.1');
    });
  });

  describe('retention', () => {
    it('purges events and feedback older than the retention period', async () => {
      await h.db.pool.query(
        "update analytics_events set at = now() - interval '200 days' where topic_id = 'topics/overview'",
      );
      await h.db.pool.query(
        "update analytics_feedback set at = now() - interval '200 days' where topic_id = 'topics/overview'",
      );
      const logged: Record<string, unknown>[] = [];
      const purge = startAnalyticsPurge({
        pool: h.db.pool,
        retentionDays: 180,
        log: (e) => logged.push(e),
      });
      await purge.ran;
      await purge.stop();
      expect(logged).toEqual([
        expect.objectContaining({ msg: 'analytics purged', events: 4, feedback: 3 }),
      ]);
      const left = await h.db.pool.query(
        "select count(*)::int as n from analytics_events where topic_id = 'topics/overview'",
      );
      expect(left.rows[0].n).toBe(0);
      const summary = (await admin(h.app, 'GET', '/analytics/summary?days=365')).json();
      expect(summary.totals).toEqual({ views: 3, searches: 3, feedback: 1 });
    });
  });

  describe('with OPEND_ANALYTICS=0', () => {
    let off: OpendApp;
    beforeAll(async () => {
      off = await createApp(
        { ...h.ctx.config, analytics: { enabled: false, retentionDays: 180 } },
        { pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {}, listen: false },
      );
      await off.app.ready();
    });
    afterAll(() => off?.app.close());

    it('records nothing, hides the feedback form and refuses feedback', async () => {
      await clear();
      const page = await off.app.inject({
        method: 'GET',
        url: '/topics/overview.html',
        headers: { cookie: gus },
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('class="opend-feedback"');
      const panel = await off.app.inject({
        method: 'GET',
        url: '/embed/search?q=pair',
        headers: { cookie: gusEmbed },
      });
      expect(panel.statusCode).toBe(200);
      await off.app.inject({
        method: 'GET',
        url: '/embed/topics/topics/install.html',
        headers: { cookie: gusEmbed },
      });
      const csrf = csrfFrom(await get('/topics/overview.html', { cookie: gus, dnt: '1' }));
      const feedback = await off.app.inject({
        method: 'POST',
        url: '/_opend/feedback',
        payload: new URLSearchParams({
          topic: 'topics/overview',
          helpful: 'yes',
          _csrf: csrf,
        }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: gus },
      });
      expect(feedback.statusCode).toBe(404);
      await off.ctx.analytics.flush();
      expect(await events()).toEqual([]);
      expect(
        (await h.db.pool.query('select count(*)::int as n from analytics_feedback')).rows[0].n,
      ).toBe(0);
      const summary = await off.app.inject({
        method: 'GET',
        url: '/admin/api/analytics/summary',
        headers: { authorization: `Bearer ${h.ctx.config.adminToken!}` },
      });
      expect(summary.json()).toMatchObject({ enabled: false });
    });
  });
});

describe('csvField', () => {
  it.each([
    ['plain', '"plain"'],
    ['say "hi"', '"say ""hi"""'],
    ['=1+1', `"'=1+1"`],
    ['+1', `"'+1"`],
    ['-1', `"'-1"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    [null, '""'],
    [true, '"true"'],
  ])('%j → %s', (value, expected) => {
    expect(csvField(value)).toBe(expected);
  });
});
