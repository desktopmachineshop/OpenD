import { z } from 'zod';

/** Profiling attribute matched against the reader's version, using release ranges. */
export const RELEASE_ATTRIBUTE = 'release';

/**
 * Profiling attributes matched against the reader's entitlements. Each maps to
 * the reader-context field that lists what the reader holds.
 */
export const ENTITLEMENT_ATTRIBUTES = {
  product: 'products',
  feature: 'features',
} as const;

export type EntitlementAttribute = keyof typeof ENTITLEMENT_ATTRIBUTES;

export function isEntitlementAttribute(name: string): name is EntitlementAttribute {
  return Object.hasOwn(ENTITLEMENT_ATTRIBUTES, name);
}

/** The DITA attributes OpenD treats as filtering attributes. */
export const FILTER_ATTRIBUTES = [
  RELEASE_ATTRIBUTE,
  ...Object.keys(ENTITLEMENT_ATTRIBUTES),
  'audience',
  'platform',
  'otherprops',
  'props',
  'deliveryTarget',
] as const;

export function isFilterAttribute(name: string): boolean {
  return (FILTER_ATTRIBUTES as readonly string[]).includes(name);
}

const token = z.string().regex(/^[A-Za-z0-9_.:-]+$/, 'must be a single token without spaces');
const relPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
    message: 'must be a path inside the docs root',
  });

export const projectConfigSchema = z
  .object({
    /** The version this source tree documents, e.g. `2.1`. */
    release: z.string().min(1),
    /** Root DITA map for the site navigation. */
    map: relPath,
    /** Bookmaps or maps that define curated publications such as PDFs. */
    publications: z.array(relPath).default([]),
    /**
     * Declared values per filtering attribute. Any value used in content that is
     * not declared here is a validation error. `release` is not declared: its
     * values are version ranges.
     */
    attributes: z.record(z.string(), z.array(token)).default({}),
    /** DITAVAL file applied at build time to every reader, e.g. to drop `audience="internal"`. */
    buildFilter: relPath.optional(),
    /** Stylesheet served with every page. */
    theme: relPath.optional(),
    /** Site title shown in the page header. */
    title: z.string().default('Documentation'),
  })
  .refine((c) => !(RELEASE_ATTRIBUTE in c.attributes), {
    message: `"${RELEASE_ATTRIBUTE}" takes version ranges and must not be listed under attributes`,
    path: ['attributes'],
  })
  .refine((c) => Object.keys(c.attributes).every(isFilterAttribute), {
    message: `attributes may only list filtering attributes: ${FILTER_ATTRIBUTES.join(', ')}`,
    path: ['attributes'],
  });

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const CONFIG_FILE = 'opend.config.yaml';
