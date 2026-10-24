import { entitlementKey, type ReaderContext, type ReleaseLines } from '@opend/model';
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
function staffAudience(access: ReaderAccess, lines: ReleaseLines): Audience {
  return {
    key: 'staff',
    context: null,
    line: access.context ? releaseLine(access.context.version, lines) : null,
  };
}

/** A reader's own entitlements, on their line at the repo's granularity (`lines`). */
export function readerAudience(context: ReaderContext, lines: ReleaseLines): Audience {
  return { key: entitlementKey(context), context, line: releaseLine(context.version, lines) };
}

/**
 * The live line labelled `latest`, when there is one: on public sites it is
 * the line `/` serves anonymous visitors, instead of the public entitlements'
 * line. `release` is its live release, e.g. `0.23.1`.
 */
export interface LatestLine {
  line: string;
  release: string;
}

/** The public products and features for `version`, or nothing gated without public entitlements. */
function publicContext(repo: Repo, version: string): ReaderContext {
  const pub = repo.publicEntitlements;
  return pub ? { products: pub.products, features: pub.features, version } : NOTHING_GATED;
}

/**
 * The public set's version on `line`: the public entitlements' own version on
 * their line, and on any other line that line's live release (`release`), the
 * newest version it documents.
 */
function publicVersion(repo: Repo, line: string, release: string): string {
  const pub = repo.publicEntitlements;
  return pub && releaseLine(pub.version, repo.releaseLines) === line ? pub.version : release;
}

/**
 * Anonymous visitors of a public site, at `/`: the line labelled `latest`
 * when it is live, else the public entitlements' line, else (no public
 * entitlements) the newest line with nothing gated.
 */
export function publicAudience(repo: Repo, latest: LatestLine | null = null): Audience {
  const pub = repo.publicEntitlements;
  if (latest) {
    const context = publicContext(repo, publicVersion(repo, latest.line, latest.release));
    const key = context === NOTHING_GATED ? 'public|none' : `public|${entitlementKey(context)}`;
    return { key, context, line: latest.line };
  }
  if (!pub) return { key: 'public|none', context: NOTHING_GATED, line: null };
  const context = publicContext(repo, pub.version);
  return {
    key: `public|${entitlementKey(context)}`,
    context,
    line: releaseLine(pub.version, repo.releaseLines),
  };
}

/**
 * The line `/` serves anonymous visitors of a public site: the live `latest`
 * line, else the public entitlements' line; null when neither (then the
 * newest line, with nothing gated).
 */
export function defaultPublicLine(repo: Repo, latest: LatestLine | null = null): string | null {
  if (latest) return latest.line;
  const pub = repo.publicEntitlements;
  return pub ? releaseLine(pub.version, repo.releaseLines) : null;
}

/**
 * Anonymous visitors of one public line, under `/v/<line>/`: the public
 * products and features on that line (see `publicVersion`), so the default
 * line's pages here match `/`. The key never collides with another
 * audience's (`public|v=<line>|…`), so nothing rendered under one line's
 * prefix is served for another or for `/`.
 */
export function publicLineAudience(repo: Repo, line: string, release: string): Audience {
  const context = publicContext(repo, publicVersion(repo, line, release));
  return { key: `public|v=${line}|${entitlementKey(context)}`, context, line };
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
 *   release line: the public set opens one line (the `latest` line, or the
 *   public entitlements' line), and must not open gated content of the
 *   reader's other line. Otherwise the reader keeps their own.
 */
export function audienceFor(
  repo: Repo,
  access: ReaderAccess | null,
  latest: LatestLine | null = null,
): Audience | NoAudience {
  const lines = repo.releaseLines;
  if (access?.reader.staff) return staffAudience(access, lines);
  if (repo.access !== 'public') {
    if (!access) return 'sign-in';
    if (!access.context) return 'no-entitlements';
    return readerAudience(access.context, lines);
  }
  const own = access?.context;
  if (!own) return publicAudience(repo, latest);
  const pub = repo.publicEntitlements;
  if (!pub || defaultPublicLine(repo, latest) !== releaseLine(own.version, lines))
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

/** The filter policies and options for an audience: none for the staff view. */
export function audienceFilter(audience: Pick<Audience, 'context'>): {
  policies: FilterPolicy[];
  options: FilterTreeOptions;
} {
  return audience.context
    ? { policies: [readerPolicy(audience.context)], options: {} }
    : { policies: [], options: { resolveChoices: false } };
}

/** A live line anonymous visitors may read under `/v/<line>/`. */
export interface PublicLine {
  line: string;
  /** Its live release, e.g. `0.23.1`. */
  release: string;
  labels: string[];
  /** The line `/` serves anonymous visitors. */
  isDefault: boolean;
}
