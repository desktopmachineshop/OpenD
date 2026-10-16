import { SaxesParser } from 'saxes';
import { text, type Diagnostic, type DocNode, type ElementNode } from '@opend/model';

/** Character entities commonly used in DITA sources that XML itself does not define. */
const EXTRA_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  rarr: '→',
  times: '×',
};

export interface ParsedXml {
  /** `null` when the document is not well-formed. */
  root: ElementNode | null;
  diagnostics: Diagnostic[];
}

/**
 * Parses XML into the shared node tree, keeping the source line and column of
 * every element. DTDs are not fetched or applied, so DITA default attributes
 * (`@class`) are not available; OpenD dispatches on element names instead.
 */
export function parseXml(source: string, file: string): ParsedXml {
  const parser = new SaxesParser({ position: true, fileName: file });
  Object.assign(parser.ENTITIES, EXTRA_ENTITIES);

  const diagnostics: Diagnostic[] = [];
  const stack: ElementNode[] = [];
  let root: ElementNode | null = null;
  let start = { line: 1, column: 1 };

  const append = (node: DocNode) => {
    const parent = stack[stack.length - 1];
    if (!parent) return;
    const last = parent.children[parent.children.length - 1];
    if (node.type === 'text' && last?.type === 'text') last.value += node.value;
    else parent.children.push(node);
  };

  parser.on('error', (err) => {
    diagnostics.push({
      severity: 'error',
      code: 'xml-syntax',
      message: err.message.replace(/^.*?:\d+:\d+: /, ''),
      file,
      line: parser.line,
      column: parser.column + 1,
    });
  });
  parser.on('opentagstart', (tag) => {
    // The parser has just read `<name` and the character after it; step back to
    // the `<` for a 1-based column.
    start = { line: parser.line, column: Math.max(1, parser.column - tag.name.length - 1) };
  });
  parser.on('opentag', (tag) => {
    const node: ElementNode = {
      type: 'element',
      name: tag.name,
      attrs: { ...(tag.attributes as Record<string, string>) },
      children: [],
      loc: { file, line: start.line, column: start.column },
    };
    if (stack.length === 0) root ??= node;
    else append(node);
    if (!tag.isSelfClosing) stack.push(node);
  });
  parser.on('closetag', (tag) => {
    if (!tag.isSelfClosing) stack.pop();
  });
  parser.on('text', (t) => append(text(t)));
  parser.on('cdata', (t) => append(text(t)));

  try {
    parser.write(source).close();
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      code: 'xml-syntax',
      message: err instanceof Error ? err.message : String(err),
      file,
    });
  }
  if (!root && diagnostics.length === 0) {
    diagnostics.push({ severity: 'error', code: 'xml-syntax', message: 'no root element', file });
  }
  return { root: diagnostics.some((d) => d.severity === 'error') ? null : root, diagnostics };
}
