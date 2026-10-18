import {
  SYNTHETIC,
  textContent,
  type CompiledTopic,
  type DocNode,
  type ElementNode,
} from '@opend/model';
import type { ReleaseView } from '@opend/filter';
import { DROPPED_ELEMENTS, METADATA_ELEMENTS, TOPIC_TYPES } from '@opend/dita';
import { NOTE_LABELS, SECTION_LABELS } from './elements.js';
import { conditionLabel, resolveImage, resolveLink, type RenderOptions } from './render.js';

/**
 * A topic as Markdown, for the API and AI assistants. It follows the HTML
 * renderer's rules: the same view (so the same filtering), links to topics the
 * reader cannot see become their authored text only, and with
 * `showConditions` (staff view) conditional content is labelled.
 */
export function renderMarkdown(
  view: ReleaseView,
  topic: CompiledTopic,
  options: RenderOptions = {},
): string {
  const ctx: Md = { view, options, depth: 0 };
  return `${blocks(topic.body, ctx).trim()}\n`;
}

interface Md {
  view: ReleaseView;
  options: RenderOptions;
  /** Heading depth: the topic title is 1. */
  depth: number;
}

const LIST_ORDERED = new Set(['ol', 'steps', 'substeps']);
const LIST_UNORDERED = new Set(['ul', 'sl', 'steps-unordered', 'choices']);
const CODE = new Set(['codeblock', 'pre', 'screen', 'msgblock']);
const MONO = new Set([
  'codeph',
  'tt',
  'filepath',
  'cmdname',
  'option',
  'parmname',
  'apiname',
  'synph',
  'userinput',
  'systemoutput',
  'msgph',
]);
const STRONG = new Set(['b', 'uicontrol', 'wintitle']);
const EMPHASIS = new Set(['i', 'term', 'cite', 'varname']);
/** Elements whose children are running text. */
const TEXT_BLOCKS = new Set(['p', 'shortdesc', 'cmd', 'dt', 'dthd', 'linktext', 'glossterm']);
const TABLES = new Set(['table', 'simpletable', 'properties']);
const ROWS = new Set(['row', 'strow', 'property', 'sthead', 'prophead']);
const CELLS = new Set([
  'entry',
  'stentry',
  'proptype',
  'propvalue',
  'propdesc',
  'proptypehd',
  'propvaluehd',
  'propdeschd',
]);

const isBlockElement = (n: DocNode): boolean =>
  n.type === 'element' &&
  (TEXT_BLOCKS.has(n.name) ||
    LIST_ORDERED.has(n.name) ||
    LIST_UNORDERED.has(n.name) ||
    CODE.has(n.name) ||
    TABLES.has(n.name) ||
    TOPIC_TYPES.has(n.name) ||
    [
      'section',
      'example',
      'note',
      'lq',
      'fig',
      'dl',
      'title',
      'info',
      'stepresult',
      'stepxmp',
      'prereq',
      'context',
      'result',
      'postreq',
      'div',
      'bodydiv',
      'sectiondiv',
      'lines',
      'related-links',
      'abstract',
      'condition',
      'cause',
      'remedy',
      'tasktroubleshooting',
      'troubleSolution',
      'steps-informal',
      'body',
      'conbody',
      'taskbody',
      'refbody',
      'troublebody',
      'glossBody',
      'glossdef',
      'refsyn',
      'linklist',
      'linkpool',
      'tutorialinfo',
    ].includes(n.name) ||
    (n.name === SYNTHETIC.cond && n.children.some(isBlockElement)));

/** Text with its whitespace kept, for code and line-preserving blocks. */
function rawText(node: DocNode): string {
  if (node.type === 'text') return node.value;
  if (DROPPED_ELEMENTS.has(node.name) || METADATA_ELEMENTS.has(node.name)) return '';
  return node.children.map(rawText).join('');
}

