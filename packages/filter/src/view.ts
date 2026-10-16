import {
  displayText,
  firstChild,
  type CompiledRelease,
  type CompiledTopic,
  type NavEntry,
} from '@opend/model';
import { filterTree, isIncluded, type FilterPolicy, type FilterTreeOptions } from './policy.js';

/**
 * One reader's view of a release. Navigation, pages and (later) search and PDF
 * all go through a view, so nothing reaches a reader without passing the same
 * filter.
 */
export interface ReleaseView {
  readonly release: CompiledRelease;
  /**
   * Navigation with excluded entries and their subtrees removed. Entries without
   * a navtitle take the title of their topic as this reader sees it.
   */
  readonly nav: NavEntry[];
  /** Whether the topic is published to this reader. */
  isVisible(topicId: string): boolean;
  /** The topic with reader filtering applied, or `null` when not visible. */
  topic(topicId: string): CompiledTopic | null;
  /** Ids of every visible topic, in navigation order. */
  topicIds(): string[];
}

export function filterNav(
  entries: readonly NavEntry[],
  policies: readonly FilterPolicy[],
): NavEntry[] {
  const out: NavEntry[] = [];
  for (const entry of entries) {
    if (!isIncluded(entry.condition, policies)) continue;
    out.push({ ...entry, children: filterNav(entry.children, policies) });
  }
  return out;
}

/**
 * Builds a reader's view. Pass no policies for the unfiltered staff view
 * (build-time filtering has already been applied by the build); the staff view
 * also passes `resolveChoices: false` to see every alternative of a
 * conditional key.
 */
export function viewRelease(
  release: CompiledRelease,
  policies: readonly FilterPolicy[],
  options: FilterTreeOptions = {},
): ReleaseView {
  const filtered = filterNav(release.nav, policies);
  const cache = new Map<string, CompiledTopic | null>();

  const ordered: string[] = [];
  const inNav = new Set<string>();
  const collect = (entries: readonly NavEntry[]) => {
    for (const e of entries) {
      if (e.topicId && !inNav.has(e.topicId)) {
        inNav.add(e.topicId);
        ordered.push(e.topicId);
      }
      collect(e.children);
    }
  };
  collect(filtered);

  const topic = (id: string): CompiledTopic | null => {
    if (cache.has(id)) return cache.get(id) ?? null;
    let result: CompiledTopic | null = null;
    const source = release.topics[id];
    if (source && inNav.has(id)) {
      const body = filterTree(source.body, policies, options);
      if (body) {
        const title = firstChild(body, 'title');
        result = { ...source, body, title: title ? displayText(title) : source.title };
      }
    }
    cache.set(id, result);
    return result;
  };

  const withTitles = (entries: readonly NavEntry[]): NavEntry[] =>
    entries.map((e) => ({
      ...e,
      title: e.title || (e.topicId ? (topic(e.topicId)?.title ?? '') : ''),
      children: withTitles(e.children),
    }));

  return {
    release,
    nav: withTitles(filtered),
    isVisible: (id) => topic(id) !== null,
    topic,
    topicIds: () => ordered.filter((id) => topic(id) !== null),
  };
}
