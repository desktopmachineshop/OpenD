import type { Db } from './db.js';

export interface Repo {
  id: number;
  fullName: string;
  sourceUrl: string;
  installationId: number | null;
  releaseRefs: string[];
  docsPath: string;
}

export interface RepoInput {
  fullName: string;
  sourceUrl: string;
  installationId?: number | null;
  releaseRefs?: string[];
  docsPath?: string;
}

const COLUMNS = `id, full_name as "fullName", source_url as "sourceUrl", installation_id as "installationId",
  release_refs as "releaseRefs", docs_path as "docsPath"`;

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
