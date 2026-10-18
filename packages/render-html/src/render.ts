import {
  ASSET_ATTR,
  SYNTHETIC,
  TARGET_ATTR,
  childElements,
  isFilterAttribute,
  textContent,
  type CompiledTopic,
  type DocNode,
  type ElementNode,
} from '@opend/model';
import type { ReleaseView } from '@opend/filter';
import { DROPPED_ELEMENTS, METADATA_ELEMENTS, TOPIC_TYPES } from '@opend/dita';
import { NOTE_LABELS, SECTION_LABELS, TAGS } from './elements.js';
import { encodePath, escapeHtml } from './escape.js';

export interface RenderOptions {
  /** URL prefix for pages and assets. Default `/`. */
  base?: string;
  /**
   * Staff view: mark every conditional element with its filtering attributes
   * and show every alternative of a conditional key. Never use for readers.
   */
  showConditions?: boolean;
  /**
   * URL for a link to a topic. Defaults to the site page (`pageHref`); the
   * embedded help panel keeps links inside the panel instead.
   */
  topicHref?: (topicId: string) => string;
  /**
   * Resolves a link to a topic, replacing both the visibility check and the
   * URL: return `null` to render the link as unavailable text. Print output
   * uses this to point at in-document anchors or the docs site.
   */
  topicLink?: (topicId: string, fragment: string | undefined) => TopicLink | null;
  /**
   * URL of a file the content references (images, linked files), or `null`
   * when it is unavailable. Default: the site's `_assets/` route.
   */
  assetSrc?: (path: string, use: 'image' | 'link') => string | null;
  /** Prefix for every `id` the topic emits, so several topics can share one document. */
  idPrefix?: string;
  /** Nesting depth of the topic, for heading levels: 0 renders the title as `h1`. */
  depth?: number;
}

export interface TopicLink {
  href: string;
  /** Link text when the author gave none. */
  title: string;
}

interface Ctx {
  view: ReleaseView;
  base: string;
  topicHref: (topicId: string) => string;
  topicLink: ((topicId: string, fragment: string | undefined) => TopicLink | null) | undefined;
  assetSrc: (path: string, use: 'image' | 'link') => string | null;
  idPrefix: string;
  showConditions: boolean;
  /** Nesting depth of topics, for heading levels. */
  depth: number;
  /** Depth of the topic being rendered, whose root is an `article`. */
  rootDepth: number;
  inThead: boolean;
  colnames: string[];
  /** Name of the element being rendered when its children render, e.g. for titles. */
  parent: string;
}

/** Elements `renderNode` handles itself rather than through the `TAGS` table. */
// prettier-ignore
export const SPECIAL_ELEMENTS = new Set([
  'dita', 'title', 'note', 'xref', 'related-links', 'link', 'image', 'codeblock', 'menucascade',
  'tm', 'fn', 'table', 'simpletable', 'properties', 'tgroup', 'thead', 'sthead', 'prophead',
  'tbody', 'row', 'strow', 'property', 'entry', 'stentry', 'proptype', 'propvalue', 'propdesc',
  'proptypehd', 'propvaluehd', 'propdeschd',
]);

export function pageHref(topicId: string, base = '/'): string {
  return `${base}${encodePath(topicId)}.html`;
}

export function assetHref(path: string, base = '/'): string {
  return `${base}_assets/${encodePath(path)}`;
}

/** Renders a visible topic as an `<article>`. */
export function renderTopic(
  view: ReleaseView,
  topic: CompiledTopic,
  options: RenderOptions = {},
): string {
  return renderNode(topic.body, makeCtx(view, options));
}

function makeCtx(view: ReleaseView, options: RenderOptions): Ctx {
  return {
    view,
    base: options.base ?? '/',
    topicHref: options.topicHref ?? ((id) => pageHref(id, options.base ?? '/')),
    topicLink: options.topicLink,
    assetSrc: options.assetSrc ?? ((path) => assetHref(path, options.base ?? '/')),
    idPrefix: options.idPrefix ?? '',
    showConditions: options.showConditions ?? false,
    depth: options.depth ?? 0,
    rootDepth: options.depth ?? 0,
    inThead: false,
    colnames: [],
    parent: '',
  };
}

