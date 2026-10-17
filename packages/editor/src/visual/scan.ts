/**
 * A small XML scanner that finds where elements start and end in the source
 * text. The visual editor uses it to write back only the parts of a file that
 * changed, so the rest keeps its exact formatting and a reviewer sees a small
 * diff. It assumes well-formed input (the browser's parser checks that first).
 */

export interface SourceNode {
  kind: 'element' | 'comment' | 'pi';
  name: string;
  /** Offset of the `<`. */
  start: number;
  /** Offset just after the start tag's `>`. */
  openEnd: number;
  /** Offset of the end tag's `<` (equal to `end` for a self-closing element). */
  closeStart: number;
  /** Offset just after the element. */
  end: number;
  selfClosing: boolean;
  children: SourceNode[];
}

/** Scans `src` and returns its top-level nodes (normally the one root element). */
export function scanXml(src: string): SourceNode[] {
  const root: SourceNode[] = [];
  const stack: SourceNode[] = [];
  const add = (node: SourceNode) => (stack.at(-1)?.children ?? root).push(node);
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      const stop = end === -1 ? src.length : end + 3;
      add(leaf('comment', '', lt, stop));
      i = stop;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      const stop = end === -1 ? src.length : end + 2;
      add(leaf('pi', '', lt, stop));
      i = stop;
    } else if (src.startsWith('<!', lt)) {
      i = skipDeclaration(src, lt);
    } else if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt);
      const stop = gt === -1 ? src.length : gt + 1;
      const open = stack.pop();
      if (open) {
        open.closeStart = lt;
        open.end = stop;
      }
      i = stop;
    } else {
      const gt = tagEnd(src, lt);
      const name = /^<([^\s/>]+)/.exec(src.slice(lt, lt + 200))?.[1] ?? '';
      const selfClosing = src[gt - 1] === '/';
      const node: SourceNode = {
        kind: 'element',
        name,
        start: lt,
        openEnd: gt + 1,
        closeStart: gt + 1,
        end: gt + 1,
        selfClosing,
        children: [],
      };
      add(node);
      if (!selfClosing) stack.push(node);
      i = gt + 1;
    }
  }
  return root;
}

function leaf(kind: 'comment' | 'pi', name: string, start: number, end: number): SourceNode {
  return {
    kind,
    name,
    start,
    openEnd: end,
    closeStart: end,
    end,
    selfClosing: true,
    children: [],
  };
}

/** The offset of the `>` that ends a start tag, skipping `>` inside quoted attribute values. */
function tagEnd(src: string, from: number): number {
  let quote = '';
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return src.length - 1;
}

/** Skips `<!DOCTYPE …>`, including an internal subset in brackets. */
function skipDeclaration(src: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from + 2; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return i + 1;
  }
  return src.length;
}

/** The whitespace between the start of `offset`'s line and `offset`, when the line is blank before it. */
export function indentAt(src: string, offset: number): string | null {
  const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
  const before = src.slice(lineStart, offset);
  return /^[ \t]*$/.test(before) ? before : null;
}
