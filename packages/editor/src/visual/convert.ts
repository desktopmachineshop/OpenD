import type { Mark, Node as PMNode } from 'prosemirror-model';
import { MARK_TAGS, markName, schema, type MarkTag, type XmlAttrs } from './schema.js';

/**
 * DITA ⇄ editor document. `toDoc` reads a topic's DOM (the browser's
 * DOMParser, or @xmldom/xmldom in tests) into the editor model; `blockXml` and
 * friends write editor nodes back as DITA. Anything the editor does not model
 * becomes a `raw` node holding its XML, so nothing is dropped.
 */

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;
const PI = 7;
const COMMENT = 8;

export const TEXTBLOCK_TAGS = new Set(['p', 'cmd', 'dt', 'dthd', 'ddhd']);
export const CODE_TAGS = new Set(['codeblock', 'pre', 'lines', 'screen', 'msgblock']);
export const LIST_TAGS = new Set([
  'ul',
  'ol',
  'sl',
  'steps',
  'steps-unordered',
  'substeps',
  'choices',
]);
export const ITEM_TAGS = new Set(['li', 'sli', 'step', 'substep', 'choice']);
export const CONTAINER_TAGS = new Set([
  'section',
  'example',
  'sectiondiv',
  'bodydiv',
  'div',
  'note',
  'lq',
  'fig',
  'abstract',
  'prereq',
  'context',
  'result',
  'postreq',
  'info',
  'stepresult',
  'stepxmp',
  'tutorialinfo',
  'tasktroubleshooting',
  'refsyn',
  'dl',
  'dlhead',
  'dlentry',
  'dd',
  'remedy',
  'condition',
  'cause',
  'troubleSolution',
  'steps-informal',
  'itemgroup',
]);
/** Containers whose first child may be a `<title>`. */
const TITLED = new Set(['section', 'example', 'fig', 'refsyn', 'condition', 'cause', 'remedy']);
/** Inline elements the editor shows as chips; known inline, so text around them stays one block. */
const INLINE_RAW = new Set([
  'image',
  'xref',
  'fn',
  'indexterm',
  'keyword',
  'tm',
  'menucascade',
  'data',
  'draft-comment',
  'required-cleanup',
  'abbreviated-form',
  'state',
  'boolean',
  'ph',
]);
const MARK_SET = new Set<string>(MARK_TAGS);
export const PREFORMATTED = CODE_TAGS;
export const MARK_TAGS_SET = MARK_SET;

/** Friendly names for chips. */
const LABELS: Record<string, string> = {
  table: 'Table',
  simpletable: 'Table',
  properties: 'Properties table',
  choicetable: 'Choices table',
  image: 'Image',
  fn: 'Footnote',
  xref: 'Link',
  indexterm: 'Index entry',
  keyword: 'Keyword',
  'draft-comment': 'Draft comment',
  'required-cleanup': 'Cleanup note',
  object: 'Embedded object',
  'related-links': 'Related links',
  data: 'Metadata',
};

type DomNode = Node;

export function isElement(n: DomNode): n is Element {
  return n.nodeType === ELEMENT;
}

export function attrsOf(el: Element): XmlAttrs {
  const out: XmlAttrs = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    out[a.name] = a.value;
  }
  return out;
}

function children(el: Element | Document): DomNode[] {
  const out: DomNode[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) out.push(n);
  return out;
}

const borrowed = (el: Element) =>
  el.hasAttribute('conref') || el.hasAttribute('conkeyref') || el.hasAttribute('conaction');

// ---- XML text ------------------------------------------------------------

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

export function attrText(attrs: XmlAttrs): string {
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
}

/** A DOM node as XML text: the same output in the browser and in Node. */
export function domXml(n: DomNode): string {
  switch (n.nodeType) {
    case TEXT:
    case CDATA:
      return escapeText(n.nodeValue ?? '');
    case COMMENT:
      return `<!--${n.nodeValue ?? ''}-->`;
    case PI:
      return `<?${(n as ProcessingInstruction).target} ${n.nodeValue ?? ''}?>`;
    case ELEMENT: {
      const el = n as Element;
      const inner = children(el).map(domXml).join('');
      const open = `<${el.nodeName}${attrText(attrsOf(el))}`;
      return inner ? `${open}>${inner}</${el.nodeName}>` : `${open}/>`;
    }
    default:
      return '';
  }
}

function label(n: DomNode): string {
  if (n.nodeType === COMMENT) return 'Comment';
  if (n.nodeType === PI) return 'Processing instruction';
  const el = n as Element;
  const name = LABELS[el.nodeName] ?? `<${el.nodeName}>`;
  if (borrowed(el)) return `${name} (reused content)`;
  if (el.nodeName === 'image') {
    const alt = el.getElementsByTagName('alt')[0]?.textContent?.trim() || el.getAttribute('alt');
    return `Image: ${alt || el.getAttribute('href') || el.getAttribute('keyref') || ''}`.trim();
  }
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (el.nodeName === 'xref')
    return text || `Link: ${el.getAttribute('href') ?? el.getAttribute('keyref') ?? ''}`;
  if (el.nodeName === 'keyword' && !text) return el.getAttribute('keyref') ?? 'Keyword';
  return text ? `${name} ${text.length > 60 ? `${text.slice(0, 57)}…` : text}` : name;
}

