import type { ReleaseLines, SiteSettings } from '@opend/model';
import { CHANNELS, notify, type Db } from './db.js';
import type { Entitlements } from './readers.js';

/**
 * Who may read a site: `private` needs a signed-in, registered reader for
 * every page; `public` also serves anonymous visitors, filtered for the
 * repo's public entitlements.
 */
export type RepoAccess = 'private' | 'public';

/**
 * What the site's version picker offers readers. `off`: no picker, each reader
 * gets their own version. `reader`: their own version, shown in the header.
 * `fixed`: every reader gets `version`. `list`: readers choose among
 * `versions` (and their own). `live`: readers choose among the repo's live
 * release lines, newest first, which follow publishing and retiring with no
 * list to maintain.
 */
export type VersionPicker =
  | { mode: 'off' }
  | { mode: 'reader' }
  | { mode: 'fixed'; version: string }
  | { mode: 'list'; versions: string[] }
  | { mode: 'live' };

export { LATEST_VERSION } from '@opend/model';

/**
 * The `site:` block of the docs repository's `opend.config.yaml`, as last
 * applied by a build: the settings it declares and the build they came from.
 */
export interface DeclaredSiteSettings {
  settings: SiteSettings;
  ref: string;
  sha: string;
  release: string;
  appliedAt: string;
}

export interface Repo {
  id: number;
  fullName: string;
  sourceUrl: string;
  installationId: number | null;
  releaseRefs: string[];
  docsPath: string;
  access: RepoAccess;
  /**
   * What anonymous visitors of a public site are entitled to. `null`: nothing
   * gated, so they see only content without product, feature or release
   * conditions (fail-closed). Its `version` may be `LATEST_VERSION`.
   */
  publicEntitlements: Entitlements | null;
  /** What readers may switch between; see `VersionPicker`. */
  versionPicker: VersionPicker;
  /** How releases group into lines: by major (the default) or by minor version. */
  releaseLines: ReleaseLines;
  /**
   * Settings the docs repository declares (`site:` in `opend.config.yaml`),
   * or null. Those fields are the repository's: the admin console shows them
   * read-only and the admin API refuses to change them.
   */
  declared: DeclaredSiteSettings | null;
}

export interface RepoInput {
  fullName: string;
  sourceUrl: string;
  installationId?: number | null;
  releaseRefs?: string[];
  docsPath?: string;
}

const COLUMNS = `id, full_name as "fullName", source_url as "sourceUrl", installation_id as "installationId",
  release_refs as "releaseRefs", docs_path as "docsPath", access,
  public_entitlements as "publicEntitlements", version_picker as "versionPicker",
  release_lines as "releaseLines", site_settings as "declared"`;

export async function upsertRepo(db: Db, input: RepoInput): Promise<Repo> {
  const { rows } = await db.query<Repo>(
    `insert into repos (full_name, source_url, installation_id, release_refs, docs_path)
     values ($1, $2, $3, $4, $5)
     on conflict (full_name) do update set source_url = excluded.source_url,
       installation_id = excluded.installation_id, release_refs = excluded.release_refs,
       docs_path = excluded.docs_path,
       site_settings = case when repos.docs_path = excluded.docs_path
         then repos.site_settings else null end
     returning ${COLUMNS}`,
    [
      input.fullName,
      input.sourceUrl,
      input.installationId ?? null,
      input.releaseRefs ?? ['main'],
      input.docsPath ?? '.',
    ],
  );
  return rows[0]!;
}

/**
 * Points an existing repo row at another repository (the admin console's
 * "change the docs repository"), keeping its access settings and history.
 */
export async function updateRepo(db: Db, id: number, input: RepoInput): Promise<Repo | null> {
  const { rows } = await db.query<Repo>(
    `update repos set full_name = $2, source_url = $3, installation_id = $4, release_refs = $5,
       docs_path = $6,
       site_settings = case when lower(full_name) = lower($2) and docs_path = $6
         then site_settings else null end
     where id = $1 returning ${COLUMNS}`,
    [
      id,
      input.fullName,
      input.sourceUrl,
      input.installationId ?? null,
      input.releaseRefs ?? ['main'],
      input.docsPath ?? '.',
    ],
  );
  await notify(db, CHANNELS.releaseChanged, String(id));
  return rows[0] ?? null;
}

export async function getRepo(db: Db, id: number): Promise<Repo | null> {
  const { rows } = await db.query<Repo>(`select ${COLUMNS} from repos where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findRepoByName(db: Db, fullName: string): Promise<Repo | null> {
  const { rows } = await db.query<Repo>(
    `select ${COLUMNS} from repos where lower(full_name) = lower($1)`,
    [fullName],
  );
  return rows[0] ?? null;
}

export async function listRepos(db: Db): Promise<Repo[]> {
  const { rows } = await db.query<Repo>(`select ${COLUMNS} from repos order by id`);
  return rows;
}

/**
 * Sets who may read the repo's site. Pages are cached per entitlement set, so
 * this notifies every replica to drop its caches, as a release swap does.
 * Returns null when the repo does not exist.
 */
export async function setRepoAccess(
  db: Db,
  id: number,
  access: RepoAccess,
  publicEntitlements: Entitlements | null,
): Promise<Repo | null> {
  const { rows } = await db.query<Repo>(
    `update repos set access = $2, public_entitlements = $3 where id = $1 returning ${COLUMNS}`,
    [id, access, publicEntitlements === null ? null : JSON.stringify(publicEntitlements)],
  );
  await notify(db, CHANNELS.releaseChanged, String(id));
  return rows[0] ?? null;
}

/**
 * Sets the site's version picker. Like `setRepoAccess`, it notifies every
 * replica to drop its caches. Returns null when the repo does not exist.
 */
export async function setRepoVersionPicker(
  db: Db,
  id: number,
  picker: VersionPicker,
): Promise<Repo | null> {
  const { rows } = await db.query<Repo>(
    `update repos set version_picker = $2 where id = $1 returning ${COLUMNS}`,
    [id, JSON.stringify(picker)],
  );
  await notify(db, CHANNELS.releaseChanged, String(id));
  return rows[0] ?? null;
}

/** Sets the branch and tag patterns that publish. Returns null when the repo does not exist. */
export async function setRepoReleaseRefs(
  db: Db,
  id: number,
  releaseRefs: string[],
): Promise<Repo | null> {
  const { rows } = await db.query<Repo>(
    `update repos set release_refs = $2 where id = $1 returning ${COLUMNS}`,
    [id, releaseRefs],
  );
  return rows[0] ?? null;
}

/**
 * Records the settings the docs repository declares (or null when it
 * declares none). Notifies every replica, as the console shows them.
 */
export async function setRepoDeclaredSettings(
  db: Db,
  id: number,
  declared: DeclaredSiteSettings | null,
): Promise<Repo | null> {
  const { rows } = await db.query<Repo>(
    `update repos set site_settings = $2 where id = $1 returning ${COLUMNS}`,
    [id, declared === null ? null : JSON.stringify(declared)],
  );
  await notify(db, CHANNELS.releaseChanged, String(id));
  return rows[0] ?? null;
}

/** Whether a branch or tag name matches any release ref pattern; `*` matches any run of characters. */
export function refMatches(patterns: readonly string[], ref: string): boolean {
  return patterns.some((pattern) => {
    const re = new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    return re.test(ref);
  });
}
