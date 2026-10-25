import { z } from 'zod';
import { pdfConfigSchema } from './appearance.js';
import { siteSettingsSchema } from './site.js';

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

const LOGO_EXTENSION = /\.(svg|png|jpe?g|gif|webp)$/i;

/**
 * Site path, without the leading `/`, that serves the project logo, e.g.
 * `_logo.svg`. The extension is kept so the response gets the right type.
 */
export function logoRoute(logo: string): string {
  return `_logo${(LOGO_EXTENSION.exec(logo)?.[0] ?? '').toLowerCase()}`;
}

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
    /** Image shown before the site title in the page header. */
    logo: relPath
      .refine((p) => LOGO_EXTENSION.test(p), {
        message: 'must be an .svg, .png, .jpg, .jpeg, .gif or .webp image',
      })
      .optional(),
    /** Layout of the project's PDFs: a built-in template and the settings to change in it. */
    pdf: pdfConfigSchema.optional(),
    /** Site title shown in the page header. */
    title: z.string().default('Documentation'),
    /**
     * Settings of the hosted site this repository publishes (access, version
     * picker, release lines, release refs), applied by the hosted build.
     */
    site: siteSettingsSchema.optional(),
  })
  .refine((c) => !(RELEASE_ATTRIBUTE in c.attributes), {
    message: `"${RELEASE_ATTRIBUTE}" takes version ranges and must not be listed under attributes`,
    path: ['attributes'],
  })
  .refine((c) => Object.keys(c.attributes).every(isFilterAttribute), {
    message: `attributes may only list filtering attributes: ${FILTER_ATTRIBUTES.join(', ')}`,
    path: ['attributes'],
  })
  .superRefine((c, ctx) => {
    // The public set may only name declared products and features: anything
    // else would match no content, so it is almost certainly a typo.
    const pub = c.site?.publicEntitlements;
    if (!pub) return;
    const custom = 'custom' as const; // a zod issue, not a diagnostic code
    for (const [attribute, field] of Object.entries(ENTITLEMENT_ATTRIBUTES)) {
      const declared = new Set(c.attributes[attribute] ?? []);
      pub[field].forEach((value, i) => {
        if (!declared.has(value))
          ctx.addIssue({
            code: custom,
            message: `"${value}" is not declared under attributes.${attribute}`,
            path: ['site', 'publicEntitlements', field, i],
          });
      });
    }
  });

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const CONFIG_FILE = 'opend.config.yaml';

export const HELP_CONTEXTS_FILE = 'help-contexts.yaml';

/** A context key such as `settings.network`: dot-separated, so it can fall back to its parents. */
export const contextKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'dot-separated words, e.g. settings.network');

export const helpAppNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, dashes and underscores');

/** `help-contexts.yaml`: maps host-app routes to context keys, per app. */
export const helpContextsSchema = z.object({
  apps: z.record(
    helpAppNameSchema,
    z.object({
      default: contextKeySchema.optional(),
      routes: z.record(z.string(), contextKeySchema).default({}),
    }),
  ),
});

export type HelpContextsFile = z.infer<typeof helpContextsSchema>;
