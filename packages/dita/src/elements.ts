import { isElement, type ElementNode } from '@opend/model';

/** Root elements of the topic types OpenD understands. */
export const TOPIC_TYPES = new Set([
  'topic',
  'concept',
  'task',
  'reference',
  'glossentry',
  'troubleshooting',
]);

/** Elements removed by the build so they can never reach a reader. */
export const DROPPED_ELEMENTS = new Set(['draft-comment', 'required-cleanup']);

/** Elements kept in the tree but never rendered (metadata). */
export const METADATA_ELEMENTS = new Set([
  'prolog',
  'titlealts',
  'navtitle',
  'searchtitle',
  'indexterm',
  'data',
  'data-about',
  'foreign',
  'unknown',
  'colspec',
  'resourceid',
]);

/**
 * The supported DITA subset: every element here is rendered (or deliberately
 * hidden). Anything else is reported by validation and rendered as a generic
 * block.
 */
// prettier-ignore
export const SUPPORTED_ELEMENTS = new Set([
  ...TOPIC_TYPES,
  ...DROPPED_ELEMENTS,
  ...METADATA_ELEMENTS,
  'dita',
  // structure
  'title', 'shortdesc', 'abstract', 'body', 'conbody', 'taskbody', 'refbody', 'troublebody',
  'glossterm', 'glossdef', 'glossBody', 'section', 'example', 'bodydiv', 'sectiondiv', 'div',
  'related-links', 'link', 'linktext', 'linkpool', 'linklist', 'desc',
  // blocks
  'p', 'ul', 'ol', 'li', 'sl', 'sli', 'dl', 'dlhead', 'dthd', 'ddhd', 'dlentry', 'dt', 'dd',
  'note', 'codeblock', 'pre', 'lines', 'lq', 'fig', 'image', 'alt',
  'table', 'tgroup', 'thead', 'tbody', 'row', 'entry',
  'simpletable', 'sthead', 'strow', 'stentry',
  'properties', 'prophead', 'proptypehd', 'propvaluehd', 'propdeschd',
  'property', 'proptype', 'propvalue', 'propdesc', 'refsyn',
  // task
  'prereq', 'context', 'steps', 'steps-unordered', 'steps-informal', 'step', 'cmd', 'info',
  'substeps', 'substep', 'stepxmp', 'stepresult', 'tutorialinfo', 'choices', 'choice',
  'result', 'postreq', 'tasktroubleshooting',
  // troubleshooting
  'condition', 'troubleSolution', 'cause', 'remedy',
  // inline
  'ph', 'b', 'i', 'u', 'sup', 'sub', 'tt', 'line-through', 'overline', 'keyword', 'term', 'q',
  'xref', 'codeph', 'filepath', 'cmdname', 'varname', 'userinput', 'systemoutput', 'uicontrol',
  'wintitle', 'menucascade', 'option', 'parmname', 'apiname', 'msgph', 'synph', 'text', 'tm',
  'cite', 'fn', 'abbreviated-form',
]);

export function isTopicElement(node: ElementNode): boolean {
  return TOPIC_TYPES.has(node.name);
}

/**
 * Finds a topic in a parsed file: the topic with the given id, searching nested
 * topics and `<dita>` wrappers, or the first topic when no id is given.
 */
export function findTopic(root: ElementNode, id?: string): ElementNode | undefined {
  if (isTopicElement(root) && (id === undefined || root.attrs.id === id)) return root;
  for (const child of root.children) {
    if (!isElement(child)) continue;
    if (!isTopicElement(child) && child.name !== 'dita') continue;
    const found = findTopic(child, id);
    if (found) return found;
  }
  return undefined;
}

/** Finds an element by `id` inside a topic, without descending into nested topics. */
export function findElementById(topic: ElementNode, id: string): ElementNode | undefined {
  for (const child of topic.children) {
    if (!isElement(child) || isTopicElement(child)) continue;
    if (child.attrs.id === id) return child;
    const found = findElementById(child, id);
    if (found) return found;
  }
  return undefined;
}