const raw = (n: DomNode) =>
  schema.nodes.raw_block!.create({ xml: domXml(n), label: label(n) }) as PMNode;
const rawInline = (n: DomNode, marks: readonly Mark[]) =>
  schema.nodes.raw_inline!.create({ xml: domXml(n), label: label(n) }, null, marks) as PMNode;

// ---- DOM → editor --------------------------------------------------------

/** Whether a node belongs in running text rather than starting a block of its own. */
function isInline(n: DomNode): boolean {
  if (n.nodeType === TEXT || n.nodeType === CDATA) return true;
  if (!isElement(n)) return false;
  return MARK_SET.has(n.nodeName) || INLINE_RAW.has(n.nodeName);
}

const hasText = (nodes: DomNode[]) =>
  nodes.some((n) => (n.nodeType !== TEXT && n.nodeType !== CDATA) || /\S/.test(n.nodeValue ?? ''));

/**
 * The blocks inside a block container. Text and inline elements directly in
 * the container (`<li>Press <b>Save</b></li>`) become one implicit text block.
 */
export function blocksOf(
  el: Element,
  parentTag = el.nodeName,
  onBlock?: (block: PMNode, source: DomNode | null) => void,
): PMNode[] {
  const out: PMNode[] = [];
  let pending: DomNode[] = [];
  const flush = () => {
    if (hasText(pending)) {
      out.push(textblock('', {}, pending));
      onBlock?.(out.at(-1)!, null);
    }
    pending = [];
  };
  const kids = children(el);
  kids.forEach((n, i) => {
    if (isInline(n)) {
      pending.push(n);
      return;
    }
    // Comments and unknown elements sit in running text when text surrounds them.
    if (n.nodeType === COMMENT || n.nodeType === PI || (isElement(n) && !knownBlock(n))) {
      const next = kids[i + 1];
      if (hasText(pending) || (next && isInline(next) && hasText([next]))) {
        pending.push(n);
        return;
      }
    }
    if (n.nodeType !== ELEMENT && n.nodeType !== COMMENT && n.nodeType !== PI) return;
    flush();
    out.push(blockOf(n, parentTag, out.length === 0));
    onBlock?.(out.at(-1)!, n);
  });
  flush();
  return out;
}

function knownBlock(el: Element): boolean {
  const t = el.nodeName;
  return (
    TEXTBLOCK_TAGS.has(t) ||
    t === 'title' ||
    CODE_TAGS.has(t) ||
    LIST_TAGS.has(t) ||
    ITEM_TAGS.has(t) ||
    CONTAINER_TAGS.has(t)
  );
}

/** One block-level DOM node as an editor node. */
export function blockOf(n: DomNode, parentTag: string, first: boolean): PMNode {
  if (!isElement(n) || borrowed(n)) return raw(n);
  const tag = n.nodeName;
  const attrs = attrsOf(n);
  if (TEXTBLOCK_TAGS.has(tag) || (tag === 'title' && first && TITLED.has(parentTag)))
    return textblock(tag, attrs, children(n));
  if (CODE_TAGS.has(tag)) {
    const kids = children(n);
    if (kids.every((k) => k.nodeType === TEXT || k.nodeType === CDATA)) {
      const text = kids.map((k) => k.nodeValue ?? '').join('');
      return schema.nodes.code!.create({ tag, attrs }, text ? schema.text(text) : null);
    }
    return raw(n);
  }
  if (LIST_TAGS.has(tag)) {
    const items = children(n).filter(
      (k) => isElement(k) || k.nodeType === COMMENT || k.nodeType === PI,
    );
    if (!items.length) return raw(n);
    return schema.nodes.list!.create(
      { tag, attrs },
      items.map((k) =>
        isElement(k) && ITEM_TAGS.has(k.nodeName) && !borrowed(k) ? itemOf(k) : raw(k),
      ),
    );
  }
  if (CONTAINER_TAGS.has(tag)) {
    const blocks = blocksOf(n, tag);
    return schema.nodes.container!.create(
      { tag, attrs },
      blocks.length ? blocks : [textblock('', {}, [])],
    );
  }
  return raw(n);
}

function itemOf(el: Element): PMNode {
  const blocks = blocksOf(el, el.nodeName);
  return schema.nodes.item!.create(
    { tag: el.nodeName, attrs: attrsOf(el) },
    blocks.length ? blocks : [textblock('', {}, [])],
  );
}

