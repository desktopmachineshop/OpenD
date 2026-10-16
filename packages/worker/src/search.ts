import type { CompiledRelease } from '@opend/model';
import { SEARCH_INDEX_FORMAT, searchSegments } from '@opend/filter';
import {
  getReleaseSnapshot,
  listReleaseIds,
  withTransaction,
  writeSearchIndex,
  type Pool,
  type SearchIndexInput,
} from '@opend/store';

/**
 * The search index rows for a built release: every topic's segments with the
 * conditions they sit behind. Readers' filters are applied at query time.
 */
export function searchIndexInput(release: CompiledRelease): SearchIndexInput {
  return {
    format: SEARCH_INDEX_FORMAT,
    topics: Object.values(release.topics).map((topic) => ({
      topicId: topic.id,
      segments: searchSegments(topic.body),
    })),
  };
}

export interface ReindexResult {
  releaseId: number;
  topics: number;
  segments: number;
}

/** Rebuilds the search index of one stored release. `null` when there is no such release. */
export async function reindexRelease(pool: Pool, releaseId: number): Promise<ReindexResult | null> {
  return withTransaction(pool, async (client) => {
    // Locks the release row, so concurrent reindexes of one release queue up.
    const lock = await client.query('select id from releases where id = $1 for update', [
      releaseId,
    ]);
    if (lock.rowCount === 0) return null;
    const snapshot = await getReleaseSnapshot(client, releaseId);
    if (!snapshot) return null;
    const counts = await writeSearchIndex(client, releaseId, searchIndexInput(snapshot));
    return { releaseId, ...counts };
  });
}

/** Rebuilds the search index of every stored release, one transaction each. */
export async function reindexAll(pool: Pool): Promise<ReindexResult[]> {
  const results: ReindexResult[] = [];
  for (const id of await listReleaseIds(pool)) {
    const result = await reindexRelease(pool, id);
    if (result) results.push(result);
  }
  return results;
}
