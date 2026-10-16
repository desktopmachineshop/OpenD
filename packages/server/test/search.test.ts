import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ReaderContext } from '@opend/model';
import { searchView, type SearchHit } from '@opend/filter';
import { FsBlobStore, enqueueJob, getSearchIndex, testDatabaseUrl, upsertRepo } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { MARKERS } from '../../cli/test/markers.js';
import {
  readerRelease,
  runReindexCommand,
  searchRelease,
  type ReaderRelease,
} from '../src/index.js';
import { STARTER, startHarness, type Harness } from './helpers.js';

const url = testDatabaseUrl();

const preview = parse(readFileSync(join(STARTER, 'preview-contexts.yaml'), 'utf8')) as {
  contexts: Record<string, { products?: string[]; features?: string[]; version: string }>;
};
const READERS: [string, ReaderContext][] = [
  ...Object.entries(preview.contexts).map(([name, c]): [string, ReaderContext] => [
    name,
    { products: c.products ?? [], features: c.features ?? [], version: c.version },
  ]),
  ['nobody-v2', { products: [], features: [], version: '2.1' }],
  ['sso-only-v1', { products: ['widget'], features: ['sso'], version: '1.2' }],
];

const SSO = { products: ['widget'], features: ['sso'], version: '2.1' };
const BASIC = { products: ['widget'], features: [], version: '2.1' };

// Extra topics for the section-level cases. "Zanzibar" and "quokka" appear only
// in the sso section of `sections`; "mango" appears once in its open section
// and three times in its sso section. `twin` is `sections` without the sso
// section, for comparing scores.
const SECTIONS = `<topic id="sections"><title>Section rules</title>
  <shortdesc>How sections behave.</shortdesc>
  <body>
    <section id="open"><title>Open part</title><p>Everyone reads about the mango here.</p></section>
    <section id="private" feature="sso"><title>Federation part</title>
      <p>Zanzibar quokka mango mango mango.</p></section>
  </body>
</topic>`;
const TWIN = `<topic id="twin"><title>Twin rules</title>
  <shortdesc>How sections behave.</shortdesc>
  <body>
    <section id="open"><title>Open part</title><p>Everyone reads about the mango here.</p></section>
  </body>
</topic>`;
// Visible to everyone only because of a section only sso readers can see.
const ONLY_SECTION = `<topic id="only-section"><title>Plain page</title>
  <body><p>Nothing special.</p><section feature="sso"><p>Wombat details.</p></section></body>
</topic>`;

