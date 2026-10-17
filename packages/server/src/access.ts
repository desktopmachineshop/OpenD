import { entitlementKey, type ReaderContext } from '@opend/model';
import { readerPolicy, releaseLine, type FilterPolicy } from '@opend/filter';
import type { FilterTreeOptions } from '@opend/filter';
import type { ReaderAccess, Repo } from '@opend/store';

/**
 * Who a request is filtered for. Everything rendered for an audience (views,
 * pages, publications, PDFs) is cached under its `key`, so two requests share
 * cached output exactly when they have the same audience. The key spaces never
 * overlap: entitlement keys start with `p=`, anonymous ones with `public|`,
 * and the staff view is `staff`.
 */
export interface Audience {
  key: string;
  /** The entitlement set filtered for; `null` for the unfiltered staff view. */
  context: ReaderContext | null;
  /** The release line served, or `null` for the newest live line. */
  line: string | null;
}

/** Why a request gets no audience: it must sign in, or the reader has no entitlements. */
export type NoAudience = 'sign-in' | 'no-entitlements';

/** Anonymous visitors of a public site without public entitlements: nothing gated. */
export const NOTHING_GATED: ReaderContext = { products: [], features: [], version: 'none' };

/** The staff view's audience: unfiltered, on the reader's own line when they have one. */
function staffAudience(access: ReaderAccess): Audience {
  return {
    key: 'staff',
    context: null,
    line: access.context ? releaseLine(access.context.version) : null,
  };
}

/** A reader's own entitlements. */
export function readerAudience(context: ReaderContext): Audience {
  return { key: entitlementKey(context), context, line: releaseLine(context.version) };
}

/** Anonymous visitors of a public site. */
export function publicAudience(repo: Repo): Audience {
  const pub = repo.publicEntitlements;
  if (!pub) return { key: 'public|none', context: NOTHING_GATED, line: null };
  const context: ReaderContext = {
    products: pub.products,
    features: pub.features,
    version: pub.version,
  };
  return { key: `public|${entitlementKey(context)}`, context, line: releaseLine(pub.version) };
}

/**
 * The audience for a request to the site of `repo`.
 *
 * - Staff readers get the staff view, whatever the access mode.
 * - Private sites: a signed-in reader with entitlements gets them; anyone
 *   else must sign in (or is told they have no entitlements).
 * - Public sites: anonymous visitors, and readers whose org has no
 *   entitlements, get the public set. A signed-in reader gets the union of
 *   their own entitlements and the public set, so signing in never hides
 *   anything public. The union is taken only when both are for the same
 *   release line: the public set opens one line, and must not open gated
 *   content of the reader's other line. Otherwise the reader keeps their own.
 */
export function audienceFor(repo: Repo, access: ReaderAccess | null): Audience | NoAudience {
  if (access?.reader.staff) return staffAudience(access);
  if (repo.access !== 'public') {
    if (!access) return 'sign-in';
    if (!access.context) return 'no-entitlements';
    return readerAudience(access.context);
  }
  const own = access?.context;
  if (!own) return publicAudience(repo);
  const pub = repo.publicEntitlements;
  if (!pub || releaseLine(pub.version) !== releaseLine(own.version)) return readerAudience(own);
  return readerAudience({
    ...own,
    products: [...new Set([...own.products, ...pub.products])],
    features: [...new Set([...own.features, ...pub.features])],
  });
}

/** The filter policies and options for an audience: none for the staff view. */
export function audienceFilter(audience: Pick<Audience, 'context'>): {
  policies: FilterPolicy[];
  options: FilterTreeOptions;
} {
  return audience.context
    ? { policies: [readerPolicy(audience.context)], options: {} }
    : { policies: [], options: { resolveChoices: false } };
}
