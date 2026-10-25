import { z } from 'zod';
import { RELEASE_LINES } from './release.js';

/**
 * Site settings: who may read a hosted site, which versions readers can pick,
 * how releases group into lines and which refs publish. The admin API, the
 * admin console, seed files and the `site:` block of `opend.config.yaml` all
 * validate them with these schemas.
 */

/**
 * The public entitlements' version keyword for "the newest live release line,
 * at request time": the site follows each new line as it goes live.
 */
export const LATEST_VERSION = 'latest';

const entitlementToken = z.string().regex(/^[A-Za-z0-9_.:-]+$/);
const VERSION = /^v?\d+(\.\d+)*$/;

/** What an organization's readers hold: products, features and the version they run. */
export const entitlementsSchema = z.object({
  products: z.array(entitlementToken).default([]),
  features: z.array(entitlementToken).default([]),
  version: z.string().regex(VERSION, 'a version such as 1.4'),
});

/**
 * What anonymous visitors of a public site are entitled to: entitlements whose
 * version may also be `latest`, the newest live release line at request time.
 */
export const publicEntitlementsSchema = entitlementsSchema.extend({
  version: z.union([
    z.literal(LATEST_VERSION),
    z.string().regex(VERSION, 'a version such as 1.4, or latest'),
  ]),
});

const pickerVersion = z.string().max(32).regex(VERSION, 'a version such as 2.1');

/**
 * The site's version picker: `off` (no picker), `reader` (show each reader
 * their own version), `fixed` (every reader gets `version`) or `list`
 * (readers choose among `versions`, and their own) or `live` (readers choose
 * among the live release lines).
 */
export const versionPickerSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }),
  z.object({ mode: z.literal('reader') }),
  z.object({ mode: z.literal('fixed'), version: pickerVersion }),
  z.object({
    mode: z.literal('list'),
    versions: z
      .array(pickerVersion)
      .min(1)
      .max(50)
      .transform((vs) => [...new Set(vs)]),
  }),
  z.object({ mode: z.literal('live') }),
]);

/** Branch or tag patterns that publish, e.g. `main`, `v*` or `docs/*`. */
export const releaseRefsSchema = z.array(z.string().min(1)).min(1);

/**
 * The `site:` block of `opend.config.yaml`: site settings the docs repository
 * declares, with the admin API's names and values. Every field is optional;
 * a field the block sets is applied by the hosted build and is read-only in
 * the admin console, and a field it leaves out stays console-managed.
 */
export const siteSettingsSchema = z
  .object({
    /** Branch or tag patterns that publish (default: the repository's default branch). */
    releaseRefs: releaseRefsSchema.optional(),
    /** One live release per major (`major`) or minor (`minor`) version. */
    releaseLines: z.enum(RELEASE_LINES).optional(),
    /** `public` also serves anonymous visitors, filtered for `publicEntitlements`. */
    access: z.enum(['private', 'public']).optional(),
    /** What anonymous visitors see; `null`: only unconditioned content. */
    publicEntitlements: publicEntitlementsSchema.nullable().optional(),
    /** What readers may switch between, as `PUT /admin/api/repos/:id/versions` takes it. */
    versionPicker: versionPickerSchema.optional(),
  })
  .strict();

export type SiteSettings = z.infer<typeof siteSettingsSchema>;

/** The fields of a `site:` block, in the order they are applied. */
export const SITE_SETTING_FIELDS = [
  'releaseLines',
  'access',
  'publicEntitlements',
  'versionPicker',
  'releaseRefs',
] as const satisfies readonly (keyof SiteSettings)[];

export type SiteSettingField = (typeof SITE_SETTING_FIELDS)[number];
