import { displayText, firstChild } from '@opend/model';
import type { ReleaseView } from './view.js';

export interface SearchHit {
  topicId: string;
  title: string;
  /** Plain text around the first match (not HTML-escaped). */
  snippet: string;
  score: number;
}

interface Indexed {
  topicId: string;
  title: string;
  shortdesc: string;
  body: string;
  lower: { title: string; shortdesc: string; body: string };
}

const indexes = new WeakMap<ReleaseView, Indexed[]>();

/** Text of the reader's visible topics, built once per view (and so per entitlement set). */
function indexOf(view: ReleaseView): Indexed[] {
  let index = indexes.get(view);
  if (!index) {
    index = view.topicIds().map((topicId) => {
      const topic = view.topic(topicId)!;
      const shortdescEl = firstChild(topic.body, 'shortdesc');
      const shortdesc = shortdescEl ? displayText(shortdescEl) : '';
      const body = displayText(topic.body);
      return {
        topicId,
        title: topic.title,
        shortdesc,
        body,
        lower: {
          title: topic.title.toLowerCase(),
          shortdesc: shortdesc.toLowerCase(),
          body: body.toLowerCase(),
        },
      };
    });
    indexes.set(view, index);
  }
  return index;
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (
    let i = haystack.indexOf(needle);
    i !== -1 && n < 20;
    i = haystack.indexOf(needle, i + needle.length)
  )
    n++;
  return n;
}

function snippetOf(entry: Indexed, terms: string[]): string {
  const source = entry.body;
  const at = Math.min(...terms.map((t) => entry.lower.body.indexOf(t)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return entry.shortdesc || source.slice(0, 160);
  const start = Math.max(0, at - 60);
  const end = Math.min(source.length, at + 100);
  return `${start > 0 ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`;
}

/**
 * Searches the topics this reader can see, and nothing else, so results and
 * snippets cannot reveal hidden content. Every term must appear; titles weigh
 * most, then short descriptions, then body text.
 */
export function searchView(view: ReleaseView, query: string, limit = 10): SearchHit[] {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 2),
    ),
  ];
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of indexOf(view)) {
    let score = 0;
    let all = true;
    for (const term of terms) {
      const s =
        count(entry.lower.title, term) * 10 +
        count(entry.lower.shortdesc, term) * 3 +
        count(entry.lower.body, term);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (all)
      hits.push({
        topicId: entry.topicId,
        title: entry.title,
        snippet: snippetOf(entry, terms),
        score,
      });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}
