import { createHash } from 'node:crypto';
import type { Db } from './db.js';

/** A run of topic text with the conditions it sits behind (see `searchSegments` in @opend/filter). */
export interface SearchSegmentInput {
  text: string;
  weight: 'A' | 'B' | 'C';
  /** Opaque to the store; hashed into a condition key and handed back by `getSearchIndex`. */
  gates: unknown[];
}

export interface SearchIndexInput {
  /** Version of the segmentation, so readers can ignore an index they do not understand. */
  format: number;
  topics: { topicId: string; segments: SearchSegmentInput[] }[];
}

export interface StoredSearchIndex {
  format: number;
  conditions: { key: string; gates: unknown[] }[];
}

/** JSON with object keys sorted, so equal values serialise identically. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function conditionKey(gates: unknown[]): string {
  return createHash('sha256').update(canonical(gates)).digest('hex').slice(0, 32);
}

const CHUNK = 2000;

/**
 * Replaces a release's search index. Run it inside a transaction (as
 * `publishRelease` and `reindexRelease` do) so readers never see half an index.
 * Text is turned into tsvectors by Postgres and not stored.
 */
export async function writeSearchIndex(
  db: Db,
  releaseId: number,
  input: SearchIndexInput,
): Promise<{ topics: number; segments: number }> {
  await db.query('delete from search_indexes where release_id = $1', [releaseId]);
  await db.query('insert into search_indexes (release_id, format) values ($1, $2)', [
    releaseId,
    input.format,
  ]);
  const conditions = new Map<string, unknown[]>();
  const rows: { topic: string; seq: number; key: string; text: string; weight: string }[] = [];
  for (const topic of input.topics) {
    topic.segments.forEach((s, seq) => {
      const key = conditionKey(s.gates);
      conditions.set(key, s.gates);
      rows.push({ topic: topic.topicId, seq, key, text: s.text, weight: s.weight });
    });
  }
  const keys = [...conditions.keys()];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    await db.query(
      `insert into search_conditions (release_id, cond_key, gates)
       select $1, k, g::jsonb from unnest($2::text[], $3::text[]) as t(k, g)`,
      [releaseId, chunk, chunk.map((k) => JSON.stringify(conditions.get(k)))],
    );
  }
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db.query(
      `insert into search_segments (release_id, topic_id, seq, cond_key, tsv)
       select $1, t.topic, t.seq, t.key, setweight(to_tsvector('english', t.body), t.weight::"char")
       from unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[])
         as t(topic, seq, key, body, weight)`,
      [
        releaseId,
        chunk.map((r) => r.topic),
        chunk.map((r) => r.seq),
        chunk.map((r) => r.key),
        chunk.map((r) => r.text),
        chunk.map((r) => r.weight),
      ],
    );
  }
  const topics = await db.query(
    `insert into search_topics (release_id, topic_id, tsv)
     select $1, topic_id, opend_tsvector_agg(tsv order by seq) from search_segments
     where release_id = $1 group by topic_id`,
    [releaseId],
  );
  return { topics: topics.rowCount ?? 0, segments: rows.length };
}

/** The release's index format and conditions, or `null` when it has no index. */
export async function getSearchIndex(db: Db, releaseId: number): Promise<StoredSearchIndex | null> {
  const { rows } = await db.query<StoredSearchIndex>(
    `select i.format, coalesce(
       (select json_agg(json_build_object('key', c.cond_key, 'gates', c.gates))
        from search_conditions c where c.release_id = i.release_id), '[]') as conditions
     from search_indexes i where i.release_id = $1`,
    [releaseId],
  );
  return rows[0] ?? null;
}

/**
 * A reader's query as Postgres takes it: `websearch_to_tsquery` syntax (quoted
 * phrases, `or`, `-word`), with the last bare word also matching as a prefix so
 * search-as-you-type finds `installer` from `insta`.
 */
export interface SearchQuery {
  text: string;
  /** `word:*` for to_tsquery, or null when the last term is not a bare word. */
  prefix: string | null;
}

