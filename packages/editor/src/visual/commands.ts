import { chainCommands, lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { Fragment, type Node as PMNode, type NodeType } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import {
  Plugin,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import { markName, schema, type MarkTag, type XmlAttrs } from './schema.js';

const n = schema.nodes;

/** The item element each list element holds. */
export const ITEM_FOR: Record<string, string> = {
  ul: 'li',
  ol: 'li',
  sl: 'sli',
  steps: 'step',
  'steps-unordered': 'step',
  substeps: 'substep',
  choices: 'choice',
};

export function markType(tag: MarkTag) {
  return schema.marks[markName(tag)]!;
}

export function markActive(state: EditorState, tag: MarkTag): boolean {
  const type = markType(tag);
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

export const toggleTag = (tag: MarkTag): Command => toggleMark(markType(tag), { tag, attrs: {} });

/** Whether the selection is inside the topic body (not the title or short description). */
export function inBody(state: EditorState): boolean {
  const $from = state.selection.$from;
  return $from.depth === 0 || $from.index(0) >= 2;
}

const bodyOnly =
  (cmd: Command): Command =>
  (state, dispatch, view) =>
    inBody(state) ? cmd(state, dispatch, view) : false;

export const makeList = (tag: string): Command =>
  bodyOnly((state, dispatch) => {
    // Already in a list: change its kind instead of nesting a new one.
    const list = findAncestor(state, (node) => node.type === n.list);
    if (list && dispatch) {
      if (String(list.node.attrs.tag) === tag) return liftListItem(n.item!)(state, dispatch);
      dispatch(
        state.tr.setNodeMarkup(list.pos, undefined, { ...list.node.attrs, tag }).scrollIntoView(),
      );
      return true;
    }
    if (list) return true;
    return wrapInList(n.list!, { tag, attrs: {} })(state, dispatch);
  });

export const paragraph: Command = bodyOnly(setBlockType(n.textblock!, { tag: 'p', attrs: {} }));
export const codeBlock: Command = bodyOnly((state, dispatch) => {
  const parent = state.selection.$from.parent;
  if (parent.type === n.code)
    return setBlockType(n.textblock!, { tag: 'p', attrs: {} })(state, dispatch);
  return setBlockType(n.code!, { tag: 'codeblock', attrs: {} })(state, dispatch);
});
export const note = (type: string): Command =>
  bodyOnly(wrapIn(n.container!, { tag: 'note', attrs: type === 'note' ? {} : { type } }));
export const unwrap: Command = bodyOnly(lift);

/** Adds a section with a heading after the top-level block holding the cursor. */
export const addSection: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  const index = $from.depth === 0 ? state.doc.childCount : Math.max(2, $from.index(0) + 1);
  let pos = 0;
  for (let i = 0; i < index; i++) pos += state.doc.child(i).nodeSize;
  if (dispatch) {
    const section = n.container!.create({ tag: 'section', attrs: {} }, [
      n.textblock!.create({ tag: 'title', attrs: {} }, schema.text('New section')),
      n.textblock!.create({ tag: 'p', attrs: {} }),
    ]);
    const tr = state.tr.insert(pos, section);
    tr.setSelection(TextSelection.create(tr.doc, pos + 2, pos + 2 + 'New section'.length));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Enter in the title or short description moves on instead of splitting. */
const enterInHeader: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  if ($from.depth !== 1 || $from.index(0) > 1) return false;
  if (!dispatch) return true;
  const next = $from.index(0) + 1;
  let pos = 0;
  for (let i = 0; i < next; i++) pos += state.doc.child(i).nodeSize;
  let tr = state.tr;
  if (next >= state.doc.childCount || !state.doc.child(next).isTextblock) {
    tr = tr.insert(pos, n.textblock!.create({ tag: 'p', attrs: {} }));
  }
  dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))).scrollIntoView());
  return true;
};

export const enter: Command = chainCommands(enterInHeader, splitListItem(n.item!));
export const indent: Command = sinkListItem(n.item!);
export const outdent: Command = liftListItem(n.item!);

/** The nearest ancestor of the selection matching `test`, with its position. */
export function findAncestor(
  state: EditorState,
  test: (node: PMNode) => boolean,
): { node: PMNode; pos: number; depth: number } | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (test(node)) return { node, pos: $from.before(d), depth: d };
  }
  return null;
}

/** Replaces a node's XML attributes, keeping its element name. */
export function setXmlAttrs(tr: Transaction, pos: number, attrs: XmlAttrs): Transaction {
  const node = tr.doc.nodeAt(pos);
  if (!node) return tr;
  return tr.setNodeMarkup(pos, undefined, { ...node.attrs, attrs });
}

/**
 * Keeps element names consistent after edits: items match their list (a `step`
 * moved into a `ul` becomes an `li`), a list nested in a step is `substeps`,
 * and a step's first text block is its `cmd`.
 */
export const normalize = new Plugin({
  appendTransaction(transactions, _old, state) {
    if (!transactions.some((t) => t.docChanged)) return null;
    let tr: Transaction | null = null;
    const fix = (pos: number, node: PMNode, attrs: Record<string, unknown>) => {
      tr ??= state.tr;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
    };
    state.doc.descendants((node, pos, parent) => {
      if (node.type === n.list && parent?.type === n.item) {
        const parentTag = String(parent.attrs.tag);
        if ((parentTag === 'step' || parentTag === 'substep') && node.attrs.tag !== 'substeps')
          fix(pos, node, { tag: 'substeps' });
      }
      if (node.type === n.item && parent?.type === n.list) {
        const want = ITEM_FOR[String(parent.attrs.tag)];
        if (want && node.attrs.tag !== want) fix(pos, node, { tag: want });
      }
      if (node.type === n.item && ['step', 'substep'].includes(String(node.attrs.tag))) {
        const first = node.firstChild;
        if (first?.type === n.textblock && first.attrs.tag !== 'cmd')
          fix(pos + 1, first, { tag: 'cmd' });
      }
      if (node.type === n.item && !['step', 'substep'].includes(String(node.attrs.tag))) {
        const first = node.firstChild;
        if (first?.type === n.textblock && first.attrs.tag === 'cmd')
          fix(pos + 1, first, { tag: 'p' });
      }
      return true;
    });
    return tr;
  },
});

/** A raw XML element, parsed back into editor nodes when the editor understands it. */
export function replaceRaw(tr: Transaction, pos: number, nodes: readonly PMNode[]): Transaction {
  const node = tr.doc.nodeAt(pos);
  if (!node) return tr;
  return tr.replaceWith(pos, pos + node.nodeSize, Fragment.from(nodes as PMNode[]));
}

export function nodeTypeName(type: NodeType): string {
  return type.name;
}
