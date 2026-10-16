import { describe, expect, it } from 'vitest';
import { parseReleaseRange, parseVersion, versionInRange } from '../src/index.js';

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
