/** Where a node came from in the source tree. Paths are relative to the docs root, using `/`. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface ElementNode {
  type: 'element';
  name: string;
  attrs: Record<string, string>;
  children: DocNode[];
  loc?: SourceLocation;
}

export interface TextNode {
  type: 'text';
  value: string;
}

export type DocNode = ElementNode | TextNode;

/**
 * Synthetic elements the build inserts into the tree. They carry no meaning for
 * DITA authors and never appear in source files.
 */
export const SYNTHETIC = {
  /**
   * Wraps content with extra filter attributes, such as the attributes of a
   * `conref` source element or the conditions of a conditional key definition.
   * Rendered transparently.
   */
  cond: 'opend-cond',
  /**
   * Holds alternatives (`opend-cond` children). After filtering only the first
   * surviving alternative is kept, which implements DITA's "first effective key
   * definition wins" rule per reader.
   */
  choice: 'opend-choice',
} as const;

/** Attribute the build sets on `xref` and `link` when the target resolves to a topic. */
export const TARGET_ATTR = 'opend-target';
/** Attribute the build sets on `image` with the resolved docs-root-relative path. */
export const ASSET_ATTR = 'opend-asset';

export function element(
  name: string,
  attrs: Record<string, string> = {},
  children: DocNode[] = [],
  loc?: SourceLocation,
): ElementNode {
  const node: ElementNode = { type: 'element', name, attrs, children };
  if (loc) node.loc = loc;
  return node;
}

export function text(value: string): TextNode {
  return { type: 'text', value };
}

export function isElement(node: DocNode | undefined, name?: string): node is ElementNode {
  return (
    node !== undefined && node.type === 'element' && (name === undefined || node.name === name)
  );
}

export function childElements(node: ElementNode, name?: string): ElementNode[] {
  return node.children.filter((c): c is ElementNode => isElement(c, name));
}

export function firstChild(node: ElementNode, name: string): ElementNode | undefined {
  return node.children.find((c): c is ElementNode => isElement(c, name));
}

/** Concatenated text content, with runs of whitespace collapsed. */
export function textContent(node: DocNode): string {
  return rawText(node)
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/^[ ]+|[ ]+$/g, '');
}

function rawText(node: DocNode): string {
  if (node.type === 'text') return node.value;
  return node.children.map(rawText).join('');
}

/**
 * Text as a reader without filtering would see it: like `textContent`, but an
 * `opend-choice` contributes only its first alternative.
 */
export function displayText(node: DocNode): string {
  const raw = (n: DocNode): string => {
    if (n.type === 'text') return n.value;
    const kids = n.name === SYNTHETIC.choice ? n.children.slice(0, 1) : n.children;
    return kids.map(raw).join('');
  };
  return raw(node)
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/^[ ]+|[ ]+$/g, '');
}

/** Depth-first walk. Return `false` from the visitor to skip a node's children. */
export function walk(
  node: DocNode,
  visit: (node: ElementNode, ancestors: ElementNode[]) => boolean | void,
  ancestors: ElementNode[] = [],
): void {
  if (node.type !== 'element') return;
  if (visit(node, ancestors) === false) return;
  const next = [...ancestors, node];
  for (const child of node.children) walk(child, visit, next);
}

export function cloneNode<T extends DocNode>(node: T): T {
  return structuredClone(node);
}
