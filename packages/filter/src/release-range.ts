/**
 * Release ranges used in the `release` attribute. A value is a space-separated
 * list of tokens, and content applies when the reader's version matches any
 * token:
 *
 *   1.4        any 1.4.x
 *   2          any 2.x.x
 *   1.2..1.9   1.2 up to and including any 1.9.x
 *   2.0..      2.0 and later
 *   ..1.9      up to and including any 1.9.x
 *
 * A leading `v` is allowed (`v1`, `v2.0..`).
 */
export interface ReleaseRange {
  from?: number[];
  to?: number[];
  exact?: number[];
}

export function parseVersion(input: string): number[] | null {
  const s = input.trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+)*$/.test(s)) return null;
  return s.split('.').map(Number);
}

export function parseReleaseRange(token: string): ReleaseRange | null {
  const parts = token.split('..');
  if (parts.length === 1) {
    const exact = parseVersion(token);
    return exact ? { exact } : null;
  }
  if (parts.length !== 2) return null;
  const [a = '', b = ''] = parts;
  if (a === '' && b === '') return null;
  const range: ReleaseRange = {};
  if (a !== '') {
    const from = parseVersion(a);
    if (!from) return null;
    range.from = from;
  }
  if (b !== '') {
    const to = parseVersion(b);
    if (!to) return null;
    range.to = to;
  }
  if (range.from && range.to && compareVersions(range.from, range.to) > 0) return null;
  return range;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Compare only the first `prefix.length` components of `version` with `prefix`. */
function comparePrefix(version: readonly number[], prefix: readonly number[]): number {
  return compareVersions(version.slice(0, prefix.length), prefix);
}

export function versionInRange(version: readonly number[], range: ReleaseRange): boolean {
  if (range.exact) return comparePrefix(version, range.exact) === 0;
  if (range.from && compareVersions(version, range.from) < 0) return false;
  if (range.to && comparePrefix(version, range.to) > 0) return false;
  return true;
}
