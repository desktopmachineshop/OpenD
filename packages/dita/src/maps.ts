import {
  childElements,
  cloneNode,
  firstChild,
  textContent,
  type Condition,
  type Diagnostic,
  type DocNode,
  type ElementNode,
  type NavEntry,
} from '@opend/model';
import { conditionOf, isEmptyCondition } from './conditions.js';
import {
  isExternalHref,
  isMapFile,
  isTopicFile,
  parseRef,
  topicPageId,
  type DitaRef,
} from './refs.js';
import type { Workspace } from './workspace.js';

/** One key definition. A key may have several; the first one a reader's filter keeps wins. */
export interface KeyDef {
  key: string;
  /** Local target, docs-root-relative. */
  ref?: DitaRef;
  /** External target URL. */
  url?: string;
  /** Variable text from `topicmeta/keywords/keyword` or `topicmeta/linktext`. */
  text?: DocNode[];
  /** Filtering attributes of the definition and its ancestors in the map(s), outermost first. */
  conditions: Condition[];
  file: string;
  line?: number;
}

export type Keyspace = Map<string, KeyDef[]>;

export interface MapModel {
  file: string;
  title: string;
  nav: NavEntry[];
  keys: Keyspace;
  /** Topic files the map references, in document order, with where they are referenced. */
  topicFiles: Map<string, { file: string; line?: number }>;
  /** Context-sensitive help keys from `topicmeta/resourceid` on topicrefs, in document order. */
  resourceIds: ResourceIdRef[];
  diagnostics: Diagnostic[];
}

/** A DITA `resourceid` naming a host-app context for a topic. */
export interface ResourceIdRef {
  app: string;
  key: string;
  topicId: string;
  fragment?: string;
  /** Filtering attributes of the resourceid and its ancestors, outermost first. */
  conditions: Condition[];
  file: string;
  line?: number;
  column?: number;
}

/**
 * Reads a `resourceid` element. DITA 1.3 uses `appname` for the application and
 * `appid` for the context; returns an error message when either is missing.
 */
export function readResourceId(el: ElementNode): { app: string; key: string } | string {
  const app = el.attrs.appname?.trim();
  const key = el.attrs.appid?.trim();
  if (!app || !key)
    return 'resourceid needs both appname (the host app) and appid (the context key)';
  return { app, key };
}

/** Map elements that only group their children and have no title of their own. */
const TRANSPARENT = new Set(['topicgroup', 'frontmatter', 'backmatter', 'appendices', 'notices']);
/** Map elements that add nothing to navigation in this version. */
const SKIPPED = new Set([
  'title',
  'topicmeta',
  'bookmeta',
  'booktitle',
  'reltable',
  'booklists',
  'anchor',
  'navref',
  'anchorref',
  'ditavalref',
  'data',
]);

export function mapTitle(root: ElementNode): string {
  const booktitle = firstChild(root, 'booktitle');
  if (booktitle) {
    const main = firstChild(booktitle, 'mainbooktitle');
    return textContent(main ?? booktitle);
  }
  const title = firstChild(root, 'title');
  return title ? textContent(title) : (root.attrs.title ?? '');
}

/**
 * Loads a map and its submaps into navigation and a keyspace. Keys defined in a
 * map take precedence over keys defined in its submaps; within a map the first
 * definition in document order comes first.
 */
export function loadMap(ws: Workspace, file: string): MapModel {
  const model: MapModel = {
    file,
    title: '',
    nav: [],
    keys: new Map(),
    topicFiles: new Map(),
    resourceIds: [],
    diagnostics: [],
  };
  const root = ws.document(file);
  if (!root) {
    if (!ws.has(file)) {
      model.diagnostics.push({
        severity: 'error',
        code: 'missing-map',
        message: `map not found: ${file}`,
        file,
      });
    }
    return model;
  }
  model.title = mapTitle(root);
  const ordered: KeyDef[] = [];
  model.nav = walkMap(ws, root, file, [], ordered, model, [file]);
  for (const def of ordered) {
    const list = model.keys.get(def.key) ?? [];
    list.push(def);
    model.keys.set(def.key, list);
  }
  return model;
}

