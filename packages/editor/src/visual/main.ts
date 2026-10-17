import { baseKeymap, chainCommands, exitCode } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, NodeSelection, Plugin, TextSelection, type Command } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import {
  addSection,
  codeBlock,
  enter,
  findAncestor,
  indent,
  inBody,
  makeList,
  markActive,
  markType,
  normalize,
  note,
  outdent,
  paragraph,
  replaceRaw,
  setXmlAttrs,
  toggleTag,
  unwrap,
} from './commands.js';
import { blocksOf, escapeAttr, inlineContent } from './convert.js';
import { CONDITION_ATTRS, CONDITION_HINTS, schema, type MarkTag, type XmlAttrs } from './schema.js';
import { VisualTopic } from './topic.js';

/**
 * The visual editor, served as `/assets/visual.js` on the editor page. It
 * edits the topic on the page and writes DITA into the form's source
 * textarea, which the page script previews and saves as before. Without
 * JavaScript, or for files it cannot edit safely, the textarea is the editor.
 */

const NAMES: Record<string, string> = {
  p: 'Paragraph',
  '': 'Text',
  title: 'Heading',
  cmd: 'Step instruction',
  dt: 'Term',
  section: 'Section',
  example: 'Example',
  note: 'Note',
  lq: 'Quote',
  fig: 'Figure',
  ul: 'Bulleted list',
  ol: 'Numbered list',
  sl: 'Simple list',
  steps: 'Steps',
  'steps-unordered': 'Steps (any order)',
  substeps: 'Sub-steps',
  choices: 'Choices',
  li: 'List item',
  sli: 'List item',
  step: 'Step',
  substep: 'Sub-step',
  choice: 'Choice',
  info: 'Step details',
  stepresult: 'Step result',
  stepxmp: 'Step example',
  prereq: 'Before you begin',
  context: 'Context',
  result: 'Result',
  postreq: 'What to do next',
  codeblock: 'Code block',
  pre: 'Preformatted text',
  lines: 'Lines',
  dl: 'Definition list',
  dlentry: 'Definition',
  dd: 'Description',
};

const MAIN_CONDITIONS = new Set(['release', 'product', 'feature', 'audience']);

const NOTE_TYPES = [
  'note',
  'tip',
  'important',
  'remember',
  'restriction',
  'attention',
  'caution',
  'danger',
  'warning',
  'notice',
  'fastpath',
] as const;

/** Formatting offered in the toolbar's "More" menu, beyond bold, italic and code. */
const MORE_MARKS: [MarkTag, string][] = [
  ['uicontrol', 'Interface label'],
  ['filepath', 'File path'],
  ['userinput', 'Typed input'],
  ['systemoutput', 'System output'],
  ['varname', 'Variable'],
  ['cmdname', 'Command name'],
  ['term', 'Term'],
  ['keyword', 'Keyword'],
  ['wintitle', 'Window title'],
  ['u', 'Underline'],
  ['sup', 'Superscript'],
  ['sub', 'Subscript'],
  ['q', 'Quotation'],
  ['cite', 'Citation'],
];

function nameOf(node: PMNode): string {
  if (node.type.name === 'raw_block' || node.type.name === 'raw_inline')
    return String(node.attrs.label);
  const tag = String(node.attrs.tag ?? '');
  return NAMES[tag] ?? `<${tag}>`;
}

