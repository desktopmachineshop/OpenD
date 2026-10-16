import { SYNTHETIC, isFilterAttribute, type ElementNode } from '@opend/model';
import { isIncluded, tokens, type FilterPolicy, type FilterTreeOptions } from './policy.js';

/**
 * Version of the segmentation below. The hosted server only uses a release's
 * search index when it was written with this format, and falls back to
 * `searchView` otherwise; bump it whenever `searchSegments` changes.
 */
export const SEARCH_INDEX_FORMAT = 1;

/** Postgres text-search weights: the topic title, its short description, everything else. */
export type SearchWeight = 'A' | 'B' | 'C';

/**
 * One condition a piece of text sits behind. `attrs` passes when the reader's
 * filter includes those attributes. `choice` is an alternative of an
 * `opend-choice`: it passes when its own attributes (the last entry) are
 * included and every earlier alternative's are excluded, which is how
 * `filterTree` keeps the first surviving alternative.
 */
export type SearchGate = { attrs: Record<string, string> } | { choice: Record<string, string>[] };

/** A run of topic text that every reader either sees in full or not at all. */
export interface SearchSegment {
  text: string;
  weight: SearchWeight;
  /** Every gate must pass. Empty for unconditional text. */
  gates: SearchGate[];
}

function filterAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(attrs).sort()) {
    if (isFilterAttribute(name) && tokens(attrs[name]!).length > 0) out[name] = attrs[name]!;
  }
  return out;
}

/**
 * Splits a topic tree into segments, each with the conditions of its element
 * and every ancestor (including the topic root), so a search index can decide
 * per reader which words count. Element boundaries become spaces.
 *
 * Applied to a reader's filtered topic it yields exactly the text that reader
 * sees, which is what hosted search ranks and quotes.
 */
export function searchSegments(body: ElementNode): SearchSegment[] {
  const out: SearchSegment[] = [];
  let buffer = '';
  let current: { weight: SearchWeight; gates: SearchGate[] } | null = null;
  const flush = () => {
    const text = buffer.replace(/\s+/g, ' ').trim();
    if (text && current) out.push({ text, weight: current.weight, gates: current.gates });
    buffer = '';
  };
  const append = (value: string, weight: SearchWeight, gates: SearchGate[]) => {
    // Gate arrays are shared by reference between siblings without conditions.
    if (!current || current.weight !== weight || current.gates !== gates) {
      flush();
      current = { weight, gates };
    }
    buffer += value;
  };

  const visit = (node: ElementNode, weight: SearchWeight, gates: SearchGate[]) => {
    const alternatives: Record<string, string>[] = [];
    let sawTitle = false;
    let sawShortdesc = false;
    for (const child of node.children) {
      if (child.type === 'text') {
        append(child.value, weight, gates);
        continue;
      }
      let childWeight = weight;
      if (node === body && child.name === 'title' && !sawTitle) {
        sawTitle = true;
        childWeight = 'A';
      } else if (node === body && child.name === 'shortdesc' && !sawShortdesc) {
        sawShortdesc = true;
        childWeight = 'B';
      }
      let childGates = gates;
      const own = filterAttrs(child.attrs);
      if (node.name === SYNTHETIC.choice) {
        alternatives.push(own);
        childGates = [...gates, { choice: [...alternatives] }];
      } else if (Object.keys(own).length > 0) {
        childGates = [...gates, { attrs: own }];
      }
      append(' ', weight, gates);
      visit(child, childWeight, childGates);
      append(' ', weight, gates);
    }
  };

  const rootAttrs = filterAttrs(body.attrs);
  visit(body, 'C', Object.keys(rootAttrs).length > 0 ? [{ attrs: rootAttrs }] : []);
  flush();
  return out;
}

/** Whether a reader with these policies sees text behind every one of `gates`. */
export function gatesPass(
  gates: readonly SearchGate[],
  policies: readonly FilterPolicy[],
  options: FilterTreeOptions = {},
): boolean {
  const resolveChoices = options.resolveChoices ?? true;
  return gates.every((gate) => {
    if ('attrs' in gate) return isIncluded(gate.attrs, policies);
    const own = gate.choice[gate.choice.length - 1];
    if (!own || !isIncluded(own, policies)) return false;
    return !resolveChoices || gate.choice.slice(0, -1).every((a) => !isIncluded(a, policies));
  });
}

/** Title, short description and remaining text, as `searchSegments` splits them. */
export interface SearchText {
  title: string;
  shortdesc: string;
  body: string;
}

/** The searchable text of a (filtered) topic tree, grouped by weight. */
export function searchText(body: ElementNode): SearchText {
  const parts: Record<SearchWeight, string[]> = { A: [], B: [], C: [] };
  for (const s of searchSegments(body)) parts[s.weight].push(s.text);
  return { title: parts.A.join(' '), shortdesc: parts.B.join(' '), body: parts.C.join(' ') };
}
