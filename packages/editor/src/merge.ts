/**
 * Line-based three-way merge, used to sort the files of a conflicting merge
 * into ones that merge cleanly and ones the author has to choose for.
 */

/** Above this many cells the line diff gives up and the file counts as conflicting. */
const MAX_DIFF_CELLS = 4_000_000;

export const CONFLICT_MINE = '<<<<<<< your version';
export const CONFLICT_SEPARATOR = '=======';
export const CONFLICT_THEIRS = '>>>>>>> current version';

/**
 * For each line of `a`, the index of the matching line in `b` (longest common
 * subsequence), or -1. Returns `null` when the inputs are too large.
 */
export function matchLines(a: readonly string[], b: readonly string[]): Int32Array | null {
  const match = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    match[start] = start;
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    match[endA] = endB;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return match;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;
  // lcs[i][j]: LCS length of a[start+i..endA) and b[start+j..endB).
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      match[start + i] = start + j;
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) i++;
    else j++;
  }
  return match;
}

export type Merge3 =
  | { clean: true; text: string }
  /** `text` holds conflict markers around each conflicting section. */
  | { clean: false; text: string; conflicts: number };

const same = (x: readonly string[], y: readonly string[]) =>
  x.length === y.length && x.every((line, i) => line === y[i]);

/** Merges two edits of `base`. Changes to separate sections combine; overlapping ones conflict. */
export function merge3(base: string, ours: string, theirs: string): Merge3 {
  if (ours === theirs) return { clean: true, text: ours };
  if (ours === base) return { clean: true, text: theirs };
  if (theirs === base) return { clean: true, text: ours };
  const b = base.split('\n');
  const o = ours.split('\n');
  const t = theirs.split('\n');
  const mo = matchLines(b, o);
  const mt = matchLines(b, t);
  if (!mo || !mt) {
    return {
      clean: false,
      conflicts: 1,
      text: [CONFLICT_MINE, ours, CONFLICT_SEPARATOR, theirs, CONFLICT_THEIRS].join('\n'),
    };
  }
  const out: string[] = [];
  let conflicts = 0;
  let ib = 0;
  let io = 0;
  let it = 0;
  while (ib < b.length || io < o.length || it < t.length) {
    // A base line both sides kept, at the current position: stable.
    if (ib < b.length && mo[ib] === io && mt[ib] === it) {
      out.push(b[ib]!);
      ib++;
      io++;
      it++;
      continue;
    }
    // Otherwise the unstable section runs to the next line both sides kept.
    let next = ib;
    while (next < b.length && (mo[next] === -1 || mt[next] === -1)) next++;
    const oEnd = next < b.length ? mo[next]! : o.length;
    const tEnd = next < b.length ? mt[next]! : t.length;
    const bc = b.slice(ib, next);
    const oc = o.slice(io, oEnd);
    const tc = t.slice(it, tEnd);
    if (same(oc, bc)) out.push(...tc);
    else if (same(tc, bc) || same(oc, tc)) out.push(...oc);
    else {
      conflicts++;
      out.push(CONFLICT_MINE, ...oc, CONFLICT_SEPARATOR, ...tc, CONFLICT_THEIRS);
    }
    ib = next;
    io = oEnd;
    it = tEnd;
  }
  const text = out.join('\n');
  return conflicts ? { clean: false, text, conflicts } : { clean: true, text };
}

/** Whether text still contains conflict markers from `merge3`. */
export function hasConflictMarkers(text: string): boolean {
  return text.split('\n').some((l) => l === CONFLICT_MINE || l === CONFLICT_THEIRS);
}

/** Values of every `id` attribute in an XML source. */
export function elementIds(source: string): Set<string> {
  const ids = new Set<string>();
  for (const m of source.matchAll(/\sid\s*=\s*(["'])([^"']+)\1/g)) ids.add(m[2]!);
  return ids;
}
