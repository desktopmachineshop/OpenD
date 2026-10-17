import type { Node as PMNode } from 'prosemirror-model';
import {
  MARK_TAGS_SET,
  PREFORMATTED,
  attrsOf,
  blockXml,
  blocksOf,
  inlineContent,
  inlineXml,
  isElement,
} from './convert.js';
import { schema, type XmlAttrs } from './schema.js';
import { indentAt, scanXml, type SourceNode } from './scan.js';

/** Parses XML text into a DOM document: the browser's DOMParser or @xmldom/xmldom. */
export type XmlParser = (xml: string) => Document;

const BODY_TAGS: Record<string, string> = {
  topic: 'body',
  concept: 'conbody',
  task: 'taskbody',
  reference: 'refbody',
  troubleshooting: 'troublebody',
};

export type LoadResult = { ok: true; topic: VisualTopic } | { ok: false; reason: string };

/** Entities DITA authors use that XML does not define; parsed as characters. */
const ENTITIES: Record<string, string> = {
  nbsp: '&#160;',
  ndash: '&#8211;',
  mdash: '&#8212;',
  hellip: '&#8230;',
  copy: '&#169;',
  reg: '&#174;',
  trade: '&#8482;',
  lsquo: '&#8216;',
  rsquo: '&#8217;',
  ldquo: '&#8220;',
  rdquo: '&#8221;',
  rarr: '&#8594;',
  times: '&#215;',
};

function parse(parser: XmlParser, xml: string): Document | null {
  let doc: Document;
  try {
    doc = parser(xml.replace(/&([a-z]+);/g, (m, name: string) => ENTITIES[name] ?? m));
  } catch {
    return null;
  }
  if (!doc.documentElement || doc.getElementsByTagName('parsererror').length) return null;
  return doc;
}

function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (isElement(n)) out.push(n);
  return out;
}

/**
 * A topic opened in the visual editor: the editor document plus what is needed
 * to write it back into the original source, touching only what changed.
 */
export class VisualTopic {
  /** Original source of each top-level block that came from one source node. */
  private readonly origins = new WeakMap<PMNode, string>();

  private constructor(
    readonly source: string,
    readonly doc: PMNode,
    private readonly ranges: {
      root: SourceNode;
      title: SourceNode | undefined;
      shortdesc: SourceNode | undefined;
      body: SourceNode | undefined;
    },
    private readonly bodyTag: string,
    private readonly bodyNodes: (PMNode | null)[],
  ) {}

  /**
   * Opens `source` visually, or explains why it must stay in source mode. The
   * topic must convert to the editor and back without changing its meaning.
   */
  static load(source: string, parser: XmlParser): LoadResult {
    const dom = parse(parser, source);
    if (!dom) return { ok: false, reason: 'The file is not well-formed XML. Fix it in Source.' };
    const root = dom.documentElement;
    const bodyTag = BODY_TAGS[root.nodeName];
    if (!bodyTag)
      return {
        ok: false,
        reason:
          root.nodeName.endsWith('map') || root.nodeName === 'map'
            ? 'Maps are edited in Source.'
            : `<${root.nodeName}> files are edited in Source.`,
      };
    const scanned = scanXml(source).find((n) => n.kind === 'element');
    if (!scanned) return { ok: false, reason: 'The file has no root element.' };
    const kids = elementChildren(root);
    const sKids = scanned.children.filter((n) => n.kind === 'element');
    const find = (name: string) => {
      const i = kids.findIndex((k) => k.nodeName === name);
      return i === -1 ? undefined : { el: kids[i]!, range: sKids[i] };
    };
    const title = find('title');
    const shortdesc = find('shortdesc');
    const body = find(bodyTag);
    if (!title) return { ok: false, reason: 'The topic has no title.' };

    const bodyNodes: (PMNode | null)[] = [];
    const blocks: PMNode[] = [];
    const origins: [PMNode, string][] = [];
    if (body) {
      // A block built from one body child keeps that child's exact source text.
      const sChildren = body.range!.children;
      const domKids: Node[] = [];
      for (let n = body.el.firstChild; n; n = n.nextSibling)
        if (n.nodeType === 1 || n.nodeType === 7 || n.nodeType === 8) domKids.push(n);
      blocksOf(body.el, bodyTag, (block, from) => {
        blocks.push(block);
        bodyNodes.push(block);
        const range = from ? sChildren[domKids.indexOf(from)] : undefined;
        if (range) origins.push([block, source.slice(range.start, range.end)]);
      });
    }
    const doc = schema.nodes.doc!.create({ tag: bodyTag, attrs: body ? attrsOf(body.el) : {} }, [
      schema.nodes.topictitle!.create(null, inlineContent(childNodes(title.el))),
      schema.nodes.shortdesc!.create(
        null,
        shortdesc ? inlineContent(childNodes(shortdesc.el)) : [],
      ),
      ...blocks,
    ]);
    try {
      doc.check();
    } catch {
      return {
        ok: false,
        reason: 'The topic’s structure is not one the visual editor supports yet.',
      };
    }
    const topic = new VisualTopic(
      source,
      doc,
      { root: scanned, title: title.range, shortdesc: shortdesc?.range, body: body?.range },
      bodyTag,
      bodyNodes,
    );
    for (const [node, text] of origins) topic.origins.set(node, text);
    // Round trip: regenerating everything must keep the meaning, and saving
    // without changes must give back the file byte for byte.
    if (topic.toSource(doc) !== source)
      return { ok: false, reason: 'The visual editor could not reproduce this file exactly.' };
    const rebuilt = parse(parser, topic.toSource(doc, { regenerate: true }));
    if (!rebuilt || canonical(rebuilt.documentElement) !== canonical(root))
      return {
        ok: false,
        reason:
          'This topic uses markup the visual editor cannot change safely yet. Edit it in Source.',
      };
    return { ok: true, topic };
  }

