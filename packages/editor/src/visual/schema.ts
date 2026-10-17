import { Schema, type DOMOutputSpec, type Mark, type Node as PMNode } from 'prosemirror-model';

/**
 * The visual editor's document model. It mirrors DITA generically rather than
 * element by element: every node and mark remembers its DITA element name
 * (`tag`) and all of its XML attributes (`attrs`), so a topic converts to the
 * editor and back without losing anything. Markup the editor cannot show is
 * kept whole as a `raw` node holding the original XML.
 *
 * - `topictitle`, `shortdesc`: the topic's title and short description.
 * - `textblock`: a run of text: `p`, a section `title`, a step's `cmd`, a
 *   `dt`, or (tag `''`) bare text inside a container such as `<li>Text</li>`.
 * - `code`: preformatted text (`codeblock`, `pre`, `lines`, `screen`, `msgblock`).
 * - `list` / `item`: `ul`, `ol`, `sl`, `steps`, `substeps`, `choices` and their items.
 * - `container`: every other block that holds blocks (`section`, `note`, `fig`, `dd`…).
 * - `raw_block` / `raw_inline`: anything else, kept verbatim and shown as a chip.
 */

export type XmlAttrs = Record<string, string>;

/** Inline elements the editor edits as formatting marks, in nesting order (outermost first). */
export const MARK_TAGS = [
  'xref',
  'ph',
  'b',
  'i',
  'u',
  'sup',
  'sub',
  'tt',
  'line-through',
  'overline',
  'codeph',
  'uicontrol',
  'wintitle',
  'filepath',
  'cmdname',
  'varname',
  'userinput',
  'systemoutput',
  'option',
  'parmname',
  'apiname',
  'msgph',
  'synph',
  'term',
  'keyword',
  'cite',
  'q',
  'text',
] as const;
export type MarkTag = (typeof MARK_TAGS)[number];

/** The schema's name for a mark tag: `text` is taken by ProseMirror's text node. */
export function markName(tag: MarkTag): string {
  return tag === 'text' ? 'dita_text' : tag;
}

/**
 * Attributes that make content conditional (filtered per reader): the same list
 * as `FILTER_ATTRIBUTES` in @opend/model, kept here so the browser bundle does
 * not pull in the model package (a test keeps them equal).
 */
export const CONDITION_ATTRS = [
  'release',
  'product',
  'feature',
  'audience',
  'platform',
  'otherprops',
  'props',
  'deliveryTarget',
] as const;

/** What each condition means, for the block settings panel. */
export const CONDITION_HINTS: Record<(typeof CONDITION_ATTRS)[number], string> = {
  release: 'Versions, e.g. 2.0.. (2.0 and later) or ..1.9',
  product: 'Products the reader must have',
  feature: 'Features the reader must have',
  audience: 'Audience, e.g. admin',
  platform: 'Platform, e.g. linux',
  otherprops: 'Other properties',
  props: 'Properties',
  deliveryTarget: 'Output, e.g. pdf or html',
};

/** A short label for content shown only to some readers, e.g. `audience: admin`. */
export function conditionLabel(attrs: XmlAttrs): string {
  return CONDITION_ATTRS.filter((a) => attrs[a]?.trim())
    .map((a) => `${a}: ${attrs[a]!.trim()}`)
    .join(' · ');
}

const blockAttrs = { tag: { default: 'p' }, attrs: { default: {} as XmlAttrs } };

/** HTML attributes that let a node survive copy and paste inside the editor. */
function dataAttrs(
  node: PMNode | Mark,
  extra: Record<string, string> = {},
): Record<string, string> {
  const attrs = node.attrs.attrs as XmlAttrs;
  const out: Record<string, string> = {
    'data-vx': String(node.attrs.tag),
    'data-vx-attrs': JSON.stringify(attrs),
    ...extra,
  };
  const cond = conditionLabel(attrs);
  if (cond) out['data-cond'] = cond;
  return out;
}

function readData(el: HTMLElement): { tag: string; attrs: XmlAttrs } | false {
  const tag = el.getAttribute('data-vx');
  if (tag === null) return false;
  let attrs: XmlAttrs = {};
  try {
    const parsed = JSON.parse(el.getAttribute('data-vx-attrs') ?? '{}') as unknown;
    if (parsed && typeof parsed === 'object') attrs = parsed as XmlAttrs;
  } catch {
    // Pasted from elsewhere with a broken attribute; keep the element without attributes.
  }
  return { tag, attrs };
}

