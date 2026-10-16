import { describe, expect, it } from 'vitest';
import { entitlementKey, projectConfigSchema, readerContextSchema } from '../src/index.js';

describe('entitlementKey', () => {
  it('is the same for readers with the same entitlements, whatever their org or order', () => {
    const a = readerContextSchema.parse({
      org: 'acme',
      products: ['b', 'a', 'a'],
      features: ['sso'],
      version: '2.1',
    });
    const b = readerContextSchema.parse({
      org: 'globex',
      products: ['a', 'b'],
      features: ['sso'],
      version: '2.1',
    });
    expect(entitlementKey(a)).toBe(entitlementKey(b));
    expect(entitlementKey(a)).not.toBe(entitlementKey({ ...b, version: '2.0' }));
  });
});

describe('projectConfigSchema', () => {
  it('applies defaults', () => {
    expect(projectConfigSchema.parse({ release: '1', map: 'm.ditamap' })).toEqual({
      release: '1',
      map: 'm.ditamap',
      publications: [],
      attributes: {},
      title: 'Documentation',
    });
  });

  it('rejects non-filtering attributes and values with spaces', () => {
    expect(
      projectConfigSchema.safeParse({ release: '1', map: 'm', attributes: { id: ['x'] } }).success,
    ).toBe(false);
    expect(
      projectConfigSchema.safeParse({ release: '1', map: 'm', attributes: { product: ['a b'] } })
        .success,
    ).toBe(false);
  });
});