/** A text block from running text, with whitespace collapsed the way a browser shows it. */
export function textblock(tag: string, attrs: XmlAttrs, nodes: DomNode[]): PMNode {
  const out: PMNode[] = [];
  inlineInto(out, nodes, []);
  return schema.nodes.textblock!.create({ tag, attrs }, trimInline(out));
}

/** Inline content for the title or short description. */
export function inlineContent(nodes: DomNode[]): PMNode[] {
  const out: PMNode[] = [];
  inlineInto(out, nodes, []);
  return trimInline(out);
}

function inlineInto(out: PMNode[], nodes: DomNode[], marks: readonly Mark[]): void {
  for (const n of nodes) {
    if (n.nodeType === TEXT || n.nodeType === CDATA) {
      const text = (n.nodeValue ?? '').replace(/\s+/g, ' ');
      if (!text) continue;
      const prev = out.at(-1);
      const value = prev?.isText && prev.text!.endsWith(' ') ? text.replace(/^ /, '') : text;
      if (value) out.push(schema.text(value, marks));
      continue;
    }
    if (!isElement(n) || borrowed(n)) {
      if (n.nodeType === ELEMENT || n.nodeType === COMMENT || n.nodeType === PI)
        out.push(rawInline(n, marks));
      continue;
    }
    const tag = n.nodeName;
    const type = MARK_SET.has(tag) ? schema.marks[markName(tag as MarkTag)] : undefined;
    const text = (n.textContent ?? '').trim();
    // A mark needs text to sit on, and cannot nest inside itself.
    if (type && text && !marks.some((m) => m.type === type)) {
      inlineInto(out, children(n), type.create({ tag, attrs: attrsOf(n) }).addToSet(marks));
      continue;
    }
    out.push(rawInline(n, marks));
  }
}

function trimInline(nodes: PMNode[]): PMNode[] {
  const out = [...nodes];
  const first = out[0];
  if (first?.isText) {
    const t = first.text!.replace(/^ /, '');
    if (t) out[0] = schema.text(t, first.marks);
    else out.shift();
  }
  const last = out.at(-1);
  if (last?.isText) {
    const t = last.text!.replace(/ $/, '');
    if (t) out[out.length - 1] = schema.text(t, last.marks);
    else out.pop();
  }
  return out;
}

// ---- editor → XML ----------------------------------------------------------

const markRank = (m: Mark) => MARK_TAGS.indexOf(String(m.attrs.tag) as MarkTag);

/** Inline content as XML: marks become nested elements, outermost by schema order. */
export function inlineXml(node: PMNode): string {
  let out = '';
  const open: Mark[] = [];
  const closeTo = (depth: number) => {
    while (open.length > depth) out += `</${String(open.pop()!.attrs.tag)}>`;
  };
  node.forEach((child) => {
    const marks = [...child.marks].sort((a, b) => markRank(a) - markRank(b));
    let keep = 0;
    while (keep < open.length && keep < marks.length && open[keep]!.eq(marks[keep]!)) keep++;
    closeTo(keep);
    for (const m of marks.slice(keep)) {
      out += `<${String(m.attrs.tag)}${attrText(m.attrs.attrs as XmlAttrs)}>`;
      open.push(m);
    }
    if (child.isText) out += escapeText(child.text!);
    else if (child.type.name === 'raw_inline') out += String(child.attrs.xml);
  });
  closeTo(0);
  return out;
}

const tagOf = (node: PMNode) => String(node.attrs.tag);
const xmlAttrsOf = (node: PMNode) => node.attrs.attrs as XmlAttrs;

/** Whether a container's content is only running text, so it can stay on one line. */
function onlyText(node: PMNode): boolean {
  return (
    node.childCount === 1 && node.firstChild!.type.name === 'textblock' && !tagOf(node.firstChild!)
  );
}

/** One block as indented XML. `indent` is the block's own indentation; the first line carries none. */
export function blockXml(node: PMNode, indent: string, step = '  '): string {
  const name = node.type.name;
  if (name === 'raw_block') return String(node.attrs.xml);
  if (name === 'textblock') {
    const inner = inlineXml(node);
    const tag = tagOf(node);
    return tag ? `<${tag}${attrText(xmlAttrsOf(node))}>${inner}</${tag}>` : inner;
  }
  if (name === 'code')
    return `<${tagOf(node)}${attrText(xmlAttrsOf(node))}>${escapeText(node.textContent)}</${tagOf(node)}>`;
  const tag = tagOf(node);
  const open = `<${tag}${attrText(xmlAttrsOf(node))}>`;
  if (onlyText(node)) return `${open}${inlineXml(node.firstChild!)}</${tag}>`;
  const inner = indent + step;
  const parts: string[] = [];
  node.forEach((child) => parts.push(`\n${inner}${blockXml(child, inner, step)}`));
  return `${open}${parts.join('')}\n${indent}</${tag}>`;
}
