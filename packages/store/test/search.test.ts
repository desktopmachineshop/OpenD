import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompiledRelease } from '@opend/model';
import {
  conditionKey,
  createTestDatabase,
  enqueueJob,
  claimJob,
  getSearchIndex,
  parseSearchQuery,
  publishRelease,
  scoreDocuments,
  searchCandidates,
  upsertRepo,
  writeSearchIndex,
  type SearchIndexInput,
  type TestDatabase,
} from '../src/index.js';
import { testDatabaseUrl } from '../src/testing.js';

const url = testDatabaseUrl();

describe('parseSearchQuery', () => {
  it.each<[string, { text: string; prefix: string | null }]>([
    ['insta', { text: '', prefix: 'insta:*' }],
    ['install hub', { text: 'install ', prefix: 'hub:*' }],
    ['  install hub  ', { text: 'install ', prefix: 'hub:*' }],
    ['"setup wizard"', { text: '"setup wizard"', prefix: null }],
    ['"setup wiz', { text: '"setup wiz', prefix: null }],
    ['hub -gadget', { text: 'hub -gadget', prefix: null }],
    ['hub or gadget', { text: 'hub or gadget', prefix: null }],
    ['hub or', { text: 'hub or', prefix: null }],
    ['sso.assertion', { text: 'sso.assertion', prefix: null }],
    ['x', { text: 'x', prefix: null }],
    ["it's & | ! :* hub", { text: "it's & | ! :* ", prefix: 'hub:*' }],
  ])('%j', (raw, expected) => {
    expect(parseSearchQuery(raw)).toEqual(expected);
  });
});

describe('conditionKey', () => {
  it('ignores key order and tells different conditions apart', () => {
    expect(conditionKey([{ attrs: { a: '1', b: '2' } }])).toBe(
      conditionKey([{ attrs: { b: '2', a: '1' } }]),
    );
    expect(conditionKey([])).not.toBe(conditionKey([{ attrs: { a: '1' } }]));
  });
});

const snapshot = (release: string): CompiledRelease => ({
  schemaVersion: 1,
  release,
  title: 'Docs',
  builtAt: '2026-10-16T00:00:00Z',
  attributes: {},
  nav: [],
  publications: [],
  topics: {},
  chunkUsage: {},
  assets: [],
});

const SSO = [{ attrs: { feature: 'sso' } }];

const INDEX: SearchIndexInput = {
  format: 1,
  topics: [
    {
      topicId: 'install',
      segments: [
        { text: 'Install the hub', weight: 'A', gates: [] },
        { text: 'Put the hub on a shelf.', weight: 'B', gates: [] },
        { text: 'Run the setup wizard and wait for the network light.', weight: 'C', gates: [] },
      ],
    },
    {
      topicId: 'network',
      segments: [
        { text: 'Network settings', weight: 'A', gates: [] },
        { text: 'After you install the hub, change the network name.', weight: 'C', gates: [] },
        { text: 'Federation trust for single sign-on.', weight: 'C', gates: SSO },
      ],
    },
    {
      topicId: 'sso',
      segments: [{ text: 'Federation settings', weight: 'A', gates: SSO }],
    },
  ],
};