const TEXTBLOCK_HTML: Record<string, string> = {
  p: 'p',
  title: 'h2',
  cmd: 'p',
  dt: 'dt',
  '': 'p',
};

const LIST_HTML: Record<string, string> = {
  ul: 'ul',
  ol: 'ol',
  sl: 'ul',
  steps: 'ol',
  substeps: 'ol',
  'steps-unordered': 'ul',
  choices: 'ul',
};

const CONTAINER_HTML: Record<string, string> = {
  section: 'section',
  example: 'section',
  note: 'aside',
  lq: 'blockquote',
  fig: 'figure',
  dl: 'dl',
  dd: 'dd',
};

const MARK_HTML: Partial<Record<MarkTag, string>> = {
  b: 'strong',
  i: 'em',
  u: 'u',
  sup: 'sup',
  sub: 'sub',
  tt: 'code',
  codeph: 'code',
  q: 'q',
  cite: 'cite',
  xref: 'a',
};

function markSpec(tag: MarkTag) {
  return {
    attrs: { tag: { default: tag }, attrs: { default: {} as XmlAttrs } },
    // The same element nested in itself (`<ph><ph>`) is rare and kept raw, so
    // one mark of each kind at a time is enough.
    excludes: markName(tag),
    inclusive: tag !== 'xref',
    parseDOM: [
      {
        tag: `[data-vx="${tag}"]`,
        getAttrs: (el: HTMLElement) => readData(el),
      },
      ...pasteRules(tag),
    ],
    toDOM: (mark: Mark): DOMOutputSpec => {
      const html = MARK_HTML[tag] ?? 'span';
      const attrs = mark.attrs.attrs as XmlAttrs;
      const extra: Record<string, string> = { class: `vx-m vx-m-${tag}` };
      if (tag === 'xref' && attrs.href) extra.title = attrs.href;
      return [html, dataAttrs(mark, extra), 0];
    },
  };
}

/** How common HTML pasted from other sites maps to DITA marks. */
function pasteRules(tag: MarkTag) {
  const html: Partial<Record<MarkTag, string[]>> = {
    b: ['strong', 'b'],
    i: ['em', 'i'],
    u: ['u'],
    sup: ['sup'],
    sub: ['sub'],
    codeph: ['code', 'kbd', 'samp'],
  };
  const rules: { tag: string; getAttrs: (el: HTMLElement) => { tag: MarkTag; attrs: XmlAttrs } }[] =
    (html[tag] ?? []).map((t) => ({ tag: t, getAttrs: () => ({ tag, attrs: {} }) }));
  if (tag === 'xref')
    rules.push({
      tag: 'a[href]',
      getAttrs: (el) => {
        const href = el.getAttribute('href') ?? '';
        const attrs: XmlAttrs = /^https?:/i.test(href)
          ? { href, scope: 'external', format: 'html' }
          : { href };
        return { tag, attrs };
      },
    });
  return rules;
}