export function installVisualEditor(win: Window): void {
  const doc = win.document;
  const form = doc.getElementById('ed-form') as HTMLFormElement | null;
  const source = doc.getElementById('ed-source') as HTMLTextAreaElement | null;
  const sourcePane = doc.getElementById('ed-source-pane');
  const visualPane = doc.getElementById('ed-visual-pane');
  if (!form || !source || !sourcePane || !visualPane) return;
  if (!(form.dataset.path ?? '').endsWith('.dita')) return;

  const parser = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<Record<string, string>> = {},
    ...kids: (Node | string)[]
  ): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (v !== undefined) e.setAttribute(k, v);
    e.append(...kids);
    return e;
  };

  // ---- tabs ------------------------------------------------------------------
  const tabVisual = el('button', { type: 'button', role: 'tab', id: 'vx-tab-visual' }, 'Visual');
  const tabSource = el('button', { type: 'button', role: 'tab', id: 'vx-tab-source' }, 'Source');
  const tabs = el(
    'div',
    { class: 'vx-tabs', role: 'tablist', 'aria-label': 'Editing mode' },
    tabVisual,
    tabSource,
  );
  const notice = el('p', { class: 'vx-notice', role: 'status', hidden: '' });
  visualPane.setAttribute('role', 'tabpanel');
  visualPane.setAttribute('aria-labelledby', 'vx-tab-visual');
  sourcePane.setAttribute('role', 'tabpanel');
  sourcePane.setAttribute('aria-labelledby', 'vx-tab-source');
  visualPane.before(tabs, notice);

  let topic: VisualTopic | null = null;
  let view: EditorView | null = null;
  let written = source.value;
  let timer: number | undefined;

  const select = (visual: boolean) => {
    tabVisual.setAttribute('aria-selected', String(visual));
    tabSource.setAttribute('aria-selected', String(!visual));
    tabVisual.tabIndex = visual ? 0 : -1;
    tabSource.tabIndex = visual ? -1 : 0;
    visualPane.hidden = !visual;
    sourcePane.hidden = visual;
  };

  const flush = () => {
    win.clearTimeout(timer);
    timer = undefined;
    // Edits made in the Source tab win until the visual editor reopens them.
    if (!topic || !view || source.value !== written) return;
    const text = topic.toSource(view.state.doc);
    if (text === source.value) return;
    source.value = text;
    written = text;
    source.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const open = (): boolean => {
    const result = VisualTopic.load(source.value, parser);
    if (!result.ok) {
      notice.textContent = `${result.reason} The visual editor is off for this file.`;
      notice.hidden = false;
      tabVisual.disabled = true;
      return false;
    }
    notice.hidden = true;
    tabVisual.disabled = false;
    topic = result.topic;
    written = source.value;
    const state = createState(topic.doc);
    if (view) view.updateState(state);
    else mount(state);
    return true;
  };

  tabVisual.addEventListener('click', () => {
    if (source.value !== written || !view) {
      if (!open()) return;
    }
    select(true);
    view?.focus();
  });
  tabSource.addEventListener('click', () => {
    flush();
    select(false);
  });
  tabs.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target === tabVisual ? tabSource : tabVisual;
    if (!target.disabled) {
      target.focus();
      target.click();
    }
  });
  // Submitting the form saves what the visual editor holds.
  form.addEventListener('submit', flush, true);
  win.addEventListener('pagehide', flush);

  // ---- toolbar ------------------------------------------------------------------
  const toolbar = el('div', { class: 'vx-toolbar', role: 'toolbar', 'aria-label': 'Formatting' });
  const props = el('aside', { class: 'vx-props', 'aria-label': 'Block settings', hidden: '' });
  const surface = el('div', { class: 'vx-surface' });
  visualPane.append(toolbar, surface, props);

  interface Tool {
    button: HTMLButtonElement;
    cmd: Command;
    active?: (state: EditorState) => boolean;
  }
  const tools: Tool[] = [];
  const tool = (
    label: string,
    title: string,
    cmd: Command,
    active?: (state: EditorState) => boolean,
    cls = '',
  ) => {
    const button = el(
      'button',
      { type: 'button', title, 'aria-label': title, class: `vx-tool ${cls}`.trim() },
      label,
    );
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      if (!view) return;
      cmd(view.state, view.dispatch, view);
      view.focus();
    });
    tools.push({ button, cmd, ...(active ? { active } : {}) });
    return button;
  };
  const group = (...kids: HTMLElement[]) => el('div', { class: 'vx-group' }, ...kids);
  const listActive = (tag: string) => (state: EditorState) =>
    String(findAncestor(state, (node) => node.type === schema.nodes.list)?.node.attrs.tag ?? '') ===
    tag;

  const more = el('select', { class: 'vx-more', 'aria-label': 'More formatting' });
  more.append(el('option', { value: '' }, 'More…'));
  for (const [tag, label] of MORE_MARKS) more.append(el('option', { value: tag }, label));
  more.addEventListener('change', () => {
    const tag = more.value as MarkTag;
    more.value = '';
    if (view && tag) {
      toggleTag(tag)(view.state, view.dispatch, view);
      view.focus();
    }
  });

  const noteMenu = el('select', { class: 'vx-more', 'aria-label': 'Add a note' });
  noteMenu.append(el('option', { value: '' }, 'Note…'));
  for (const t of NOTE_TYPES)
    noteMenu.append(el('option', { value: t }, t[0]!.toUpperCase() + t.slice(1)));
  noteMenu.addEventListener('change', () => {
    const t = noteMenu.value;
    noteMenu.value = '';
    if (view && t) {
      note(t)(view.state, view.dispatch, view);
      view.focus();
    }
  });

  const isTask = () => view?.state.doc.attrs.tag === 'taskbody';
  const stepsButton = tool('Steps', 'Numbered steps', makeList('steps'), listActive('steps'));
  toolbar.append(
    group(
      tool('B', 'Bold (Ctrl+B)', toggleTag('b'), (s) => markActive(s, 'b'), 'vx-b'),
      tool('I', 'Italic (Ctrl+I)', toggleTag('i'), (s) => markActive(s, 'i'), 'vx-i'),
      tool('</>', 'Code (Ctrl+E)', toggleTag('codeph'), (s) => markActive(s, 'codeph'), 'vx-mono'),
      tool('Link', 'Link (Ctrl+K)', linkCommand, (s) => markActive(s, 'xref')),
      more,
    ),
    group(
      tool('¶', 'Paragraph', paragraph),
      tool('•', 'Bulleted list', makeList('ul'), listActive('ul')),
      tool('1.', 'Numbered list', makeList('ol'), listActive('ol')),
      stepsButton,
      tool('⇥', 'Indent list item (Tab)', indent),
      tool('⇤', 'Outdent list item (Shift+Tab)', outdent),
    ),
    group(
      tool('+ Section', 'Add a section with a heading', addSection),
      noteMenu,
      tool(
        '{ }',
        'Code block',
        codeBlock,
        (s) => s.selection.$from.parent.type === schema.nodes.code,
        'vx-mono',
      ),
      tool('Image', 'Insert an image', (s, dispatch) => {
        if (!inBody(s)) return false;
        if (dispatch) openImage();
        return true;
      }),
      tool('Unwrap', 'Take the selection out of its note, list or section', unwrap),
    ),
    group(
      tool('↶', 'Undo (Ctrl+Z)', undo),
      tool('↷', 'Redo (Ctrl+Shift+Z)', redo),
      settingsButton(),
    ),
  );

  function settingsButton(): HTMLButtonElement {
    const b = el(
      'button',
      { type: 'button', class: 'vx-tool', 'aria-expanded': 'false', 'aria-controls': 'vx-props' },
      'Block settings',
    );
    props.id = 'vx-props';
    b.addEventListener('click', () => {
      props.hidden = !props.hidden;
      b.setAttribute('aria-expanded', String(!props.hidden));
      renderProps();
    });
    return b;
  }

  const refreshTools = () => {
    if (!view) return;
    const state = view.state;
    for (const t of tools) {
      const enabled = t.cmd(state, undefined, view);
      t.button.disabled = !enabled;
      if (t.active) t.button.setAttribute('aria-pressed', String(t.active(state)));
    }
    stepsButton.hidden = !isTask();
    const body = inBody(state);
    noteMenu.disabled = !body;
    more.disabled = false;
  };

  // ---- dialogs ------------------------------------------------------------------
  /** Opens the link dialog for selected text or an existing link. Commands only act with `dispatch`. */
  function linkCommand(...[state, dispatch]: Parameters<Command>): boolean {
    if (state.selection.empty && !markActive(state, 'xref')) return false;
    if (!state.selection.$from.parent.inlineContent) return false;
    if (dispatch) openLink();
    return true;
  }

  function dialog(
    title: string,
    fields: HTMLElement[],
    actions: [string, string][],
  ): HTMLDialogElement {
    const d = el('dialog', { class: 'vx-dialog', 'aria-labelledby': 'vx-dialog-title' });
    const f = el('form', { method: 'dialog' });
    f.append(el('h2', { id: 'vx-dialog-title' }, title), ...fields);
    const row = el('p', { class: 'vx-dialog-actions' });
    for (const [value, label] of actions)
      row.append(
        el(
          'button',
          { value, type: 'submit', class: value === 'cancel' ? 'vx-secondary' : '' },
          label,
        ),
      );
    f.append(row);
    d.append(f);
    doc.body.append(d);
    d.addEventListener('close', () => d.remove());
    return d;
  }

  function field(id: string, label: string, value = '', type = 'text') {
    const input = el('input', { id, type, value, autocomplete: 'off' });
    return { input, row: el('p', {}, el('label', { for: id }, label), input) };
  }

  function openLink() {
    if (!view) return;
    const state = view.state;
    const type = markType('xref');
    const $from = state.selection.$from;
    const existing = type.isInSet(
      state.selection.empty ? $from.marks() : (state.doc.nodeAt(state.selection.from)?.marks ?? []),
    );
    const attrs = (existing?.attrs.attrs ?? {}) as XmlAttrs;
    const href = field(
      'vx-href',
      'Link to (topic path, #id, or https:// address)',
      attrs.href ?? '',
    );
    const external = el('input', { id: 'vx-external', type: 'checkbox' });
    external.checked = attrs.scope === 'external';
    const ext = el(
      'p',
      { class: 'vx-check' },
      external,
      el('label', { for: 'vx-external', class: 'vx-inline' }, 'Opens another website'),
    );
    const actions: [string, string][] = [['apply', 'Apply']];
    if (existing) actions.push(['remove', 'Remove link']);
    actions.push(['cancel', 'Cancel']);
    const d = dialog(existing ? 'Edit link' : 'Add link', [href.row, ext], actions);
    href.input.addEventListener('input', () => {
      if (/^https?:/i.test(href.input.value)) external.checked = true;
    });
    // Extend an existing link's range so editing changes the whole link.
    let { from, to } = state.selection;
    if (existing && state.selection.empty) {
      const parent = $from.parent;
      const start = $from.start();
      let pos = start;
      parent.forEach((child) => {
        const end = pos + child.nodeSize;
        if (existing.isInSet(child.marks) && pos <= $from.pos && end >= $from.pos) {
          from = pos;
          to = end;
        }
        pos = end;
      });
    }
    d.addEventListener('close', () => {
      if (!view) return;
      let tr = view.state.tr.removeMark(from, to, type);
      if (d.returnValue === 'apply' && href.input.value.trim()) {
        const next: XmlAttrs = { ...attrs, href: href.input.value.trim() };
        if (external.checked)
          Object.assign(next, { scope: 'external', format: attrs.format ?? 'html' });
        else {
          delete next.scope;
          if (next.format === 'html') delete next.format;
        }
        tr = tr.addMark(from, to, type.create({ tag: 'xref', attrs: next }));
      } else if (d.returnValue !== 'remove') {
        view.focus();
        return;
      }
      view.dispatch(tr);
      view.focus();
    });
    d.showModal();
  }

  function openImage() {
    const href = field(
      'vx-img-href',
      'Image file (path in the repository, e.g. images/screen.png)',
    );
    const alt = field('vx-img-alt', 'Description for screen readers');
    const d = dialog(
      'Insert image',
      [href.row, alt.row],
      [
        ['apply', 'Insert'],
        ['cancel', 'Cancel'],
      ],
    );
    d.addEventListener('close', () => {
      if (!view || d.returnValue !== 'apply' || !href.input.value.trim()) return view?.focus();
      const xml = `<image href="${escapeAttr(href.input.value.trim())}" placement="break"><alt>${escapeHtml(alt.input.value.trim())}</alt></image>`;
      const node = schema.nodes.raw_inline!.create({
        xml,
        label: `Image: ${alt.input.value.trim() || href.input.value.trim()}`,
      });
      const { state } = view;
      if (state.selection.$from.parent.inlineContent)
        view.dispatch(state.tr.replaceSelectionWith(node));
      else
        view.dispatch(
          state.tr.replaceSelectionWith(
            schema.nodes.textblock!.create({ tag: '', attrs: {} }, node),
          ),
        );
      view.focus();
    });
    d.showModal();
  }

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ---- block settings ----------------------------------------------------------
  let target: number | null = null;

  function renderProps() {
    if (props.hidden || !view) return;
    const state = view.state;
    props.textContent = '';
    props.append(el('h2', {}, 'Block settings'));
    // The blocks around the cursor, outermost first; pick which one to change.
    const chain: { node: PMNode; pos: number }[] = [];
    const sel = state.selection;
    if (sel instanceof NodeSelection && sel.node.type === schema.nodes.raw_inline) {
      props.append(el('p', {}, el('strong', {}, String(sel.node.attrs.label))));
      props.append(rawEditor(sel.from, sel.node));
      return;
    }
    if (sel instanceof NodeSelection && sel.node.isBlock)
      chain.push({ node: sel.node, pos: sel.from });
    const $from = sel.$from;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type === schema.nodes.topictitle || node.type === schema.nodes.shortdesc) break;
      chain.push({ node, pos: $from.before(d) });
    }
    chain.reverse();
    if (!chain.length) {
      props.append(
        el(
          'p',
          { class: 'vx-muted' },
          'Put the cursor in a block of the topic body to change its settings.',
        ),
      );
      return;
    }
    if (target === null || !chain.some((c) => c.pos === target)) target = chain.at(-1)!.pos;
    const crumbs = el('nav', { class: 'vx-crumbs', 'aria-label': 'Blocks around the cursor' });
    for (const c of chain) {
      const b = el(
        'button',
        { type: 'button', class: 'vx-crumb', 'aria-current': c.pos === target ? 'true' : 'false' },
        nameOf(c.node),
      );
      b.addEventListener('click', () => {
        target = c.pos;
        renderProps();
      });
      crumbs.append(b);
    }
    props.append(crumbs);
    const current = chain.find((c) => c.pos === target)!;
    const node = current.node;
    if (node.type === schema.nodes.raw_block) {
      props.append(rawEditor(current.pos, node));
      return;
    }
    const attrs = { ...(node.attrs.attrs as XmlAttrs) };
    const apply = (next: XmlAttrs) => {
      if (!view) return;
      view.dispatch(setXmlAttrs(view.state.tr, current.pos, next));
    };
    if (node.attrs.tag === 'note') {
      const sel2 = el('select', { id: 'vx-note-type' });
      for (const t of NOTE_TYPES) {
        const o = el('option', { value: t }, t[0]!.toUpperCase() + t.slice(1));
        if ((attrs.type || 'note') === t) o.selected = true;
        sel2.append(o);
      }
      sel2.addEventListener('change', () => {
        const next = { ...attrs };
        if (sel2.value === 'note') delete next.type;
        else next.type = sel2.value;
        apply(next);
      });
      props.append(el('p', {}, el('label', { for: 'vx-note-type' }, 'Note type'), sel2));
    }
    if (!String(node.attrs.tag ?? '')) {
      props.append(
        el(
          'p',
          { class: 'vx-muted' },
          'Plain text inside its parent block. Choose the parent above to change who sees it.',
        ),
      );
      return;
    }
    const fs = el('fieldset', { class: 'vx-conds' });
    fs.append(
      el('legend', {}, 'Who sees this'),
      el(
        'p',
        { class: 'vx-muted' },
        'Leave empty to show to everyone. Separate several values with spaces.',
      ),
    );
    // The conditions most sites use first; the rest, unless set, behind "More conditions".
    const main = el('div', { class: 'vx-cond-grid' });
    const extra = el('div', { class: 'vx-cond-grid' });
    for (const a of CONDITION_ATTRS) {
      const f = field(`vx-cond-${a}`, `${a}: ${CONDITION_HINTS[a]}`, attrs[a] ?? '');
      f.input.addEventListener('change', () => {
        const next = { ...(view!.state.doc.nodeAt(current.pos)?.attrs.attrs as XmlAttrs) };
        const v = f.input.value.trim();
        if (v) next[a] = v;
        else delete next[a];
        apply(next);
      });
      (MAIN_CONDITIONS.has(a) || attrs[a] ? main : extra).append(f.row);
    }
    fs.append(main);
    if (extra.childElementCount)
      fs.append(el('details', {}, el('summary', {}, 'More conditions'), extra));
    props.append(fs);
    if (attrs.id) props.append(el('p', { class: 'vx-muted' }, `Element id: ${attrs.id}`));
  }

  function rawEditor(pos: number, node: PMNode): HTMLElement {
    const box = el('div');
    const id = 'vx-raw-xml';
    const area = el('textarea', { id, rows: '10', spellcheck: 'false' });
    area.value = String(node.attrs.xml);
    const err = el('p', { class: 'vx-error', role: 'alert', hidden: '' });
    const save = el('button', { type: 'button' }, 'Apply XML');
    save.addEventListener('click', () => {
      const parsed = parser(`<wrap>${area.value}</wrap>`);
      if (parsed.getElementsByTagName('parsererror').length) {
        err.textContent = 'That is not well-formed XML.';
        err.hidden = false;
        return;
      }
      if (!view) return;
      const kids: Node[] = [];
      for (let k = parsed.documentElement.firstChild; k; k = k.nextSibling) kids.push(k);
      const nodes =
        node.type === schema.nodes.raw_inline
          ? inlineContent(kids)
          : blocksOf(
              parsed.documentElement,
              view.state.doc.resolve(pos).parent.attrs.tag as string,
            );
      view.dispatch(replaceRaw(view.state.tr, pos, nodes));
      view.focus();
    });
    box.append(
      el(
        'p',
        { class: 'vx-muted' },
        'The visual editor shows this as a block it cannot edit directly. Change its XML here.',
      ),
      el('label', { for: id }, 'XML'),
      area,
      err,
      el('p', {}, save),
    );
    return box;
  }

  // ---- inline chips: images and key references -----------------------------------
  let keyText: Record<string, string> = {};
  try {
    keyText = JSON.parse(visualPane.dataset.keys ?? '{}') as Record<string, string>;
  } catch {
    // No key texts: key references show their key names.
  }
  let topicTitle: Record<string, string> = {};
  try {
    topicTitle = JSON.parse(visualPane.dataset.titles ?? '{}') as Record<string, string>;
  } catch {
    // No titles: links without text show their target.
  }
  const assetBase = visualPane.dataset.assets ?? '';
  const topicDir = (form.dataset.path ?? '').split('/').slice(0, -1);

  /** A docs-relative path for an `href` relative to this topic, or null when it leaves the docs. */
  const resolveHref = (href: string): string | null => {
    if (/^[a-z]+:|^\/|^#/i.test(href)) return null;
    const parts = [...topicDir];
    for (const seg of href.split('#')[0]!.split('/')) {
      if (seg === '..') {
        if (!parts.length) return null;
        parts.pop();
      } else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  };

  /** How a raw inline node shows: the image itself, a key's text, or a labelled chip. */
  function rawInlineView(node: PMNode) {
    const dom = el('span', { class: 'vx-raw-inline', title: String(node.attrs.label) });
    dom.textContent = String(node.attrs.label);
    const parsed = parser(`<w>${String(node.attrs.xml)}</w>`).documentElement.firstElementChild;
    if (!parsed) return { dom };
    const keyref = parsed.getAttribute('keyref');
    const textless = !(parsed.textContent ?? '').trim();
    if (parsed.nodeName === 'image') {
      const href = parsed.getAttribute('href');
      const path = href ? resolveHref(href) : null;
      if (path && assetBase) {
        const alt =
          parsed.getElementsByTagName('alt')[0]?.textContent?.trim() ||
          parsed.getAttribute('alt') ||
          '';
        const img = el('img', {
          src: `${assetBase}${path.split('/').map(encodeURIComponent).join('/')}`,
          alt,
        });
        img.addEventListener('error', () => {
          img.replaceWith(String(node.attrs.label));
          dom.className = 'vx-raw-inline';
        });
        dom.textContent = '';
        dom.className = `vx-image${parsed.getAttribute('placement') === 'break' ? ' vx-image-break' : ''}`;
        dom.title = alt || path;
        dom.append(img);
      }
    } else if (parsed.nodeName === 'xref' && textless && !keyref) {
      const href = parsed.getAttribute('href') ?? '';
      const path = resolveHref(href);
      const title = path ? topicTitle[path] : undefined;
      if (title || /^https?:/i.test(href)) {
        dom.className = 'vx-link';
        dom.textContent = title ?? href;
        dom.title = `Link to ${href} (text from the target)`;
      }
    } else if (keyref && textless && keyText[keyref]) {
      dom.className = 'vx-key';
      dom.textContent = keyText[keyref]!;
      dom.title = `Key: ${keyref} (defined in the map)`;
    }
    return { dom };
  }

  // ---- editor ------------------------------------------------------------------
  const placeholders = new Plugin({
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        const hint = (node: PMNode, pos: number, text: string) => {
          if (node.content.size === 0)
            decos.push(
              Decoration.node(pos, pos + node.nodeSize, {
                'data-placeholder': text,
                class: 'vx-empty',
              }),
            );
        };
        hint(state.doc.child(0), 0, 'Title');
        hint(
          state.doc.child(1),
          state.doc.child(0).nodeSize,
          'Short description: one or two sentences shown in search results and link previews',
        );
        if (state.doc.childCount === 3 && state.doc.child(2).isTextblock) {
          const last = state.doc.child(2);
          hint(last, state.doc.content.size - last.nodeSize, 'Start writing…');
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
  });

  function createState(loaded: PMNode): EditorState {
    // A topic with an empty body gets a place to start typing (not saved while empty).
    const docNode =
      loaded.childCount > 2
        ? loaded
        : loaded.copy(
            loaded.content.addToEnd(schema.nodes.textblock!.create({ tag: '', attrs: {} })),
          );
    return EditorState.create({
      doc: docNode,
      plugins: [
        history(),
        keymap({
          'Mod-b': toggleTag('b'),
          'Mod-i': toggleTag('i'),
          'Mod-e': toggleTag('codeph'),
          'Mod-k': linkCommand,
          'Mod-z': undo,
          'Shift-Mod-z': redo,
          'Mod-y': redo,
          Enter: enter,
          'Shift-Enter': chainCommands(exitCode),
          Tab: indent,
          'Shift-Tab': outdent,
        }),
        keymap(baseKeymap),
        dropCursor(),
        gapCursor(),
        normalize,
        placeholders,
      ],
    });
  }

  function mount(state: EditorState) {
    view = new EditorView(surface, {
      state,
      attributes: {
        class: 'vx-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Topic content',
        spellcheck: 'true',
      },
      dispatchTransaction(tr) {
        if (!view) return;
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) {
          win.clearTimeout(timer);
          timer = win.setTimeout(flush, 300);
        }
        refreshTools();
        renderProps();
      },
      nodeViews: { raw_inline: (node) => rawInlineView(node) },
      handleDoubleClickOn(_view, _pos, node, nodePos) {
        if (node.type !== schema.nodes.raw_block && node.type !== schema.nodes.raw_inline)
          return false;
        target = nodePos;
        props.hidden = false;
        renderProps();
        return true;
      },
    });
    refreshTools();
  }

  if (open()) {
    select(true);
    // Put the cursor at the end of the title only when the topic is new and empty.
    if (view && !(view as EditorView).state.doc.child(0).content.size) {
      const v = view as EditorView;
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
    }
  } else select(false);
}
