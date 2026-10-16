import {
  ASSET_ATTR,
  SYNTHETIC,
  TARGET_ATTR,
  cloneNode,
  element,
  firstChild,
  text,
  textContent,
  type Diagnostic,
  type DocNode,
  type ElementNode,
} from '@opend/model';
import { conditionOf, isEmptyCondition, wrapInConditions } from './conditions.js';
import { DROPPED_ELEMENTS, findElementById, findTopic } from './elements.js';
import type { KeyDef, Keyspace } from './maps.js';
import {
  formatRef,
  isExternalHref,
  isTopicFile,
  parseRef,
  resolvePath,
  topicPageId,
  type DitaRef,
} from './refs.js';
import type { Workspace } from './workspace.js';

export interface ResolveContext {
  ws: Workspace;
  keys: Keyspace;
  diagnostics: Diagnostic[];
  /** Called with a chunk id (`file#topic/element`) each time content is pulled by reference. */
  onChunkUse?(chunkId: string): void;
  /** Called with the docs-root-relative path of each local asset the content references. */
  onAsset?(path: string): void;
}

/**
 * Resolves a topic for publishing: inlines `conref` and `conkeyref`, resolves
 * `keyref`, records link targets and asset paths, and drops elements that must
 * never be published. Conditional key definitions become `opend-choice`
 * alternatives so the reader's filter picks the effective definition.
 */
export function resolveTopic(topic: ElementNode, file: string, ctx: ResolveContext): ElementNode {
  const out = resolveNode(topic, file, ctx, []);
  const first = out[0];
  return first && first.type === 'element' ? first : element(topic.name, { ...topic.attrs });
}

function resolveNode(node: DocNode, file: string, ctx: ResolveContext, stack: string[]): DocNode[] {
  if (node.type === 'text') return [node];
  if (DROPPED_ELEMENTS.has(node.name)) return [];
  if (node.attrs.conref !== undefined) return resolveConref(node, file, ctx, stack);
  if (node.attrs.conkeyref !== undefined) return resolveConkeyref(node, file, ctx, stack);
  if (node.attrs.keyref !== undefined) return resolveKeyref(node, file, ctx, stack);
  return [finish(node, file, ctx, stack)];
}

/** Resolves links, images and children of an element whose own references are already handled. */
function finish(
  node: ElementNode,
  file: string,
  ctx: ResolveContext,
  stack: string[],
): ElementNode {
  const el: ElementNode = { ...node, attrs: { ...node.attrs }, children: [] };
  const href = el.attrs.href;
  if (href !== undefined && !(TARGET_ATTR in el.attrs) && !(ASSET_ATTR in el.attrs)) {
    if (el.name === 'image') resolveImage(el, href, file, ctx);
    else if (el.name === 'xref' || el.name === 'link') resolveLink(el, href, file, ctx);
  }
  for (const child of node.children) el.children.push(...resolveNode(child, file, ctx, stack));
  return el;
}

function report(
  ctx: ResolveContext,
  node: ElementNode,
  severity: Diagnostic['severity'],
  code: string,
  message: string,
) {
  ctx.diagnostics.push({
    severity,
    code,
    message,
    file: node.loc?.file,
    line: node.loc?.line,
    column: node.loc?.column,
  });
}

// ---------------------------------------------------------------- links and assets

function resolveImage(el: ElementNode, href: string, file: string, ctx: ResolveContext) {
  if (isExternalHref(href, el.attrs.scope)) return;
  const path = resolvePath(file, href);
  if (!path || !ctx.ws.has(path)) {
    report(ctx, el, 'error', 'missing-image', `image not found: ${href}`);
    return;
  }
  el.attrs[ASSET_ATTR] = path;
  ctx.onAsset?.(path);
}

function resolveLink(el: ElementNode, href: string, file: string, ctx: ResolveContext) {
  if (isExternalHref(href, el.attrs.scope)) return;
  const ref = parseRef(href, file);
  if (!ref) {
    report(ctx, el, 'error', 'broken-link', `link points outside the docs root: ${href}`);
    return;
  }
  setLinkTarget(el, ref, ctx, href);
}

