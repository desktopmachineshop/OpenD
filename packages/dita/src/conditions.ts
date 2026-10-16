import { SYNTHETIC, element, isFilterAttribute, type Condition, type DocNode } from '@opend/model';

/** The filtering attributes of an element. */
export function conditionOf(attrs: Record<string, string>): Condition {
  const out: Condition = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (!isFilterAttribute(name)) continue;
    const v = value.trim();
    // DITA's "-dita-use-conref-target" means "take the value from the target".
    if (v && v !== '-dita-use-conref-target') out[name] = v;
  }
  return out;
}

export function isEmptyCondition(c: Condition): boolean {
  return Object.keys(c).length === 0;
}

/** Wraps nodes in one `opend-cond` per condition, outermost first. */
export function wrapInConditions(conditions: readonly Condition[], nodes: DocNode[]): DocNode[] {
  let out = nodes;
  for (let i = conditions.length - 1; i >= 0; i--) {
    out = [element(SYNTHETIC.cond, { ...conditions[i] }, out)];
  }
  return out;
}
