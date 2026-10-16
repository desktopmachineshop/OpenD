import type { ElementNode } from './nodes.js';

/**
 * Filtering attributes of one element, e.g. `{ product: "widget", release: "2.0.." }`.
 * A node is shown only when every condition on it and its ancestors passes.
 */
export type Condition = Record<string, string>;

export interface NavEntry {
  title: string;
  /** Present when the entry points at a topic; absent for headings (`topichead`). */
  topicId?: string;
  /** Fragment within the topic, if the topicref pointed at one. */
  fragment?: string;
  /** The topicref's own filtering attributes. Ancestors are checked by walking the tree. */
  condition: Condition;
  /** `toc="no"`: the topic is published but not listed in navigation. */
  hidden?: boolean;
  /** Element name in the map, e.g. `chapter` or `topicref`. */
  kind: string;
  children: NavEntry[];
}

export interface CompiledTopic {
  /** Docs-root-relative path without extension, e.g. `topics/install`. Also the page URL. */
  id: string;
  /** Source file, e.g. `topics/install.dita`. */
  file: string;
  /** DITA `id` of the topic root element. */
  ditaId: string;
  /** Root element name: `topic`, `concept`, `task`, `reference`, ... */
  type: string;
  title: string;
  /**
   * The resolved topic tree, with content references inlined, keys resolved and
   * build-time filtering applied. Reader filtering is applied at request time.
   */
  body: ElementNode;
}

export interface Publication {
  /** Source map, e.g. `maps/admin-guide.bookmap`. */
  file: string;
  title: string;
  nav: NavEntry[];
}

/** Where a context key points: a topic, and the conditions under which it applies. */
export interface ContextTarget {
  topicId: string;
  /** Element or nested topic id within the page. */
  fragment?: string;
  /**
   * Filtering attributes of the `resourceid` and its ancestors (map topicrefs or
   * topic elements), outermost first. All must pass for the target to apply.
   */
  conditions: Condition[];
}

export interface HelpRoute {
  /** Host-app route pattern, e.g. `/projects/:id/settings/**`. */
  pattern: string;
  key: string;
}

/** Context-sensitive help for one host application. */
export interface HelpApp {
  /** Context key → candidate targets in precedence order (map first, then topics). */
  keys: Record<string, ContextTarget[]>;
  /** Route patterns from `help-contexts.yaml`, in file order. */
  routes: HelpRoute[];
  /** Key used when nothing more specific resolves. */
  default?: string;
}

export const RELEASE_SCHEMA_VERSION = 1;

/**
 * Everything the build knows about one release. This snapshot is the contract
 * between the build and delivery: the previewer serves it from memory, and the
 * hosted content store will hold the same shape.
 */
export interface CompiledRelease {
  schemaVersion: typeof RELEASE_SCHEMA_VERSION;
  release: string;
  title: string;
  builtAt: string;
  /** Git ref the release was built from, when not built from a working tree. */
  sourceRef?: string;
  /** Declared values per filtering attribute, from the project config. */
  attributes: Record<string, string[]>;
  nav: NavEntry[];
  publications: Publication[];
  topics: Record<string, CompiledTopic>;
  /**
   * Reusable chunk to the topics that use it. Chunk ids look like
   * `reuse/common.dita#common/power-warning`.
   */
  chunkUsage: Record<string, string[]>;
  /** Docs-root-relative paths of images and other files the content references. */
  assets: string[];
  /**
   * Context-sensitive help by host app name, from DITA `resourceid` elements
   * and `help-contexts.yaml`. Absent in snapshots built before stage 3.
   */
  contexts?: Record<string, HelpApp>;
  theme?: string;
}
