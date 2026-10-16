import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  analyticsSummary,
  createTestDatabase,
  listFeedback,
  normaliseQuery,
  purgeAnalytics,
  recordAnalyticsEvent,
  recordFeedback,
  type TestDatabase,
} from '../src/index.js';
import { testDatabaseUrl } from '../src/testing.js';

const url = testDatabaseUrl();

describe('analytics migration', () => {
  it('is 005_analytics, leaving 004 free', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toContain('005_analytics');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('normaliseQuery', () => {
  it.each([
    ['  Single   Sign-On ', 'single sign-on'],
    ['ＳＳＯ', 'sso'],
    ['reset for ann@acme.example please', 'reset for [email] please'],
    ['card 4111 1111 1111 1111', 'card [number]'],
    ['error 404', 'error 404'],
    ['', ''],
  ])('%j → %j', (raw, normalised) => {
    expect(normaliseQuery(raw)).toBe(normalised);
  });

  it('caps the length', () => {
    expect(normaliseQuery('a'.repeat(500))).toHaveLength(200);
  });
});

describe.skipIf(!url)('analytics store', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(url!);
  });
  afterAll(async () => db?.drop());

  const base = { orgSlug: 'acme', releaseLine: '2' } as const;

  it('aggregates views, searches and feedback', async () => {
    for (const [topicId, n] of [
      ['topics/a', 3],
      ['topics/b', 1],
    ] as const)
      for (let i = 0; i < n; i++)
        await recordAnalyticsEvent(db.pool, { ...base, kind: 'view', surface: 'site', topicId });
    await recordAnalyticsEvent(db.pool, {
      ...base,
      orgSlug: 'globex',
      kind: 'view',
      surface: 'embed',
      topicId: 'topics/b',
    });
    for (const [query, resultCount] of [
      ['sso', 2],
      ['sso', 4],
      ['frobnicate', 0],
    ] as const)
      await recordAnalyticsEvent(db.pool, {
        ...base,
        kind: 'search',
        surface: 'api',
        query,
        resultCount,
      });
    await recordFeedback(db.pool, { ...base, surface: 'site', topicId: 'topics/a', helpful: true });
    await recordFeedback(db.pool, {
      ...base,
      surface: 'site',
      topicId: 'topics/a',
      helpful: false,
      comment: '  needs an example  ',
    });
    await recordFeedback(db.pool, {
      ...base,
      surface: 'embed',
      topicId: 'topics/b',
      helpful: false,
      comment: '   ',
    });

    const summary = await analyticsSummary(db.pool, { days: 30, limit: 10 });
    expect(summary.totals).toEqual({ views: 5, searches: 3, feedback: 3 });
    expect(summary.topPages).toEqual([
      { topicId: 'topics/a', views: 3 },
      { topicId: 'topics/b', views: 2 },
    ]);
    expect(summary.viewsBySurface).toEqual([
      { surface: 'site', views: 4 },
      { surface: 'embed', views: 1 },
    ]);
    expect(summary.topSearches).toEqual([
      { query: 'sso', searches: 2, avgResults: 3 },
      { query: 'frobnicate', searches: 1, avgResults: 0 },
    ]);
    expect(summary.zeroResultSearches).toEqual([{ query: 'frobnicate', searches: 1 }]);
    expect(summary.helpfulness).toEqual([
      { topicId: 'topics/b', helpful: 0, unhelpful: 1, ratio: 0 },
      { topicId: 'topics/a', helpful: 1, unhelpful: 1, ratio: 0.5 },
    ]);

    const globex = await analyticsSummary(db.pool, { days: 30, limit: 10, orgSlug: 'globex' });
    expect(globex.totals).toEqual({ views: 1, searches: 0, feedback: 0 });

    const comments = await listFeedback(db.pool, { days: 30, limit: 10, withComment: true });
    expect(comments.map((c) => c.comment)).toEqual(['needs an example']);
    const forB = await listFeedback(db.pool, { days: 30, limit: 10, topicId: 'topics/b' });
    expect(forB).toHaveLength(1);
    expect(forB[0]!.comment).toBeNull();
  });

  it('rejects over-long comments at the database too', async () => {
    await expect(
      db.pool.query(
        `insert into analytics_feedback (surface, org_slug, release_line, topic_id, helpful, comment)
         values ('site', 'acme', '2', 't', false, $1)`,
        ['x'.repeat(1001)],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('purges rows older than the retention period', async () => {
    await db.pool.query(`update analytics_events set at = now() - interval '200 days'
      where topic_id = 'topics/b'`);
    await db.pool.query(`update analytics_feedback set at = now() - interval '200 days'
      where topic_id = 'topics/b'`);
    expect(await purgeAnalytics(db.pool, 180)).toEqual({ events: 2, feedback: 1 });
    expect(await purgeAnalytics(db.pool, 180)).toEqual({ events: 0, feedback: 0 });
    const summary = await analyticsSummary(db.pool, { days: 365, limit: 10 });
    expect(summary.totals).toEqual({ views: 3, searches: 3, feedback: 2 });
  });
});
