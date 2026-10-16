import { childElements, type Diagnostic } from '@opend/model';
import type { DitavalRule } from '@opend/filter';
import { parseXml } from './xml.js';

const ACTIONS = new Set(['include', 'exclude', 'flag', 'passthrough']);

/** Parses the `prop` rules of a DITAVAL file. Flagging styles and `revprop` are ignored. */
export function parseDitaval(
  source: string,
  file: string,
): { rules: DitavalRule[]; diagnostics: Diagnostic[] } {
  const { root, diagnostics } = parseXml(source, file);
  const rules: DitavalRule[] = [];
  if (!root) return { rules, diagnostics };
  if (root.name !== 'val') {
    diagnostics.push({
      severity: 'error',
      code: 'invalid-ditaval',
      message: 'DITAVAL root must be <val>',
      file,
    });
    return { rules, diagnostics };
  }
  for (const prop of childElements(root, 'prop')) {
    const action = prop.attrs.action ?? '';
    if (!ACTIONS.has(action)) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid-ditaval',
        message: `unknown action "${action}"`,
        file,
        line: prop.loc?.line,
        column: prop.loc?.column,
      });
      continue;
    }
    const rule: DitavalRule = { action: action as DitavalRule['action'] };
    if (prop.attrs.att) rule.att = prop.attrs.att;
    if (prop.attrs.att && prop.attrs.val !== undefined) rule.val = prop.attrs.val;
    rules.push(rule);
  }
  return { rules, diagnostics };
}
