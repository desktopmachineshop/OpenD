/**
 * How each supported DITA element maps to HTML. Elements with special handling
 * (titles, links, images, tables, notes, conditions) are dispatched in
 * `render.ts`; everything else is a plain tag here. Unknown elements render as
 * a `div`.
 */
// prettier-ignore
export const TAGS: Record<string, string> = {
  // structure
  body: 'div', conbody: 'div', taskbody: 'div', refbody: 'div', troublebody: 'div', glossBody: 'div',
  bodydiv: 'div', sectiondiv: 'div', div: 'div', abstract: 'div', shortdesc: 'p',
  section: 'section', example: 'section', refsyn: 'section', glossdef: 'p', glossterm: 'h1',
  linkpool: 'div', linklist: 'div', desc: 'span', linktext: 'span',
  // blocks
  p: 'p', ul: 'ul', ol: 'ol', li: 'li', sl: 'ul', sli: 'li',
  dl: 'dl', dlentry: 'div', dt: 'dt', dd: 'dd', dlhead: 'div', dthd: 'dt', ddhd: 'dd',
  codeblock: 'pre', pre: 'pre', lines: 'div', lq: 'blockquote', fig: 'figure',
  // task
  prereq: 'section', context: 'section', result: 'section', postreq: 'section',
  tasktroubleshooting: 'section', steps: 'ol', 'steps-unordered': 'ul', 'steps-informal': 'div',
  step: 'li', substeps: 'ol', substep: 'li', cmd: 'span', info: 'div', stepxmp: 'div',
  stepresult: 'div', tutorialinfo: 'div', choices: 'ul', choice: 'li',
  // troubleshooting
  condition: 'section', troubleSolution: 'div', cause: 'section', remedy: 'section',
  // inline
  ph: 'span', b: 'b', i: 'i', u: 'u', sup: 'sup', sub: 'sub', tt: 'code', 'line-through': 's',
  overline: 'span', keyword: 'span', term: 'em', q: 'q', codeph: 'code', filepath: 'code',
  cmdname: 'code', varname: 'var', userinput: 'kbd', systemoutput: 'samp', uicontrol: 'span',
  wintitle: 'span', option: 'code', parmname: 'code', apiname: 'code', msgph: 'samp',
  synph: 'code', text: 'span', cite: 'cite', fn: 'span', 'abbreviated-form': 'span', tm: 'span',
  menucascade: 'span', alt: 'span',
};

/** Headings DITA-OT style for task and troubleshooting sections that have no title of their own. */
export const SECTION_LABELS: Record<string, string> = {
  prereq: 'Before you begin',
  context: 'About this task',
  result: 'Results',
  postreq: 'What to do next',
  tasktroubleshooting: 'Troubleshooting',
  condition: 'Condition',
  cause: 'Cause',
  remedy: 'Remedy',
};

export const NOTE_LABELS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  remember: 'Remember',
  restriction: 'Restriction',
  attention: 'Attention',
  caution: 'Caution',
  danger: 'Danger',
  warning: 'Warning',
  notice: 'Notice',
  fastpath: 'Fast path',
  trouble: 'Trouble',
};