export const schema = new Schema({
  nodes: {
    doc: {
      content: 'topictitle shortdesc block*',
      attrs: { tag: { default: 'body' }, attrs: { default: {} as XmlAttrs } },
    },
    topictitle: {
      content: 'inline*',
      marks: '_',
      defining: true,
      parseDOM: [{ tag: 'h1.vx-title' }],
      toDOM: (): DOMOutputSpec => ['h1', { class: 'vx-title' }, 0],
    },
    shortdesc: {
      content: 'inline*',
      marks: '_',
      defining: true,
      toDOM: (): DOMOutputSpec => ['p', { class: 'vx-shortdesc' }, 0],
    },
    textblock: {
      group: 'block',
      content: 'inline*',
      marks: '_',
      attrs: blockAttrs,
      parseDOM: [
        { tag: '[data-vx-kind="textblock"]', getAttrs: (el: HTMLElement) => readData(el) },
        { tag: 'p', getAttrs: () => ({ tag: 'p', attrs: {} }) },
        { tag: 'h1, h2, h3, h4, h5, h6', getAttrs: () => ({ tag: 'p', attrs: {} }) },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => {
        const tag = String(node.attrs.tag);
        return [
          TEXTBLOCK_HTML[tag] ?? 'p',
          dataAttrs(node, {
            'data-vx-kind': 'textblock',
            class: `vx-tb vx-tb-${tag || 'implicit'}`,
          }),
          0,
        ];
      },
    },
    code: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      attrs: { tag: { default: 'codeblock' }, attrs: { default: {} as XmlAttrs } },
      parseDOM: [
        {
          tag: 'pre',
          preserveWhitespace: 'full',
          getAttrs: (el: HTMLElement) => readData(el) || { tag: 'codeblock', attrs: {} },
        },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => [
        'pre',
        dataAttrs(node, { class: `vx-code vx-code-${String(node.attrs.tag)}` }),
        ['code', 0],
      ],
    },
    list: {
      group: 'block',
      content: '(item | raw_block)+',
      attrs: { tag: { default: 'ul' }, attrs: { default: {} as XmlAttrs } },
      parseDOM: [
        { tag: '[data-vx-kind="list"]', getAttrs: (el: HTMLElement) => readData(el) },
        { tag: 'ul', getAttrs: () => ({ tag: 'ul', attrs: {} }) },
        { tag: 'ol', getAttrs: () => ({ tag: 'ol', attrs: {} }) },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => {
        const tag = String(node.attrs.tag);
        return [
          LIST_HTML[tag] ?? 'ul',
          dataAttrs(node, { 'data-vx-kind': 'list', class: `vx-list vx-list-${tag}` }),
          0,
        ];
      },
    },
    item: {
      content: 'block+',
      defining: true,
      attrs: { tag: { default: 'li' }, attrs: { default: {} as XmlAttrs } },
      parseDOM: [
        { tag: '[data-vx-kind="item"]', getAttrs: (el: HTMLElement) => readData(el) },
        { tag: 'li', getAttrs: () => ({ tag: 'li', attrs: {} }) },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => [
        'li',
        dataAttrs(node, {
          'data-vx-kind': 'item',
          class: `vx-item vx-item-${String(node.attrs.tag)}`,
        }),
        0,
      ],
    },
    container: {
      group: 'block',
      content: 'block+',
      defining: true,
      attrs: { tag: { default: 'section' }, attrs: { default: {} as XmlAttrs } },
      parseDOM: [
        { tag: '[data-vx-kind="container"]', getAttrs: (el: HTMLElement) => readData(el) },
        { tag: 'blockquote', getAttrs: () => ({ tag: 'lq', attrs: {} }) },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => {
        const tag = String(node.attrs.tag);
        const attrs = node.attrs.attrs as XmlAttrs;
        const extra: Record<string, string> = {
          'data-vx-kind': 'container',
          class: `vx-c vx-c-${tag}`,
        };
        if (tag === 'note') extra['data-note'] = attrs.type || 'note';
        return [CONTAINER_HTML[tag] ?? 'div', dataAttrs(node, extra), 0];
      },
    },
    raw_block: {
      group: 'block',
      atom: true,
      selectable: true,
      attrs: { xml: { default: '' }, label: { default: '' } },
      parseDOM: [
        {
          tag: 'div[data-vx-raw]',
          getAttrs: (el: HTMLElement) => ({
            xml: el.getAttribute('data-vx-raw') ?? '',
            label: el.getAttribute('data-vx-label') ?? '',
          }),
        },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => [
        'div',
        {
          'data-vx-raw': String(node.attrs.xml),
          'data-vx-label': String(node.attrs.label),
          class: 'vx-raw',
        },
        String(node.attrs.label),
      ],
    },
    raw_inline: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { xml: { default: '' }, label: { default: '' } },
      parseDOM: [
        {
          tag: 'span[data-vx-raw]',
          getAttrs: (el: HTMLElement) => ({
            xml: el.getAttribute('data-vx-raw') ?? '',
            label: el.getAttribute('data-vx-label') ?? '',
          }),
        },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => [
        'span',
        {
          'data-vx-raw': String(node.attrs.xml),
          'data-vx-label': String(node.attrs.label),
          class: 'vx-raw-inline',
        },
        String(node.attrs.label),
      ],
    },
    text: { group: 'inline' },
  },
  marks: Object.fromEntries(MARK_TAGS.map((tag) => [markName(tag), markSpec(tag)])),
});