/**
 * Where a link element (`xref`, `link`) points and its default text, by the
 * same rules as the HTML: `null` when the reader cannot see the target (never
 * reveal its title), `undefined` when the reference did not resolve.
 */
export function resolveLink(
  view: ReleaseView,
  node: ElementNode,
  options: RenderOptions = {},
): { href: string; defaultText: string } | null | undefined {
  return linkTarget(node, makeCtx(view, options));
}

/** An image's source URL and alternative text, or a null source when it is unavailable. */
export function resolveImage(
  view: ReleaseView,
  node: ElementNode,
  options: RenderOptions = {},
): { src: string | null; alt: string } {
  const ctx = makeCtx(view, options);
  const asset = node.attrs[ASSET_ATTR];
  const href = node.attrs.href;
  const src =
    asset !== undefined
      ? ctx.assetSrc(asset, 'image')
      : href !== undefined && safeUrl(href, IMAGE_SCHEMES)
        ? href
        : null;
  const altEl = childElements(node, 'alt')[0];
  return { src, alt: altEl ? textContent(altEl) : (node.attrs.alt ?? '') };
}

/** A short label of an element's filtering attributes, e.g. `product=gadget release=2.0..`. */
export function conditionLabel(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .filter(([k, v]) => isFilterAttribute(k) && v.trim())
    .map(([k, v]) => `${k}=${v.trim()}`)
    .join(' ');
}

function renderChildren(node: ElementNode, ctx: Ctx): string {
  const inner = { ...ctx, parent: node.name };
  return node.children.map((c) => renderNode(c, inner)).join('');
}

function attrString(attrs: Record<string, string | undefined>): string {
  return Object.entries(attrs)
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '')
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join('');
}

/** Common HTML attributes: id, classes, and the staff-view condition marker. */
function commonAttrs(
  node: ElementNode,
  ctx: Ctx,
  extraClass = '',
): Record<string, string | undefined> {
  const classes = [node.name, extraClass, node.attrs.outputclass].filter(Boolean).join(' ');
  const id = node.attrs.id ? ctx.idPrefix + node.attrs.id : undefined;
  const out: Record<string, string | undefined> = { id, class: classes };
  if (ctx.showConditions) {
    const label = conditionLabel(node.attrs);
    if (label) {
      out['data-applies'] = label;
      out.class = `${classes} opend-conditional`;
    }
  }
  return out;
}

function tag(name: string, attrs: Record<string, string | undefined>, inner: string): string {
  return `<${name}${attrString(attrs)}>${inner}</${name}>`;
}