describe.skipIf(!url)('search index in Postgres', () => {
  let db: TestDatabase;
  let releaseId: number;
  const all = [conditionKey([]), conditionKey(SSO)];
  const open = [conditionKey([])];
  const ids = async (q: string, keys = all) =>
    (
      await searchCandidates(db.pool, {
        releaseId,
        query: parseSearchQuery(q),
        visibleKeys: keys,
        limit: 10,
      })
    ).map((c) => c.topicId);

  beforeAll(async () => {
    db = await createTestDatabase(url!);
    const repo = await upsertRepo(db.pool, { fullName: 'acme/docs', sourceUrl: '/tmp/x' });
    await enqueueJob(db.pool, { repoId: repo.id, ref: 'main', sha: 'a'.repeat(40) });
    const job = (await claimJob(db.pool))!;
    ({ releaseId } = await publishRelease(db.pool, {
      jobId: job.id,
      repoId: repo.id,
      ref: 'main',
      sha: job.sha,
      releaseLine: '2',
      snapshot: snapshot('2.1'),
      diagnostics: [],
      searchIndex: INDEX,
    }));
  });
  afterAll(async () => db?.drop());

  it('stores conditions and tsvectors, but no readable text', async () => {
    const index = await getSearchIndex(db.pool, releaseId);
    expect(index?.format).toBe(1);
    expect(index?.conditions.map((c) => c.gates)).toEqual(expect.arrayContaining([[], SSO]));
    const columns = await db.pool.query<{ table_name: string; data_type: string }>(
      `select table_name, data_type from information_schema.columns
       where table_name like 'search_%' and data_type = 'text' and column_name not in ('topic_id', 'cond_key')`,
    );
    expect(columns.rows).toEqual([]);
    expect(await getSearchIndex(db.pool, releaseId + 999)).toBeNull();
  });

  it('ranks title matches above body matches, and stems', async () => {
    expect(await ids('install')).toEqual(['install', 'network']);
    expect(await ids('installing hubs')).toEqual(['install', 'network']);
    expect(await ids('network')).toEqual(['network', 'install']);
  });

  it('takes websearch syntax: phrases, or, exclusion', async () => {
    expect(await ids('"setup wizard"')).toEqual(['install']);
    expect(await ids('"wizard setup"')).toEqual([]);
    expect((await ids('shelf or federation')).sort()).toEqual(['install', 'network', 'sso']);
    expect(await ids('hub -shelf')).toEqual(['network']);
  });

  it('matches the last word as a prefix', async () => {
    expect(await ids('wiz')).toEqual(['install']);
    expect(await ids('install netw')).toEqual(['network', 'install']);
    expect(await ids('"wiz"')).toEqual([]);
  });

  it('ignores words behind conditions the reader does not pass', async () => {
    expect(await ids('federation')).toEqual(['sso', 'network']);
    expect(await ids('federation', open)).toEqual([]);
    expect(await ids('network federation', open)).toEqual([]);
    expect(await ids('network', open)).toEqual(['network', 'install']);
    expect(await ids('', all)).toEqual([]);
    expect(await ids('the', all)).toEqual([]);
  });

  it('scores and quotes only the documents it is given', async () => {
    const scored = await scoreDocuments(db.pool, parseSearchQuery('wizard'), [
      {
        topicId: 'install',
        title: 'Install the hub',
        shortdesc: 'Put the hub on a shelf.',
        body: 'Run the setup wizard and wait for the network light.',
      },
      { topicId: 'other', title: 'Other', shortdesc: '', body: 'Nothing here.' },
    ]);
    expect(scored).toHaveLength(1);
    expect(scored[0]).toMatchObject({ topicId: 'install' });
    expect(scored[0]!.snippet).toContain('setup wizard');
    expect(await scoreDocuments(db.pool, parseSearchQuery('wizard'), [])).toEqual([]);
  });

  it('replaces an index on rewrite and deletes it with its release', async () => {
    await writeSearchIndex(db.pool, releaseId, { format: 1, topics: INDEX.topics.slice(0, 1) });
    expect(await ids('network')).toEqual(['install']);
    await db.pool.query('update build_jobs set release_id = null');
    await db.pool.query('delete from live_releases');
    await db.pool.query('delete from releases where id = $1', [releaseId]);
    for (const table of [
      'search_indexes',
      'search_conditions',
      'search_segments',
      'search_topics',
    ]) {
      const { rows } = await db.pool.query<{ n: number }>(
        `select count(*)::int as n from ${table}`,
      );
      expect(rows[0]!.n).toBe(0);
    }
  });
});