/** Sets `opend-target` (topic) or `opend-asset` (other local file) from a resolved reference. */
function setLinkTarget(el: ElementNode, ref: DitaRef, ctx: ResolveContext, shown: string) {
  if (!isTopicFile(ref.file)) {
    if (!ctx.ws.has(ref.file)) {
      report(ctx, el, 'error', 'broken-link', `link target not found: ${shown}`);
      return;
    }
    el.attrs[ASSET_ATTR] = ref.file;
    ctx.onAsset?.(ref.file);
    return;
  }
  const doc = ctx.ws.document(ref.file);
  if (!doc) {
    if (!ctx.ws.has(ref.file))
      report(ctx, el, 'error', 'broken-link', `link target not found: ${shown}`);
    return;
  }
  const root = findTopic(doc);
  const topic = findTopic(doc, ref.topicId);
  if (!topic) {
    report(ctx, el, 'error', 'broken-link', `topic "${ref.topicId}" not found in ${ref.file}`);
    return;
  }
  if (ref.elementId && !findElementById(topic, ref.elementId)) {
    report(
      ctx,
      el,
      'error',
      'broken-link',
      `element "${ref.elementId}" not found in ${formatRef(ref)}`,
    );
    return;
  }
  const fragment = ref.elementId ?? (topic !== root ? ref.topicId : undefined);
  el.attrs[TARGET_ATTR] = topicPageId(ref.file) + (fragment ? `#${fragment}` : '');
}

// ---------------------------------------------------------------- content references

interface Located {
  element: ElementNode;
  file: string;
}

function locate(
  ref: DitaRef,
  ctx: ResolveContext,
  from: ElementNode,
  attr: string,
): Located | null {
  const doc = ctx.ws.document(ref.file);
  if (!doc) {
    if (!ctx.ws.has(ref.file))
      report(ctx, from, 'error', 'missing-conref', `${attr} file not found: ${ref.file}`);
    return null;
  }
  const topic = findTopic(doc, ref.topicId);
  if (!topic) {
    report(
      ctx,
      from,
      'error',
      'missing-conref',
      `${attr} topic "${ref.topicId ?? ''}" not found in ${ref.file}`,
    );
    return null;
  }
  if (!ref.elementId) return { element: topic, file: ref.file };
  const target = findElementById(topic, ref.elementId);
  if (!target) {
    report(ctx, from, 'error', 'missing-conref', `${attr} target not found: ${formatRef(ref)}`);
    return null;
  }
  return { element: target, file: ref.file };
}

/** Pulls a located chunk in place of `from`, keeping `from`'s filtering attributes. */
function pull(
  from: ElementNode,
  target: Located,
  chunkId: string,
  ctx: ResolveContext,
  stack: string[],
): DocNode[] {
  if (stack.includes(chunkId)) {
    report(
      ctx,
      from,
      'error',
      'conref-cycle',
      `content reference cycle: ${[...stack, chunkId].join(' -> ')}`,
    );
    return [];
  }
  if (target.element.name !== from.name) {
    report(
      ctx,
      from,
      'warning',
      'conref-type-mismatch',
      `<${from.name}> pulls a <${target.element.name}> from ${chunkId}`,
    );
  }
  if (from.attrs.conrefend !== undefined || from.attrs.conaction !== undefined) {
    report(
      ctx,
      from,
      'warning',
      'unsupported-conref',
      'conrefend and conaction are not supported; pulled the start element only',
    );
  }
  ctx.onChunkUse?.(chunkId);
  const clone = cloneNode(target.element);
  const resolved = resolveNode(clone, target.file, ctx, [...stack, chunkId]);
  const condition = conditionOf(from.attrs);
  return isEmptyCondition(condition) ? resolved : [element(SYNTHETIC.cond, condition, resolved)];
}

function resolveConref(
  node: ElementNode,
  file: string,
  ctx: ResolveContext,
  stack: string[],
): DocNode[] {
  const value = node.attrs.conref ?? '';
  const ref = parseRef(value, file);
  if (!ref || !ref.topicId) {
    report(ctx, node, 'error', 'missing-conref', `conref must be file#topic/element: "${value}"`);
    return [];
  }
  const target = locate(ref, ctx, node, 'conref');
  return target ? pull(node, target, formatRef(ref), ctx, stack) : [];
}