const escapeMd = (s: string) => s.replace(/([\\`*_[\]<>#|])/g, '\\$1');

/** Children as blocks: running text between block elements becomes a paragraph. */
function blocks(node: ElementNode, ctx: Md): string {
  let out = '';
  let pending: DocNode[] = [];
  const flush = () => {
    const text = inline(pending, ctx).trim();
    if (text) out += `${text}\n\n`;
    pending = [];
  };
  for (const child of node.children) {
    if (isBlockElement(child)) {
      flush();
      out += block(child as ElementNode, ctx);
    } else pending.push(child);
  }
  flush();
  return out;
}

function conditionNote(node: ElementNode, ctx: Md): string {
  if (!ctx.options.showConditions) return '';
  const label = conditionLabel(node.attrs);
  return label ? `*(Only for ${label})* ` : '';
}

function block(node: ElementNode, ctx: Md): string {
  const name = node.name;
  if (DROPPED_ELEMENTS.has(name) || METADATA_ELEMENTS.has(name)) return '';
  if (name === SYNTHETIC.cond) {
    const label = ctx.options.showConditions ? conditionLabel(node.attrs) : '';
    const inner = blocks(node, ctx);
    return label ? `*(Only for ${label}:)*\n\n${inner}` : inner;
  }
  const cond = conditionNote(node, ctx);
  if (TOPIC_TYPES.has(name)) return blocks(node, { ...ctx, depth: ctx.depth + 1 });
  if (name === 'title') {
    const level = Math.min(6, Math.max(1, ctx.depth));
    return `${'#'.repeat(level)} ${cond}${inline(node.children, ctx).trim()}\n\n`;
  }
  if (TEXT_BLOCKS.has(name)) {
    const text = inline(node.children, ctx).trim();
    if (!text) return '';
    return `${cond}${text}\n\n`;
  }
  if (LIST_ORDERED.has(name) || LIST_UNORDERED.has(name)) {
    const ordered = LIST_ORDERED.has(name);
    let i = 0;
    let out = cond ? `${cond}\n\n` : '';
    for (const item of node.children) {
      if (item.type !== 'element') continue;
      i++;
      const marker = ordered ? `${i}. ` : '- ';
      const body = blocks(item, ctx).trim() || inline(item.children, ctx).trim();
      const note = conditionNote(item, ctx);
      out += `${marker}${note}${indent(body, ' '.repeat(marker.length))}\n`;
    }
    return `${out}\n`;
  }
  if (CODE.has(name)) {
    const text = rawText(node).replace(/^\n+|\s+$/g, '');
    const fence = text.includes('```') ? '~~~' : '```';
    return `${cond}${fence}${node.attrs.outputclass?.replace(/^language-/, '') ?? ''}\n${text}\n${fence}\n\n`;
  }
  if (name === 'lines')
    return `${cond}${rawText(node)
      .trim()
      .split('\n')
      .map((l) => escapeMd(l.trim()))
      .join('  \n')}\n\n`;
  if (name === 'note') {
    const type =
      node.attrs.type === 'other' ? (node.attrs.othertype ?? 'note') : (node.attrs.type ?? 'note');
    const label = NOTE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
    return quote(`**${label}:** ${cond}${blocks(node, ctx).trim()}`);
  }
  if (name === 'lq') return quote(`${cond}${blocks(node, ctx).trim()}`);
  if (name === 'dl') {
    let out = cond ? `${cond}\n\n` : '';
    for (const entry of node.children) {
      if (entry.type !== 'element' || entry.name !== 'dlentry') continue;
      const terms = entry.children
        .filter((c): c is ElementNode => c.type === 'element' && c.name === 'dt')
        .map((t) => inline(t.children, ctx).trim());
      const defs = entry.children
        .filter((c): c is ElementNode => c.type === 'element' && c.name === 'dd')
        .map((d) => blocks(d, ctx).trim());
      out += `- **${terms.join(', ')}**: ${indent(defs.join('\n\n'), '  ')}\n`;
    }
    return `${out}\n`;
  }
  if (TABLES.has(name)) return table(node, ctx, cond);
  if (name === 'related-links') {
    const links = linksIn(node, ctx);
    return links.length
      ? `${'#'.repeat(Math.min(6, ctx.depth + 1))} Related\n\n${links.map((l) => `- ${l}`).join('\n')}\n\n`
      : '';
  }
  if (name === 'fig') return `${cond}${blocks(node, { ...ctx, depth: ctx.depth + 1 })}`;
  const label = SECTION_LABELS[name];
  const hasTitle = node.children.some((c) => c.type === 'element' && c.name === 'title');
  const heading =
    label && !hasTitle ? `${'#'.repeat(Math.min(6, ctx.depth + 1))} ${label}\n\n` : '';
  return `${heading}${cond ? `${cond}\n\n` : ''}${blocks(node, { ...ctx, depth: ctx.depth + 1 })}`;
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join('\n');
}

function quote(text: string): string {
  return `${text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n')}\n\n`;
}

function linksIn(node: ElementNode, ctx: Md): string[] {
  const out: string[] = [];
  const walk = (n: ElementNode) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      if (c.name === 'link') {
        const target = resolveLink(ctx.view, c, ctx.options);
        if (!target) continue;
        const linktext = c.children.find(
          (x): x is ElementNode => x.type === 'element' && x.name === 'linktext',
        );
        const text = linktext
          ? inline(linktext.children, ctx).trim()
          : escapeMd(target.defaultText);
        out.push(`[${text}](${target.href})`);
      } else walk(c);
    }
  };
  walk(node);
  return out;
}

function table(node: ElementNode, ctx: Md, cond: string): string {
  const rows: { header: boolean; cells: string[] }[] = [];
  const walk = (n: ElementNode, inHead: boolean) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      if (c.name === 'title') continue;
      if (ROWS.has(c.name)) {
        const header = inHead || c.name === 'sthead' || c.name === 'prophead';
        rows.push({
          header,
          cells: c.children
            .filter((x): x is ElementNode => x.type === 'element' && CELLS.has(x.name))
            .map((cell) =>
              (blocks(cell, ctx).trim() || inline(cell.children, ctx).trim())
                .replace(/\n+/g, ' ')
                .replace(/\|/g, '\\|'),
            ),
        });
      } else walk(c, inHead || c.name === 'thead');
    }
  };
  walk(node, false);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.cells.length));
  const pad = (cells: string[]) => [...cells, ...Array(width - cells.length).fill('')];
  const headIndex = rows.findIndex((r) => r.header);
  const head = headIndex === -1 ? pad([]) : pad(rows[headIndex]!.cells);
  const body = rows.filter((_, i) => i !== headIndex);
  const title = node.children.find(
    (c): c is ElementNode => c.type === 'element' && c.name === 'title',
  );
  const caption = title ? `*${inline(title.children, ctx).trim()}*\n\n` : '';
  const line = (cells: string[]) => `| ${pad(cells).join(' | ')} |`;
  return `${cond ? `${cond}\n\n` : ''}${caption}${line(head)}\n|${' --- |'.repeat(width)}\n${body
    .map((r) => line(r.cells))
    .join('\n')}\n\n`;
}

