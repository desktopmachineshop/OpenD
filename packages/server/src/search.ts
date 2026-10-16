import {
  SEARCH_INDEX_FORMAT,
  searchText,
  searchView,
  type SearchGate,
  type SearchHit,
  type SearchText,
} from '@opend/filter';
import {
  getSearchIndex,
  parseSearchQuery,
  scoreDocuments,
  searchCandidates,
  type Db,
} from '@opend/store';
import type { ReaderRelease } from './delivery.js';

/** Over-fetch from the index, since a candidate can still fail the view re-check. */
const CANDIDATE_FACTOR = 3;

/** `…text…` with ellipses where the snippet does not reach the ends of `source`. */
function ellipsize(snippet: string, source: string): string {
  const trimmed = snippet.trim();
  const at = source.indexOf(trimmed);
  if (at === -1) return trimmed;
  return `${at > 0 ? '…' : ''}${trimmed}${at + trimmed.length < source.length ? '…' : ''}`;
}

/**
 * Searches one reader's view of a stored release with Postgres full-text
 * search. The index only proposes topic ids and is consulted only for segments
 * behind conditions this reader passes. Every candidate is then re-checked
 * against the reader's view, and matched, ranked and quoted from the filtered
 * topic text alone, so hidden text can never reach a title, a snippet or a
 * score. Releases without a (current) index use the in-memory `searchView`.
 */
export async function searchRelease(
  db: Db,
  release: ReaderRelease,
  query: string,
  limit = 10,
): Promise<SearchHit[]> {
  const { view } = release;
  const index = await getSearchIndex(db, release.stored.id);
  if (!index || index.format !== SEARCH_INDEX_FORMAT) return searchView(view, query, limit);
  const parsed = parseSearchQuery(query);
  if (!parsed.text.trim() && !parsed.prefix) return [];

  const visibleKeys = index.conditions
    .filter((c) => view.passes(c.gates as SearchGate[]))
    .map((c) => c.key);
  const candidates = await searchCandidates(db, {
    releaseId: release.stored.id,
    query: parsed,
    visibleKeys,
    topicIds: view.topicIds(),
    limit: limit * CANDIDATE_FACTOR,
  });

  const texts = new Map<string, SearchText>();
  for (const { topicId } of candidates) {
    const topic = view.topic(topicId);
    if (topic) texts.set(topicId, searchText(topic.body));
  }
  const scored = await scoreDocuments(
    db,
    parsed,
    [...texts].map(([topicId, t]) => ({ topicId, ...t })),
  );
  return scored
    .map((s) => {
      const text = texts.get(s.topicId)!;
      return {
        topicId: s.topicId,
        title: view.topic(s.topicId)!.title,
        snippet: ellipsize(s.snippet, text.body || text.shortdesc),
        score: Math.round(s.rank * 1e6) / 1e6,
      };
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}