export function parseSearchQuery(raw: string): SearchQuery {
  const query = raw.trim().slice(0, 500);
  const last = /(^|\s)([\p{L}\p{N}]{2,})$/u.exec(query);
  const quotes = (query.match(/"/g) ?? []).length;
  if (!last || quotes % 2 === 1) return { text: query, prefix: null };
  const head = query.slice(0, query.length - last[2]!.length);
  // `or` changes how websearch groups terms; adding an AND to it would change the meaning.
  if (/(^|\s)or(\s|$)/i.test(head) || last[2]!.toLowerCase() === 'or')
    return { text: query, prefix: null };
  return { text: head, prefix: `${last[2]!}:*` };
}

/** SQL for the tsquery, with the query text and prefix in parameters `$t` and `$p`. */
function tsquerySql(t: number, p: number): string {
  return `(case when $${p}::text is null then websearch_to_tsquery('english', $${t})
    else websearch_to_tsquery('english', $${t})
      && (to_tsquery('english', $${p}) || to_tsquery('simple', $${p})) end)`;
}

export interface SearchCandidate {
  topicId: string;
  rank: number;
}

/**
 * Topics that match the query on the segments behind `visibleKeys` alone, best
 * first. Words in segments behind other conditions neither match nor rank.
 * With `topicIds`, only those topics are considered, so topics the reader
 * cannot see (for example behind a map condition) never take up the limit.
 * The caller must still check each candidate against the reader's view.
 */
export async function searchCandidates(
  db: Db,
  input: {
    releaseId: number;
    query: SearchQuery;
    visibleKeys: string[];
    topicIds?: string[];
    limit: number;
  },
): Promise<SearchCandidate[]> {
  const { rows } = await db.query<SearchCandidate>(
    `with q as (select ${tsquerySql(2, 3)} as q),
     cand as (
       select t.topic_id from search_topics t, q
       where t.release_id = $1 and numnode(q.q) > 0 and t.tsv @@ q.q
         and ($6::text[] is null or t.topic_id = any($6::text[]))
     ),
     vis as (
       select s.topic_id, opend_tsvector_agg(s.tsv order by s.seq) as tsv
       from search_segments s join cand on cand.topic_id = s.topic_id
       where s.release_id = $1 and s.cond_key = any($4::text[])
       group by s.topic_id
     )
     select vis.topic_id as "topicId", ts_rank(vis.tsv, q.q)::float8 as rank
     from vis, q where vis.tsv @@ q.q
     order by rank desc, vis.topic_id limit $5`,
    [
      input.releaseId,
      input.query.text,
      input.query.prefix,
      input.visibleKeys,
      input.limit,
      input.topicIds ?? null,
    ],
  );
  return rows;
}

export interface SearchDocument {
  topicId: string;
  title: string;
  shortdesc: string;
  body: string;
}

export interface ScoredDocument {
  topicId: string;
  rank: number;
  /** Plain text around the best match, taken from the document's own text. */
  snippet: string;
}

/**
 * Matches, ranks and quotes documents the caller supplies (a reader's filtered
 * topics), so nothing in the result can come from text the reader cannot see.
 * Documents that do not match are left out.
 */
export async function scoreDocuments(
  db: Db,
  query: SearchQuery,
  docs: SearchDocument[],
): Promise<ScoredDocument[]> {
  if (docs.length === 0) return [];
  const { rows } = await db.query<ScoredDocument>(
    `with q as (select ${tsquerySql(1, 2)} as q),
     d as (
       select d.topic_id, d.shortdesc, d.body,
         setweight(to_tsvector('english', d.title), 'A')
           || setweight(to_tsvector('english', d.shortdesc), 'B')
           || setweight(to_tsvector('english', d.body), 'C') as tsv
       from unnest($3::text[], $4::text[], $5::text[], $6::text[]) as d(topic_id, title, shortdesc, body)
     )
     select d.topic_id as "topicId", ts_rank(d.tsv, q.q)::float8 as rank,
       ts_headline('english', case when d.body <> '' then d.body else d.shortdesc end, q.q,
         'StartSel="", StopSel="", MaxWords=30, MinWords=12, MaxFragments=1') as snippet
     from d, q where numnode(q.q) > 0 and d.tsv @@ q.q`,
    [
      query.text,
      query.prefix,
      docs.map((d) => d.topicId),
      docs.map((d) => d.title),
      docs.map((d) => d.shortdesc),
      docs.map((d) => d.body),
    ],
  );
  return rows;
}
