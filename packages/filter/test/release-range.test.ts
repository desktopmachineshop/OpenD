import { describe, expect, it } from 'vitest';
import {
  compareReleaseLines,
  isReleaseLine,
  parseReleaseRange,
  parseVersion,
  releaseLine,
  versionInRange,
} from '../src/index.js';

const matches = (token: string, version: string) => {
  const range = parseReleaseRange(token);
  const v = parseVersion(version);
  if (!range || !v) throw new Error(`bad input ${token} / ${version}`);
  return versionInRange(v, range);
};

describe('release ranges', () => {
  it.each([
    ['1.4', '1.4', true],
    ['1.4', '1.4.7', true],
    ['1.4', '1.5', false],
    ['1.4', '1', false],
    ['2', '2.9.1', true],
    ['2', '3.0', false],
    ['v1', '1.2', true],
    ['1.2..1.9', '1.2', true],
    ['1.2..1.9', '1.9.5', true],
    ['1.2..1.9', '1.10', false],
    ['1.2..1.9', '1.1.9', false],
    ['2.0..', '2.0', true],
    ['2.0..', '10.1', true],
    ['2.0..', '1.99', false],
    ['..1.9', '0.1', true],
    ['..1.9', '1.9.9', true],
    ['..1.9', '2.0', false],
    ['v2.0..', 'v2.1', true],
  ])('%s matches %s: %s', (token, version, expected) => {
    expect(matches(token, version)).toBe(expected);
  });

  it.each(['', '..', '1..2..3', 'abc', '1.x', '2.0..1.0', '1.2-1.9', '>=2'])(
    'rejects %j',
    (token) => {
      expect(parseReleaseRange(token)).toBeNull();
    },
  );
});

describe('release lines', () => {
  it('names a line by major or by minor version', () => {
    expect(releaseLine('2.1.3')).toBe('2');
    expect(releaseLine('v0.23.1', 'minor')).toBe('0.23');
    expect(releaseLine('2', 'minor')).toBe('2.0');
    expect(releaseLine('02.010', 'minor')).toBe('2.10');
    expect(releaseLine('next', 'minor')).toBeNull();
  });

  it('checks line names as releaseLine writes them', () => {
    expect(isReleaseLine('0.23', 'minor')).toBe(true);
    expect(isReleaseLine('2', 'major')).toBe(true);
    for (const bad of ['2', '0.23.1', 'v0.23', '00.23', 'latest'])
      expect(isReleaseLine(bad, 'minor'), bad).toBe(false);
    expect(isReleaseLine('0.23', 'major')).toBe(false);
  });

  it('orders lines as versions', () => {
    expect(['0.23', '0.3', '1.0', '0.21'].sort(compareReleaseLines)).toEqual([
      '0.3',
      '0.21',
      '0.23',
      '1.0',
    ]);
    expect(['10', '9'].sort(compareReleaseLines)).toEqual(['9', '10']);
  });
});