  /** The file with `doc` written into it. Unchanged parts keep their exact source text. */
  toSource(doc: PMNode, options: { regenerate?: boolean } = {}): string {
    const src = this.source;
    const regenerate = options.regenerate === true;
    const edits: { start: number; end: number; text: string }[] = [];
    const title = doc.child(0);
    const shortdesc = doc.child(1);
    // An empty text block with no element is only the editor's place to type: not saved.
    const blocks: PMNode[] = [];
    for (let i = 2; i < doc.childCount; i++) {
      const b = doc.child(i);
      if (!(b.type.name === 'textblock' && !b.content.size && !String(b.attrs.tag))) blocks.push(b);
    }

    const { title: tRange, shortdesc: sRange, body: bRange, root } = this.ranges;
    const original = this.doc;
    if (regenerate || title !== original.child(0))
      edits.push(replaceElement(src, tRange!, 'title', inlineXml(title)));
    if (regenerate || shortdesc !== original.child(1)) {
      const inner = inlineXml(shortdesc);
      if (sRange) {
        if (inner) edits.push(replaceElement(src, sRange, 'shortdesc', inner));
        else edits.push({ start: lineStartIfBlank(src, sRange.start), end: sRange.end, text: '' });
      } else if (inner) {
        const indent = indentAt(src, tRange!.start) ?? '';
        edits.push({
          start: tRange!.end,
          end: tRange!.end,
          text: `\n${indent}<shortdesc>${inner}</shortdesc>`,
        });
      }
    }
    const sameBody =
      !regenerate &&
      blocks.length === this.bodyNodes.length &&
      blocks.every((b, i) => b === this.bodyNodes[i]);
    if (!sameBody) {
      const baseIndent = bRange
        ? (indentAt(src, bRange.start) ?? '')
        : (indentAt(src, tRange!.start) ?? '  ');
      const firstChild = bRange?.children.find((c) => c.kind === 'element');
      const childIndent = (firstChild && indentAt(src, firstChild.start)) || `${baseIndent}  `;
      const step =
        childIndent.startsWith(baseIndent) && childIndent.length > baseIndent.length
          ? childIndent.slice(baseIndent.length)
          : '  ';
      const lines = blocks.map((b) => {
        const kept = regenerate ? undefined : this.origins.get(b);
        return `\n${childIndent}${kept ?? blockXml(b, childIndent, step)}`;
      });
      const attrs = doc.attrs.attrs as XmlAttrs;
      const openTag =
        bRange && !bRange.selfClosing
          ? src.slice(bRange.start, bRange.openEnd)
          : `<${this.bodyTag}${Object.entries(attrs)
              .map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
              .join('')}>`;
      const text = lines.length
        ? `${openTag}${lines.join('')}\n${baseIndent}</${this.bodyTag}>`
        : bRange
          ? `${openTag}</${this.bodyTag}>`
          : '';
      if (bRange) edits.push({ start: bRange.start, end: bRange.end, text });
      else if (text) {
        // A new body goes after the title, short description, abstract and prolog.
        const before = root.children
          .filter(
            (c) =>
              c.kind === 'element' &&
              ['title', 'titlealts', 'shortdesc', 'abstract', 'prolog'].includes(c.name),
          )
          .at(-1);
        const at = before ? before.end : root.openEnd;
        edits.push({ start: at, end: at, text: `\n${baseIndent}${text}` });
      }
    }
    edits.sort((a, b) => b.start - a.start);
    let out = src;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
  }
}

