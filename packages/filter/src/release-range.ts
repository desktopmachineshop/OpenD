import type { ReleaseLines } from '@opend/model';

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

/**
 * The release line a version belongs to: its major number (`2` for 2.1.3), or
 * with `minor` lines its major and minor numbers (`0.23` for 0.23.1). Readers
 * are served the live release of their line, so `1.4` readers keep the 1.x
 * docs after 2.0 (and `0.22` readers the 0.22 docs after 0.23, by minor).
 */
export function releaseLine(version: string, lines: ReleaseLines = 'major'): string | null {
  const v = parseVersion(version);
  if (!v) return null;
  return lines === 'minor' ? `${v[0]}.${v[1] ?? 0}` : String(v[0]);
}

/**
 * Whether `line` is a release line name for that granularity, written as
 * `releaseLine` writes it (`2`, or `0.23`; never `v2`, `02` or `0.23.1`).
 */
export function isReleaseLine(line: string, lines: ReleaseLines): boolean {
  return (
    (lines === 'minor' ? /^\d+\.\d+$/ : /^\d+$/).test(line) && releaseLine(line, lines) === line
  );
}

/** Orders release lines as versions, oldest first: `0.3` before `0.23`, `9` before `10`. */
export function compareReleaseLines(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va && vb) return compareVersions(va, vb);
  if (va || vb) return va ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}