describe.skipIf(!url)('hosted search over Postgres', () => {
  let h: Harness;
  let docs: DocsRepo;
  const deps = () => ({ pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} });
  const release = async (context: ReaderContext): Promise<ReaderRelease> => {
    const r = await readerRelease(h.ctx, context);
    if (typeof r === 'string') throw new Error(r);
    return r;
  };
  const search = async (context: ReaderContext, q: string) =>
    searchRelease(h.db.pool, await release(context), q);
  const ids = async (context: ReaderContext, q: string) =>
    (await search(context, q)).map((hit) => hit.topicId);

  beforeAll(async () => {
    h = await startHarness(url!);
    docs = createDocsRepo(STARTER);
    const map = readFileSync(join(STARTER, 'maps/user-guide.ditamap'), 'utf8');
    const config = readFileSync(join(STARTER, 'opend.config.yaml'), 'utf8');
    const extra = {
      'maps/user-guide.ditamap': map.replace(
        '<topicref href="../topics/overview.dita"/>',
        `<topicref href="../topics/overview.dita"/>
  <topicref href="../topics/sections.dita"/>
  <topicref href="../topics/twin.dita"/>
  <topicref href="../topics/only-section.dita"/>`,
      ),
      'topics/sections.dita': SECTIONS,
      'topics/twin.dita': TWIN,
      'topics/only-section.dita': ONLY_SECTION,
    };
    const main = docs.commit(extra);
    const v1 = docs.commit({
      ...extra,
      'opend.config.yaml': config.replace(/^release: .*$/m, 'release: "1.4"'),
    });
    const repo = await upsertRepo(h.db.pool, {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      releaseRefs: ['main', 'v*'],
    });
    await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'main', sha: main });
    await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'v1', sha: v1 });
    expect(await processNext(deps())).toBe('published');
    expect(await processNext(deps())).toBe('published');
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('searches through the index, not in memory', async () => {
    const r = await release(SSO);
    expect(await getSearchIndex(h.db.pool, r.stored.id)).not.toBeNull();
  });

  it('ranks title matches first, stems, and takes websearch syntax', async () => {
    expect((await ids(BASIC, 'configure'))[0]).toBe('topics/configure');
    expect(await ids(BASIC, 'installing')).toContain('topics/install');
    expect((await ids(BASIC, '"setup wizard"'))[0]).toBe('topics/install');
    expect(await ids(BASIC, '"wizard setup"')).toEqual([]);
    expect(await ids(BASIC, 'hub -wizard')).not.toContain('topics/install');
  });

  it('completes the last word as a prefix', async () => {
    expect((await ids(BASIC, 'wiza'))[0]).toBe('topics/install');
    expect((await ids(BASIC, 'setup wiz'))[0]).toBe('topics/install');
    expect(await ids(BASIC, 'zzwiza')).toEqual([]);
  });

  it('keeps the response shape: hits with topicId, title, snippet and score', async () => {
    const [hit] = await search(BASIC, 'wizard');
    expect(Object.keys(hit!).sort()).toEqual(['score', 'snippet', 'title', 'topicId']);
    expect(hit!.title).toBe('Install the Widget Platform');
    expect(hit!.snippet).toContain('setup wizard');
    expect(hit!.score).toBeGreaterThan(0);
    expect(await search(BASIC, '')).toEqual([]);
    expect(await search(BASIC, 'the')).toEqual([]);
  });

  describe('sections a reader cannot see', () => {
    it('never match on their words', async () => {
      for (const q of ['zanzibar', 'quokka', 'federation', 'zanzib', '"zanzibar quokka"']) {
        expect(await ids(BASIC, q)).toEqual([]);
      }
      expect(await ids(BASIC, 'mango zanzibar')).toEqual([]);
      expect(await ids(SSO, 'zanzibar')).toEqual(['topics/sections']);
      expect(await ids(SSO, 'zanzib')).toEqual(['topics/sections']);
    });

    it('never find a topic through its hidden section', async () => {
      expect(await ids(BASIC, 'wombat')).toEqual([]);
      expect(await ids(SSO, 'wombat')).toEqual(['topics/only-section']);
      expect(await ids(BASIC, 'plain')).toEqual(['topics/only-section']);
    });

    it('never affect the score, title or snippet', async () => {
      const basic = await search(BASIC, 'mango');
      expect(basic.map((h) => h.topicId).sort()).toEqual(['topics/sections', 'topics/twin']);
      expect(basic[0]!.score).toBe(basic[1]!.score);
      for (const hit of basic) expect(hit.snippet).not.toMatch(/zanzibar|quokka|federation/i);
      const sso = await search(SSO, 'mango');
      expect(sso[0]!.topicId).toBe('topics/sections');
      expect(sso[0]!.score).toBeGreaterThan(sso[1]!.score);
    });
  });

  const QUERIES = [
    ...new Set(
      MARKERS.flatMap(([phrase]) => phrase.toLowerCase().split(/[^a-z0-9.]+/)).filter(
        (w) => w.length >= 2,
      ),
    ),
    'pair',
    'sso',
    'installer',
    'audit',
    'release',
    'edition',
    'escalation',
    'internal',
  ];
  const phraseQuery = (phrase: string) => `"${phrase.replace(/[^\p{L}\p{N}.\s-]/gu, ' ').trim()}"`;

  describe.each(READERS)('leak markers through search: %s', (_name, context) => {
    let text: string;
    let hits: SearchHit[];
    let r: ReaderRelease;
    beforeAll(async () => {
      r = await release(context);
      hits = (await Promise.all(QUERIES.map((q) => searchRelease(h.db.pool, r, q)))).flat();
      text = hits.map((hit) => `${hit.title}\n${hit.snippet}`).join('\n');
    });

    it('returns only topics the reader can see', () => {
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(r.view.isVisible(hit.topicId)).toBe(true);
    });

    it.each(MARKERS.filter(([phrase]) => phrase !== '>Gadget<'))('%s', async (phrase, rule) => {
      const visible = rule(context);
      if (!visible) expect(text).not.toContain(phrase);
      const found = await searchRelease(h.db.pool, r, phraseQuery(phrase));
      if (visible) expect(found.length).toBeGreaterThan(0);
      else expect(found).toEqual([]);
    });
  });

  describe('fallback and reindexing', () => {
    it('searches in memory when a release has no index, until it is reindexed', async () => {
      const r = await release(SSO);
      await h.db.pool.query('delete from search_indexes where release_id = $1', [r.stored.id]);
      expect(await getSearchIndex(h.db.pool, r.stored.id)).toBeNull();
      expect(await search(SSO, 'installer')).toEqual(searchView(r.view, 'installer'));
      expect(await ids(SSO, 'wizards')).toEqual([]); // no stemming in memory

      const logs: Record<string, unknown>[] = [];
      const results = await runReindexCommand(
        { databaseUrl: h.db.url },
        { release: String(r.stored.id) },
        { pool: h.db.pool, log: (e) => logs.push(e) },
      );
      expect(results).toEqual([expect.objectContaining({ releaseId: r.stored.id, topics: 11 })]);
      expect(logs.at(-1)).toMatchObject({ msg: 'reindex finished', releases: 1 });
      expect((await ids(SSO, 'wizards'))[0]).toBe('topics/install');
    });

    it('ignores an index written in another format', async () => {
      const r = await release(BASIC);
      await h.db.pool.query('update search_indexes set format = 0 where release_id = $1', [
        r.stored.id,
      ]);
      expect(await search(BASIC, 'installer')).toEqual(searchView(r.view, 'installer'));
      const all = await runReindexCommand(
        { databaseUrl: h.db.url },
        {},
        { pool: h.db.pool, log: () => {} },
      );
      expect(all.map((x) => x.releaseId).sort()).toEqual(
        (await h.db.pool.query<{ id: number }>('select id from releases order by id')).rows.map(
          (x) => x.id,
        ),
      );
      expect((await getSearchIndex(h.db.pool, r.stored.id))?.format).toBe(1);
    });

    it('rejects a bad or unknown release id', async () => {
      const run = (release: string) =>
        runReindexCommand(
          { databaseUrl: h.db.url },
          { release },
          { pool: h.db.pool, log: () => {} },
        );
      await expect(run('abc')).rejects.toThrow(/release id/);
      await expect(run('999999')).rejects.toThrow(/no release 999999/);
    });
  });
});