function childNodes(el: Element): Node[] {
  const out: Node[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) out.push(n);
  return out;
}

function replaceElement(src: string, range: SourceNode, tag: string, inner: string) {
  const open = range.selfClosing ? `<${tag}>` : src.slice(range.start, range.openEnd);
  return { start: range.start, end: range.end, text: `${open}${inner}</${tag}>` };
}

function lineStartIfBlank(src: string, offset: number): number {
  const indent = indentAt(src, offset);
  if (indent === null) return offset;
  const lineStart = offset - indent.length;
  return lineStart > 0 && src[lineStart - 1] === '\n' ? lineStart - 1 : lineStart;
}

// ---- canonical form ----------------------------------------------------------

/**
 * A form of an element that ignores what does not change its meaning: attribute
 * order, insignificant whitespace, and the nesting order of formatting
 * (`<b><i>x</i></b>` equals `<i><b>x</b></i>`). Two elements with the same
 * canonical form render the same.
 */
export function canonical(el: Element): string {
  return JSON.stringify(canon(el));
}

type Token = string | [string, string] | Canon;
interface Canon {
  n: string;
  a: [string, string][];
  c: Token[];
}

function canon(el: Element): Canon {
  const tag = el.nodeName;
  const a = Object.entries(attrsOf(el)).sort(([x], [y]) => (x < y ? -1 : 1));
  if (PREFORMATTED.has(tag)) {
    return { n: tag, a, c: childNodes(el).map((n) => (isElement(n) ? canon(n) : textOf(n))) };
  }
  const tokens: Token[] = [];
  flatten(childNodes(el), '', tokens);
  // Merge neighbouring text with the same formatting, collapse whitespace and drop blank runs.
  const merged: Token[] = [];
  for (const t of tokens) {
    const prev = merged.at(-1);
    if (Array.isArray(t) && Array.isArray(prev) && prev[0] === t[0]) prev[1] += t[1];
    else merged.push(Array.isArray(t) ? [t[0], t[1]] : t);
  }
  const c: Token[] = [];
  for (const t of merged) {
    if (!Array.isArray(t)) {
      c.push(t);
      continue;
    }
    const text = t[1].replace(/\s+/g, ' ').trim();
    if (text) c.push([t[0], text]);
  }
  return { n: tag, a, c };
}

function textOf(n: Node): string {
  if (n.nodeType === 8) return `<!--${n.nodeValue ?? ''}-->`;
  if (n.nodeType === 7) return `<?${(n as ProcessingInstruction).target} ${n.nodeValue ?? ''}?>`;
  return n.nodeValue ?? '';
}

function flatten(nodes: Node[], marks: string, out: Token[]): void {
  for (const n of nodes) {
    if (n.nodeType === 3 || n.nodeType === 4) out.push([marks, n.nodeValue ?? '']);
    else if (n.nodeType === 8 || n.nodeType === 7) out.push(textOf(n).trim());
    else if (isElement(n)) {
      const attrs = Object.entries(attrsOf(n)).sort(([x], [y]) => (x < y ? -1 : 1));
      if (MARK_TAGS_SET.has(n.nodeName) && (n.textContent ?? '').trim()) {
        const set = [...marks.split('|').filter(Boolean), `${n.nodeName}${JSON.stringify(attrs)}`]
          .sort()
          .join('|');
        flatten(childNodes(n), set, out);
      } else out.push({ ...canon(n), n: `${marks}>${n.nodeName}` });
    }
  }
}
