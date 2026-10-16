import {
  ENTITLEMENT_ATTRIBUTES,
  RELEASE_ATTRIBUTE,
  SYNTHETIC,
  isEntitlementAttribute,
  isFilterAttribute,
  type DocNode,
  type ElementNode,
  type ReaderContext,
} from '@opend/model';
import { parseReleaseRange, parseVersion, versionInRange } from './release-range.js';

export type ValueAction = 'include' | 'exclude';

/**
 * Decides single attribute values, like one DITAVAL. `decide` returns
 * `undefined` for attributes the policy does not govern.
 */
export interface FilterPolicy {
  readonly name: string;
  decide(attribute: string, value: string): ValueAction | undefined;
}

export function tokens(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/**
 * DITAVAL semantics: an element is excluded when, for any filtering attribute,
 * every one of its values is excluded. So values within one attribute are OR'd
 * and separate attributes are AND'd. Elements without filtering attributes are
 * always included. Every policy must include the element.
 */
export function isIncluded(
  attrs: Record<string, string>,
  policies: readonly FilterPolicy[],
): boolean {
  for (const [attribute, value] of Object.entries(attrs)) {
    if (!isFilterAttribute(attribute)) continue;
    const values = tokens(value);
    if (values.length === 0) continue;
    for (const policy of policies) {
      const decisions = values.map((v) => policy.decide(attribute, v));
      if (decisions.every((d) => d === 'exclude')) return false;
    }
  }
  return true;
}

export interface FilterTreeOptions {
  /**
   * Keep only the first surviving alternative of each `opend-choice` (default).
   * The build turns this off: it filters for every reader at once, so it must
   * leave the remaining alternatives for each reader's filter to choose from.
   */
  resolveChoices?: boolean;
}

/**
 * Removes every element the policies exclude, together with its descendants.
 * An `opend-choice` keeps only its first surviving alternative.
 */
export function filterTree(
  node: ElementNode,
  policies: readonly FilterPolicy[],
  options: FilterTreeOptions = {},
): ElementNode | null {
  if (!isIncluded(node.attrs, policies)) return null;
  const resolveChoices = options.resolveChoices ?? true;
  const children: DocNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      children.push(child);
      continue;
    }
    const kept = filterTree(child, policies, options);
    if (kept) children.push(kept);
    if (kept && resolveChoices && node.name === SYNTHETIC.choice) break;
  }
  return { ...node, children };
}

/**
 * The policy for one reader. It is fail-closed: an entitlement value the reader
 * does not hold, an unparseable release range, or an unparseable reader version
 * all exclude.
 */
export function readerPolicy(ctx: ReaderContext): FilterPolicy {
  const held: Record<string, Set<string>> = {};
  for (const [attribute, field] of Object.entries(ENTITLEMENT_ATTRIBUTES)) {
    held[attribute] = new Set(ctx[field]);
  }
  const version = parseVersion(ctx.version);
  return {
    name: 'reader',
    decide(attribute, value) {
      if (isEntitlementAttribute(attribute)) {
        return held[attribute]?.has(value) ? 'include' : 'exclude';
      }
      if (attribute === RELEASE_ATTRIBUTE) {
        const range = parseReleaseRange(value);
        return version && range && versionInRange(version, range) ? 'include' : 'exclude';
      }
      return undefined;
    },
  };
}

export interface DitavalRule {
  /** Omitted for the global default rule. */
  att?: string;
  /** Omitted for an attribute-wide default. */
  val?: string;
  action: 'include' | 'exclude' | 'flag' | 'passthrough';
}

/**
 * A policy from DITAVAL `prop` rules. The most specific rule wins: attribute and
 * value, then attribute default, then global default, then include. `flag` and
 * `passthrough` include.
 */
export function ditavalPolicy(rules: readonly DitavalRule[], name = 'ditaval'): FilterPolicy {
  const exact = new Map<string, ValueAction>();
  const attributeDefault = new Map<string, ValueAction>();
  let globalDefault: ValueAction | undefined;
  const asAction = (a: DitavalRule['action']): ValueAction =>
    a === 'exclude' ? 'exclude' : 'include';
  for (const rule of rules) {
    if (rule.att === undefined) globalDefault = asAction(rule.action);
    else if (rule.val === undefined) attributeDefault.set(rule.att, asAction(rule.action));
    else exact.set(`${rule.att}\u0000${rule.val}`, asAction(rule.action));
  }
  return {
    name,
    decide(attribute, value) {
      return (
        exact.get(`${attribute}\u0000${value}`) ??
        attributeDefault.get(attribute) ??
        globalDefault ??
        'include'
      );
    },
  };
}