/** Running text as Markdown, whitespace collapsed. */
function inline(nodes: readonly DocNode[], ctx: Md): string {
  return nodes
    .map((n) => inlineNode(n, ctx))
    .join('')
    .replace(/[ \t\r\n]+/g, ' ');
}

function inlineNode(node: DocNode, ctx: Md): string {
  if (node.type === 'text') return escapeMd(node.value);
  const name = node.name;
  if (DROPPED_ELEMENTS.has(name) || METADATA_ELEMENTS.has(name)) return '';
  if (name === SYNTHETIC.choice) {
    if (!ctx.options.showConditions) return inline(node.children, ctx);
    return node.children.map((c) => inlineNode(c, ctx)).join(' | ');
  }
  if (name === SYNTHETIC.cond) {
    const label = ctx.options.showConditions ? conditionLabel(node.attrs) : '';
    const inner = inline(node.children, ctx);
    return label ? `${inner} *(only for ${label})*` : inner;
  }
  if (isBlockElement(node)) return ` ${block(node, ctx).trim()} `;
  const inner = () => inline(node.children, ctx);
  if (MONO.has(name)) {
    const text = textContent(node).replace(/\s+/g, ' ');
    const ticks = text.includes('`') ? '``' : '`';
    return text.trim() ? `${ticks}${text}${ticks}` : '';
  }
  if (STRONG.has(name)) return wrap('**', inner());
  if (EMPHASIS.has(name)) return wrap('*', inner());
  if (name === 'q') return `“${inner()}”`;
  if (name === 'tm') {
    const mark = node.attrs.tmtype === 'reg' ? '®' : node.attrs.tmtype === 'service' ? '℠' : '™';
    return inner() + mark;
  }
  if (name === 'fn') return ` (${inner().trim()})`;
  if (name === 'menucascade')
    return node.children
      .filter((c) => c.type === 'element')
      .map((c) => inlineNode(c, ctx))
      .join(' > ');
  if (name === 'image') {
    const { src, alt } = resolveImage(ctx.view, node, ctx.options);
    return src ? `![${escapeMd(alt)}](${src})` : escapeMd(alt);
  }
  if (name === 'xref') {
    const authored = inline(
      node.children.filter((c) => !(c.type === 'element' && c.name === 'desc')),
      ctx,
    ).trim();
    const target = resolveLink(ctx.view, node, ctx.options);
    // Hidden or unresolved target: keep only the authored text, never the target's title.
    if (!target) return authored;
    return `[${authored || escapeMd(target.defaultText)}](${target.href})`;
  }
  return inner();
}

function wrap(mark: string, text: string): string {
  const t = text.trim();
  if (!t) return text;
  const lead = text.startsWith(' ') ? ' ' : '';
  const trail = text.endsWith(' ') ? ' ' : '';
  return `${lead}${mark}${t}${mark}${trail}`;
}
