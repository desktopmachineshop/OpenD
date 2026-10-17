import { CHANNELS, notify, type Db } from './db.js';
import type { Entitlements } from './readers.js';

/**
 * Who may read a site: `private` needs a signed-in, registered reader for
 * every page; `public` also serves anonymous visitors, filtered for the
 * repo's public entitlements.
 */
export type RepoAccess = 'private' | 'public';

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
   * conditions (fail-closed).
   */
  publicEntitlements: Entitlements | null;
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
  public_entitlements as "publicEntitlements"`;

export async function upsertRepo(db: Db, input: RepoInput): Promise<Repo> {
  const { rows } = await db.query<Repo>(
    `insert into repos (full_name, source_url, installation_id, release_refs, docs_path)
     values ($1, $2, $3, $4, $5)
     on conflict (full_name) do update set source_url = excluded.source_url,
       installation_id = excluded.installation_id, release_refs = excluded.release_refs,
       docs_path = excluded.docs_path
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
       docs_path = $6 where id = $1 returning ${COLUMNS}`,
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