function walkMap(
  ws: Workspace,
  parent: ElementNode,
  file: string,
  chain: Condition[],
  keysOut: KeyDef[],
  model: MapModel,
  mapStack: string[],
): NavEntry[] {
  const entries: NavEntry[] = [];
  const submapKeys: KeyDef[] = [];
  const diag = (
    node: ElementNode,
    severity: Diagnostic['severity'],
    code: string,
    message: string,
  ) =>
    model.diagnostics.push({
      severity,
      code,
      message,
      file,
      line: node.loc?.line,
      column: node.loc?.column,
    });

  const visit = (node: ElementNode, chain: Condition[], out: NavEntry[], keys: KeyDef[]) => {
    if (SKIPPED.has(node.name)) return;
    const condition = conditionOf(node.attrs);
    const myChain = isEmptyCondition(condition) ? chain : [...chain, condition];
    const href = node.attrs.href;
    const format = node.attrs.format;
    const scope = node.attrs.scope;

    if (node.attrs.keys) {
      for (const key of node.attrs.keys.split(/\s+/).filter(Boolean)) {
        keys.push(keyDef(node, key, file, myChain));
      }
    }

    const resourceOnly =
      node.name === 'keydef' || node.attrs['processing-role'] === 'resource-only';
    if (resourceOnly) return;

    const isMapRef =
      node.name === 'mapref' ||
      format === 'ditamap' ||
      (href !== undefined && isMapFile(href.split('#')[0] ?? ''));
    if (isMapRef) {
      const ref = href ? parseRef(href, file) : null;
      if (!ref) {
        diag(node, 'error', 'missing-map', `mapref without a valid href`);
        return;
      }
      if (mapStack.includes(ref.file)) {
        diag(
          node,
          'error',
          'map-cycle',
          `map reference cycle: ${[...mapStack, ref.file].join(' -> ')}`,
        );
        return;
      }
      const sub = ws.document(ref.file);
      if (!sub) {
        if (!ws.has(ref.file)) diag(node, 'error', 'missing-map', `map not found: ${ref.file}`);
        return;
      }
      const subKeys: KeyDef[] = [];
      const children = walkMap(ws, sub, ref.file, myChain, subKeys, model, [...mapStack, ref.file]);
      submapKeys.push(...subKeys);
      out.push({ title: '', kind: 'mapref', condition, children });
      return;
    }

    const entry: NavEntry = { title: navTitle(node), kind: node.name, condition, children: [] };
    if (node.attrs.toc === 'no') entry.hidden = true;

    if (TRANSPARENT.has(node.name)) {
      entry.title = '';
    } else if (href !== undefined) {
      if (isExternalHref(href, scope)) {
        diag(
          node,
          'warning',
          'unsupported-topicref',
          `external topicref is not supported yet: ${href}`,
        );
      } else if (format !== undefined && format !== 'dita') {
        diag(
          node,
          'warning',
          'unsupported-topicref',
          `topicref with format="${format}" is not supported yet`,
        );
      } else {
        const ref = parseRef(href, file);
        if (!ref || !isTopicFile(ref.file)) {
          diag(node, 'error', 'missing-topic', `topicref does not point at a topic file: ${href}`);
        } else if (!ws.has(ref.file)) {
          diag(node, 'error', 'missing-topic', `topic not found: ${ref.file}`);
        } else {
          entry.topicId = topicPageId(ref.file);
          if (ref.topicId) entry.fragment = ref.topicId;
          const meta = firstChild(node, 'topicmeta');
          for (const rid of meta ? childElements(meta, 'resourceid') : []) {
            const parsed = readResourceId(rid);
            if (typeof parsed === 'string') {
              diag(rid, 'error', 'invalid-resourceid', parsed);
              continue;
            }
            const own = conditionOf(rid.attrs);
            const target: ResourceIdRef = {
              ...parsed,
              topicId: entry.topicId,
              conditions: isEmptyCondition(own) ? myChain : [...myChain, own],
              file,
            };
            if (ref.topicId) target.fragment = ref.topicId;
            if (rid.loc) {
              target.line = rid.loc.line;
              target.column = rid.loc.column;
            }
            model.resourceIds.push(target);
          }
          if (!model.topicFiles.has(ref.file)) {
            model.topicFiles.set(ref.file, { file, line: node.loc?.line });
          }
        }
      }
    } else if (!entry.title && node.name !== 'topicgroup') {
      diag(node, 'warning', 'empty-topicref', `<${node.name}> has neither href nor navtitle`);
    }

    for (const child of childElements(node)) visit(child, myChain, entry.children, keys);
    out.push(entry);
  };

  for (const child of childElements(parent)) visit(child, chain, entries, keysOut);
  keysOut.push(...submapKeys);
  return entries;
}

function navTitle(node: ElementNode): string {
  if (node.attrs.navtitle) return node.attrs.navtitle.trim();
  const meta = firstChild(node, 'topicmeta');
  const nt = meta && firstChild(meta, 'navtitle');
  return nt ? textContent(nt) : '';
}

function keyDef(node: ElementNode, key: string, file: string, conditions: Condition[]): KeyDef {
  const def: KeyDef = { key, conditions, file, line: node.loc?.line };
  const href = node.attrs.href;
  if (href) {
    if (isExternalHref(href, node.attrs.scope)) def.url = href;
    else {
      const ref = parseRef(href, file);
      if (ref) def.ref = ref;
    }
  }
  const meta = firstChild(node, 'topicmeta');
  if (meta) {
    const keywords = firstChild(meta, 'keywords');
    const keyword = keywords && firstChild(keywords, 'keyword');
    const linktext = firstChild(meta, 'linktext');
    const source = keyword ?? linktext;
    if (source) def.text = cloneNode(source).children;
  }
  return def;
}