function resolveConkeyref(
  node: ElementNode,
  file: string,
  ctx: ResolveContext,
  stack: string[],
): DocNode[] {
  const value = node.attrs.conkeyref ?? '';
  const [key = '', elementId] = value.split('/', 2);
  const defs = ctx.keys.get(key);
  const fallback = () => {
    const { conkeyref: _drop, ...attrs } = node.attrs;
    return finish({ ...node, attrs }, file, ctx, stack);
  };
  if (!defs) {
    report(ctx, node, 'error', 'unresolved-key', `conkeyref key "${key}" is not defined`);
    return [];
  }
  return choose(defs, fallback, (def) => {
    if (!def.ref) {
      report(
        ctx,
        node,
        'error',
        'missing-conref',
        `key "${key}" used in conkeyref has no local href`,
      );
      return [];
    }
    const doc = ctx.ws.document(def.ref.file);
    const topicId = def.ref.topicId ?? (doc ? findTopic(doc)?.attrs.id : undefined);
    const ref: DitaRef = { file: def.ref.file, topicId, elementId };
    const target = locate(ref, ctx, node, 'conkeyref');
    return target ? pull(node, target, formatRef(ref), ctx, stack) : [];
  });
}

function resolveKeyref(
  node: ElementNode,
  file: string,
  ctx: ResolveContext,
  stack: string[],
): DocNode[] {
  const key = (node.attrs.keyref ?? '').split('/', 1)[0] ?? '';
  const defs = ctx.keys.get(key);
  const withoutKey = () => {
    const { keyref: _drop, ...attrs } = node.attrs;
    return { ...node, attrs };
  };
  if (!defs) {
    report(
      ctx,
      node,
      'warning',
      'unresolved-key',
      `key "${key}" is not defined; using fallback content`,
    );
    return [finish(withoutKey(), file, ctx, stack)];
  }
  return choose(
    defs,
    () => finish(withoutKey(), file, ctx, stack),
    (def) => [finish(applyKey(withoutKey(), def, ctx), file, ctx, stack)],
  );
}

/**
 * Builds the result for a key with possibly conditional definitions. With a
 * single unconditional definition the result is plain content; otherwise an
 * `opend-choice` holds one alternative per definition, in precedence order, and
 * the element's own content as the last resort.
 */
function choose(
  defs: KeyDef[],
  fallback: () => ElementNode,
  build: (def: KeyDef) => DocNode[],
): DocNode[] {
  const first = defs[0];
  if (first && first.conditions.length === 0) return build(first);
  const alternatives: ElementNode[] = [];
  for (const def of defs) {
    const content = build(def);
    // Every alternative must be a single element so filtering can pick one.
    const wrapped = def.conditions.length
      ? wrapInConditions(def.conditions, content)
      : [element(SYNTHETIC.cond, {}, content)];
    alternatives.push(wrapped[0] as ElementNode);
    if (def.conditions.length === 0) return [element(SYNTHETIC.choice, {}, alternatives)];
  }
  alternatives.push(element(SYNTHETIC.cond, {}, [fallback()]));
  return [element(SYNTHETIC.choice, {}, alternatives)];
}

/** Applies one key definition to the element that references it. */
function applyKey(node: ElementNode, def: KeyDef, ctx: ResolveContext): ElementNode {
  const el: ElementNode = { ...node, attrs: { ...node.attrs }, children: [...node.children] };
  const empty = el.children.every((c) => c.type === 'text' && c.value.trim() === '');
  if (el.name === 'image') {
    if (def.url) el.attrs.href = def.url;
    else if (def.ref) {
      delete el.attrs.href;
      if (ctx.ws.has(def.ref.file)) {
        el.attrs[ASSET_ATTR] = def.ref.file;
        ctx.onAsset?.(def.ref.file);
      } else
        report(
          ctx,
          node,
          'error',
          'missing-image',
          `image for key "${def.key}" not found: ${def.ref.file}`,
        );
    }
    return el;
  }
  if (el.name === 'xref' || el.name === 'link') {
    if (def.url) {
      el.attrs.href = def.url;
      el.attrs.scope = 'external';
    } else if (def.ref) {
      delete el.attrs.href;
      setLinkTarget(el, def.ref, ctx, formatRef(def.ref));
    }
    if (empty && def.text) el.children = cloneNode(element('x', {}, def.text)).children;
    return el;
  }
  if (empty) {
    if (def.text) el.children = cloneNode(element('x', {}, def.text)).children;
    else if (def.ref) el.children = [text(targetTitle(def.ref, ctx) ?? def.key)];
    else if (def.url) el.children = [text(def.url)];
  }
  return el;
}

function targetTitle(ref: DitaRef, ctx: ResolveContext): string | undefined {
  const doc = ctx.ws.document(ref.file);
  const topic = doc && findTopic(doc, ref.topicId);
  const title = topic && firstChild(topic, 'title');
  return title ? textContent(title) : undefined;
}