function renderNode(node: DocNode, ctx: Ctx): string {
  if (node.type === 'text') return escapeHtml(node.value);
  const name = node.name;
  if (DROPPED_ELEMENTS.has(name) || METADATA_ELEMENTS.has(name)) return '';

  if (name === SYNTHETIC.cond) {
    const inner = renderChildren(node, ctx);
    const label = ctx.showConditions ? conditionLabel(node.attrs) : '';
    return label
      ? tag('opend-cond', { class: 'opend-conditional', 'data-applies': label }, inner)
      : inner;
  }
  if (name === SYNTHETIC.choice) {
    // After reader filtering a choice holds one alternative. In the staff view it
    // holds all of them, each marked with its conditions.
    if (!ctx.showConditions) return renderChildren(node, ctx);
    return node.children
      .map((c) => renderNode(c, ctx))
      .join('<span class="opend-alt-sep" aria-hidden="true"> | </span>');
  }

  if (TOPIC_TYPES.has(name)) {
    const inner = renderChildren(node, { ...ctx, depth: ctx.depth + 1 });
    return tag(
      ctx.depth === ctx.rootDepth ? 'article' : 'section',
      commonAttrs(node, ctx, 'topic'),
      inner,
    );
  }

  switch (name) {
    case 'dita':
      return renderChildren(node, ctx);
    case 'title':
      return renderTitle(node, ctx);
    case 'note':
      return renderNote(node, ctx);
    case 'xref':
      return renderXref(node, ctx);
    case 'related-links':
      return renderRelatedLinks(node, ctx);
    case 'link':
      return renderLink(node, ctx);
    case 'image':
      return renderImage(node, ctx);
    case 'codeblock':
      return tag('pre', commonAttrs(node, ctx), tag('code', {}, renderChildren(node, ctx)));
    case 'menucascade':
      return tag(
        'span',
        commonAttrs(node, ctx),
        childElements(node)
          .map((c) => renderNode(c, ctx))
          .join(' <span class="menucascade-sep" aria-hidden="true">&gt;</span> '),
      );
    case 'tm': {
      const mark = node.attrs.tmtype === 'reg' ? '®' : node.attrs.tmtype === 'service' ? '℠' : '™';
      return tag('span', commonAttrs(node, ctx), renderChildren(node, ctx) + mark);
    }
    case 'fn':
      return tag('span', commonAttrs(node, ctx), ` (${renderChildren(node, ctx)})`);
    case 'table':
    case 'simpletable':
    case 'properties':
      return tag(
        'div',
        { class: 'table-wrap' },
        tag('table', commonAttrs(node, ctx), renderChildren(node, ctx)),
      );
    case 'tgroup':
      return renderChildren(node, {
        ...ctx,
        colnames: childElements(node, 'colspec').map((c, i) => c.attrs.colname ?? `col${i + 1}`),
      });
    case 'thead':
      return tag('thead', {}, renderChildren(node, { ...ctx, inThead: true }));
    case 'sthead':
    case 'prophead':
      // These are header rows, not row groups.
      return tag(
        'thead',
        {},
        tag('tr', commonAttrs(node, ctx), renderChildren(node, { ...ctx, inThead: true })),
      );
    case 'tbody':
      return tag('tbody', {}, renderChildren(node, ctx));
    case 'row':
    case 'strow':
    case 'property':
      return tag('tr', commonAttrs(node, ctx), renderChildren(node, ctx));
    case 'entry':
    case 'stentry':
    case 'proptype':
    case 'propvalue':
    case 'propdesc':
    case 'proptypehd':
    case 'propvaluehd':
    case 'propdeschd':
      return renderCell(node, ctx);
    default:
      break;
  }

  const label = SECTION_LABELS[name];
  const hasTitle = childElements(node, 'title').length > 0;
  const level = Math.min(6, ctx.depth + 1);
  const heading =
    label && !hasTitle ? `<h${level} class="section-label">${escapeHtml(label)}</h${level}>` : '';
  return tag(TAGS[name] ?? 'div', commonAttrs(node, ctx), heading + renderChildren(node, ctx));
}

/** A title's meaning depends on its parent: topic heading, section heading, or caption. */
function renderTitle(node: ElementNode, ctx: Ctx): string {
  const inner = renderChildren(node, ctx);
  if (ctx.parent === 'fig') return tag('figcaption', commonAttrs(node, ctx), inner);
  if (ctx.parent === 'table' || ctx.parent === 'simpletable')
    return tag('caption', commonAttrs(node, ctx), inner);
  const level = Math.min(6, TOPIC_TYPES.has(ctx.parent) ? ctx.depth : ctx.depth + 1);
  return tag(`h${level}`, commonAttrs(node, ctx), inner);
}

function renderNote(node: ElementNode, ctx: Ctx): string {
  const type =
    node.attrs.type === 'other' ? (node.attrs.othertype ?? 'note') : (node.attrs.type ?? 'note');
  const label = NOTE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
  const role = ['warning', 'danger', 'caution'].includes(type) ? 'alert' : 'note';
  return tag(
    'aside',
    { ...commonAttrs(node, ctx, `note-${type}`), role },
    `<span class="note-label">${escapeHtml(label)}:</span> ${renderChildren(node, ctx)}`,
  );
}

/** Link target for a resolved reference, or `null` when the reader cannot see it. */
function linkTarget(
  node: ElementNode,
  ctx: Ctx,
): { href: string; defaultText: string } | null | undefined {
  const target = node.attrs[TARGET_ATTR];
  if (target !== undefined) {
    const [id = '', fragment] = target.split('#');
    if (ctx.topicLink) {
      const link = ctx.topicLink(id, fragment || undefined);
      return link && { href: link.href, defaultText: link.title };
    }
    const topic = ctx.view.topic(id);
    if (!topic) return null;
    return {
      href: ctx.topicHref(id) + (fragment ? `#${encodeURIComponent(fragment)}` : ''),
      defaultText: topic.title,
    };
  }
  const asset = node.attrs[ASSET_ATTR];
  if (asset !== undefined) {
    const href = ctx.assetSrc(asset, 'link');
    return href === null ? null : { href, defaultText: asset.split('/').pop() ?? asset };
  }
  const href = node.attrs.href;
  const external = href !== undefined && (node.attrs.scope === 'external' || urlScheme(href));
  if (external) return safeUrl(href, LINK_SCHEMES) ? { href, defaultText: href } : null;
  return undefined; // unresolved (already reported by the build)
}

