import { entitlementKey, type ReaderContext, type ReleaseLines } from '@opend/model';
import {
  compareVersions,
  parseVersion,
  readerPolicy,
  releaseLine,
  type FilterPolicy,
} from '@opend/filter';
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

/** The staff view's audience: unfiltered, on the chosen line or else the reader's own. */
function staffAudience(
  access: ReaderAccess,
  version: string | null,
  lines: ReleaseLines,
): Audience {
  const v = version ?? access.context?.version;
  return { key: 'staff', context: null, line: v ? releaseLine(v, lines) : null };
}

/**
 * A reader's entitlements, served the live release of their version's line
 * at the repo's granularity (`lines`): `2` for 2.1 by major, `0.21` for
 * 0.21.4 by minor.
 */
export function readerAudience(context: ReaderContext, lines: ReleaseLines): Audience {
  return { key: entitlementKey(context), context, line: releaseLine(context.version, lines) };
}

/**
 * Anonymous visitors of a public site: the public set, on `version` when the
 * version picker chose one. A chosen version without a public set opens
 * content gated only by release, never by product or feature.
 */
export function publicAudience(repo: Repo, version: string | null = null): Audience {
  const pub = repo.publicEntitlements;
  if (!pub && !version) return { key: 'public|none', context: NOTHING_GATED, line: null };
  const context: ReaderContext = {
    products: pub?.products ?? [],
    features: pub?.features ?? [],
    version: version ?? pub!.version,
  };
  return {
    key: `public|${entitlementKey(context)}`,
    context,
    line: releaseLine(context.version, repo.releaseLines),
  };
}

/**
 * The audience for a request to the site of `repo`, on `version` when the
 * version picker chose one (see `versionChoice`); otherwise on each reader's
 * own version.
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
 *   A chosen version applies to both, so they are always on the same line.
 */
export function audienceFor(
  repo: Repo,
  access: ReaderAccess | null,
  version: string | null = null,
): Audience | NoAudience {
  const lines = repo.releaseLines;
  if (access?.reader.staff) return staffAudience(access, version, lines);
  const on = (context: ReaderContext): ReaderContext =>
    version ? { ...context, version } : context;
  if (repo.access !== 'public') {
    if (!access) return 'sign-in';
    if (!access.context) return 'no-entitlements';
    return readerAudience(on(access.context), lines);
  }
  const own = access?.context ? on(access.context) : null;
  if (!own) return publicAudience(repo, version);
  const pub = repo.publicEntitlements;
  if (!pub || releaseLine(version ?? pub.version, lines) !== releaseLine(own.version, lines))
    return readerAudience(own, lines);
  return readerAudience(
    {
      ...own,
      products: [...new Set([...own.products, ...pub.products])],
      features: [...new Set([...own.features, ...pub.features])],
    },
    lines,
  );
}

/** What the header shows a request about versions: nothing when the picker is off. */
export interface VersionChoice {
  mode: 'reader' | 'fixed' | 'list';
  /** The version served. */
  current: string;
  /** What the reader may switch to, newest first: only `current` unless the mode is `list`. */
  options: string[];
}

/**
 * The version a request is served and what it may switch to, from the site's
 * version picker, the reader's own version (`null` for anonymous visitors
 * without a public set) and the version they asked for (the version cookie).
 * A requested version that is not offered is ignored, so a reader can only
 * ever switch to what the operator listed or to their own version.
 */
export function versionChoice(
  repo: Repo,
  own: string | null,
  requested: string | undefined,
): VersionChoice | null {
  const picker = repo.versionPicker;
  const ownVersion = own && parseVersion(own) ? own : null;
  switch (picker.mode) {
    case 'reader':
      return ownVersion ? { mode: 'reader', current: ownVersion, options: [ownVersion] } : null;
    case 'fixed':
      return { mode: 'fixed', current: picker.version, options: [picker.version] };
    case 'list': {
      const options = [...new Set([...picker.versions, ...(ownVersion ? [ownVersion] : [])])]
        .filter((v) => parseVersion(v))
        .sort((a, b) => compareVersions(parseVersion(b)!, parseVersion(a)!));
      if (!options.length) return null;
      const current =
        requested && options.includes(requested) ? requested : (ownVersion ?? options[0]!);
      return { mode: 'list', current, options };
    }
    default:
      return null;
  }
}

/**
 * The reader's own version, which the version picker starts from: their
 * entitlements' version, or the public set's for anonymous visitors (and
 * readers without entitlements) of a public site.
 */
export function ownVersion(repo: Repo, access: ReaderAccess | null): string | null {
  if (access?.context) return access.context.version;
  if (access?.reader.staff || repo.access !== 'public') return null;
  return repo.publicEntitlements?.version ?? null;
}

/**
 * The version `audienceFor` serves for a choice: only `fixed` and `list`
 * change it, as `reader` shows the version each reader already gets.
 */
export function chosenVersion(choice: VersionChoice | null): string | null {
  return choice && choice.mode !== 'reader' ? choice.current : null;
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
