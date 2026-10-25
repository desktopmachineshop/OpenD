import { describe, expect, it } from 'vitest';
import {
  entitlementKey,
  logoRoute,
  projectConfigSchema,
  readerContextSchema,
  siteSettingsSchema,
} from '../src/index.js';

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

  it('takes a built-in PDF template and settings to change in it', () => {
    const parse = (pdf: unknown) =>
      projectConfigSchema.safeParse({ release: '1', map: 'm', pdf }).success;
    expect(parse({ template: 'handbook', pageSize: 'Letter', header: '{title}' })).toBe(true);
    expect(parse({ template: 'poster' })).toBe(false);
    expect(parse({ pageSize: 'A3' })).toBe(false);
    // Print CSS belongs in the project theme.
    expect(parse({ customCss: 'x' })).toBe(false);
  });

  it('takes an image inside the docs root as the logo, and serves it by extension', () => {
    const parse = (logo: string) =>
      projectConfigSchema.safeParse({ release: '1', map: 'm', logo }).success;
    expect(parse('theme/logo.svg')).toBe(true);
    expect(parse('images/Logo.PNG')).toBe(true);
    expect(parse('theme/site.css')).toBe(false);
    expect(parse('../logo.svg')).toBe(false);
    expect(parse('/logo.svg')).toBe(false);
    expect(logoRoute('theme/logo.svg')).toBe('_logo.svg');
    expect(logoRoute('images/Logo.JPEG')).toBe('_logo.jpeg');
  });
});

describe('the site: block', () => {
  const base = { release: '0.23', map: 'm', attributes: { product: ['free', 'business'] } };
  const issues = (site: unknown) => {
    const r = projectConfigSchema.safeParse({ ...base, site });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('takes the admin API’s settings, all optional', () => {
    const site = {
      releaseRefs: ['docs/*'],
      releaseLines: 'minor',
      access: 'public',
      publicEntitlements: { products: ['free'], version: 'latest' },
      versionPicker: { mode: 'live' },
    };
    expect(projectConfigSchema.parse({ ...base, site }).site).toEqual({
      ...site,
      publicEntitlements: { products: ['free'], features: [], version: 'latest' },
    });
    expect(projectConfigSchema.parse({ ...base, site: {} }).site).toEqual({});
    expect(projectConfigSchema.parse(base).site).toBeUndefined();
    expect(
      issues({ publicEntitlements: null, versionPicker: { mode: 'fixed', version: '0.22' } }),
    ).toEqual([]);
    expect(issues({ versionPicker: { mode: 'list', versions: ['0.23', '0.22'] } })).toEqual([]);
  });

  it('names the field of every bad value', () => {
    expect(issues({ access: 'secret' })[0]).toMatch(/^site\.access: /);
    expect(issues({ releaseLines: 'patch' })[0]).toMatch(/^site\.releaseLines: /);
    expect(issues({ releaseRefs: [] })[0]).toMatch(/^site\.releaseRefs: /);
    expect(issues({ versionPicker: { mode: 'all' } })[0]).toMatch(/^site\.versionPicker/);
    expect(issues({ versionPicker: { mode: 'fixed', version: 'latest' } })[0]).toMatch(
      /^site\.versionPicker\.version: /,
    );
    expect(issues({ publicEntitlements: { products: ['free'], version: 'newest' } })[0]).toMatch(
      /^site\.publicEntitlements\.version: /,
    );
    // A typo is an error, not a setting silently ignored.
    expect(issues({ acess: 'public' })[0]).toMatch(/^site: .*acess/);
  });

  it('allows only declared products and features in the public set', () => {
    expect(issues({ publicEntitlements: { products: ['free', 'gold'], version: '0.23' } })).toEqual(
      ['site.publicEntitlements.products.1: "gold" is not declared under attributes.product'],
    );
    expect(issues({ publicEntitlements: { features: ['sso'], version: '0.23' } })).toEqual([
      'site.publicEntitlements.features.0: "sso" is not declared under attributes.feature',
    ]);
  });

  it('is the schema the admin API validates with', () => {
    expect(siteSettingsSchema.safeParse({ versionPicker: { mode: 'live' } }).success).toBe(true);
  });
});