/** Schemes an authored link may use. Anything else (`javascript:`, `data:`) is dropped. */
const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'ftp']);
const IMAGE_SCHEMES = new Set(['http', 'https']);

/** The lower-case scheme of a URL as a browser reads it (ignoring whitespace and controls). */
function urlScheme(url: string): string | null {
  // eslint-disable-next-line no-control-regex
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(/[\u0000-\u0020\u007f]/g, ''));
  return m ? m[1]!.toLowerCase() : null;
}

/** Relative URLs, and absolute ones with an allowed scheme. */
function safeUrl(url: string, schemes: ReadonlySet<string>): boolean {
  const scheme = urlScheme(url);
  return scheme === null || schemes.has(scheme);
}

function renderXref(node: ElementNode, ctx: Ctx): string {
  const content = node.children.filter((c) => !(c.type === 'element' && c.name === 'desc'));
  const inner = content.map((c) => renderNode(c, ctx)).join('');
  const target = linkTarget(node, ctx);
  if (!target) {
    // Hidden or unresolved target: never reveal its title, keep only authored text.
    return inner.trim() ? tag('span', { class: 'xref xref-unavailable' }, inner) : '';
  }
  const external = !node.attrs[TARGET_ATTR] && !node.attrs[ASSET_ATTR];
  return tag(
    'a',
    { ...commonAttrs(node, ctx), href: target.href, rel: external ? 'noopener' : undefined },
    inner.trim() ? inner : escapeHtml(target.defaultText),
  );
}

function renderLink(node: ElementNode, ctx: Ctx): string {
  const target = linkTarget(node, ctx);
  if (!target) return '';
  const linktext = childElements(node, 'linktext')[0];
  const desc = childElements(node, 'desc')[0];
  const text = linktext ? renderChildren(linktext, ctx) : escapeHtml(target.defaultText);
  return tag(
    'li',
    commonAttrs(node, ctx),
    tag('a', { href: target.href }, text) + (desc ? ` — ${renderChildren(desc, ctx)}` : ''),
  );
}

function renderRelatedLinks(node: ElementNode, ctx: Ctx): string {
  const items = renderChildren(node, ctx);
  if (!items.trim()) return '';
  return tag('nav', commonAttrs(node, ctx), `<h2>Related information</h2><ul>${items}</ul>`);
}

function renderImage(node: ElementNode, ctx: Ctx): string {
  const asset = node.attrs[ASSET_ATTR];
  const href = node.attrs.href;
  const src =
    asset !== undefined
      ? ctx.assetSrc(asset, 'image')
      : href !== undefined && safeUrl(href, IMAGE_SCHEMES)
        ? href
        : null;
  const altEl = childElements(node, 'alt')[0];
  const alt = altEl ? textContent(altEl) : (node.attrs.alt ?? '');
  if (!src) return alt ? tag('span', { class: 'image-unavailable' }, escapeHtml(alt)) : '';
  const img = `<img${attrString({ ...commonAttrs(node, ctx), src, alt, width: node.attrs.width, height: node.attrs.height })}>`;
  return node.attrs.placement === 'break' ? tag('div', { class: 'image-break' }, img) : img;
}

function renderCell(node: ElementNode, ctx: Ctx): string {
  const header = ctx.inThead || node.name.endsWith('hd');
  const attrs = commonAttrs(node, ctx);
  if (node.attrs.morerows) attrs.rowspan = String(Number(node.attrs.morerows) + 1);
  const start = ctx.colnames.indexOf(node.attrs.namest ?? '');
  const end = ctx.colnames.indexOf(node.attrs.nameend ?? '');
  if (start !== -1 && end > start) attrs.colspan = String(end - start + 1);
  return tag(header ? 'th' : 'td', attrs, renderChildren(node, ctx));
}
