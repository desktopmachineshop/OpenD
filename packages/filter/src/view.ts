import {
  displayText,
  firstChild,
  type CompiledRelease,
  type CompiledTopic,
  type Condition,
  type NavEntry,
  type Publication,
} from '@opend/model';
import { filterTree, isIncluded, type FilterPolicy, type FilterTreeOptions } from './policy.js';
import { gatesPass, type SearchGate } from './search-index.js';

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
  /** Whether every condition passes for this reader (for content outside topics, such as context targets). */
  includes(conditions: readonly Condition[]): boolean;
  /** Whether this reader sees text behind these gates (see `searchSegments`). */
  passes(gates: readonly SearchGate[]): boolean;
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
  return viewNav(release, release.nav, policies, options);
}

/**
 * A reader's view of one curated publication (a bookmap): the same as a
 * release view, but navigation and the set of published topics come from the
 * publication's map instead of the site map. Chapter conditions and each topic
 * root's conditions are applied with the same policies, so a topic only the
 * bookmap references is visible exactly when the reader may see it there.
 */
export interface PublicationView extends ReleaseView {
  readonly publication: Publication;
}

/** `null` when the release has no publication built from `file`. */
export function viewPublication(
  release: CompiledRelease,
  file: string,
  policies: readonly FilterPolicy[],
  options: FilterTreeOptions = {},
): PublicationView | null {
  const publication = release.publications.find((p) => p.file === file);
  if (!publication) return null;
  return { ...viewNav(release, publication.nav, policies, options), publication };
}

/** A view whose published topics are exactly those reachable from `nav` after filtering. */
function viewNav(
  release: CompiledRelease,
  nav: readonly NavEntry[],
  policies: readonly FilterPolicy[],
  options: FilterTreeOptions,
): ReleaseView {
  const filtered = filterNav(nav, policies);
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
    includes: (conditions) => conditions.every((c) => isIncluded(c, policies)),
    passes: (gates) => gatesPass(gates, policies, options),
  };
}

/** A navigation entry as a reader may see it; see `visibleNav`. */
export interface VisibleNavEntry {
  title: string;
  /** Present only when the topic is visible to this reader. */
  topicId?: string;
  fragment?: string;
  condition: Condition;
  children: VisibleNavEntry[];
}

/**
 * The navigation a reader is shown: what the docs site's contents, the API's
 * nav and the help API's nav all list. `toc="no"` entries are left out with
 * their subtrees. An entry whose topic is hidden from this reader never shows
 * its navtitle (that would reveal the topic): its visible children take its
 * place. Groups without a title are lifted the same way, and a heading with
 * nothing visible under it is left out.
 */
export function visibleNav(view: ReleaseView): VisibleNavEntry[] {
  const items = (entries: readonly NavEntry[]): VisibleNavEntry[] => {
    const out: VisibleNavEntry[] = [];
    for (const e of entries) {
      if (e.hidden) continue;
      const visible = e.topicId !== undefined && view.isVisible(e.topicId);
      const children = items(e.children);
      if (!visible && (!e.title || e.topicId !== undefined)) {
        out.push(...children);
        continue;
      }
      if (!visible && !children.length) continue;
      const entry: VisibleNavEntry = { title: e.title, condition: e.condition, children };
      if (visible) {
        entry.topicId = e.topicId!;
        if (e.fragment) entry.fragment = e.fragment;
      }
      out.push(entry);
    }
    return out;
  };
  return items(view.nav);
}
