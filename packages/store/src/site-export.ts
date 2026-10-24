import type { Db, PoolClient } from './db.js';

/**
 * Moving a site between deployments (a shared fleet to a dedicated instance):
 * everything that is not rebuilt from Git. Releases, builds and search indexes
 * are rebuilt by the target; analytics and previews stay behind. Sealed
 * secrets move as sealed values, so the target must use the same
 * OPEND_SECRET_KEY (or SESSION_SECRET) as the source.
 *
 * Tables are listed parents first; rows keep their ids.
 */
export const EXPORT_TABLES = [
  'repos',
  'release_line_labels',
  'public_release_lines',
  'orgs',
  'entitlements',
  'readers',
  'reader_identities',
  'audit_log',
  'editor_users',
  'editor_sessions',
  'editor_branches',
  'editor_audit',
  'editor_github_tokens',
  'settings',
  'secrets',
  'api_keys',
] as const;

export type SiteExport = {
  format: 'opend-site-export';
  version: 1;
  exportedAt: string;
  tables: Record<string, unknown[]>;
};

export async function exportSite(db: Db): Promise<SiteExport> {
  const tables: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    const { rows } = await db.query<{ row: unknown }>(`select to_jsonb(t) as row from ${table} t`);
    tables[table] = rows.map((r) => r.row);
  }
  return { format: 'opend-site-export', version: 1, exportedAt: new Date().toISOString(), tables };
}

export class ImportRefused extends Error {}

/** Loads an export into an empty site, inside the caller's transaction. */
export async function importSite(
  client: PoolClient,
  data: SiteExport,
): Promise<Record<string, number>> {
  if (data?.format !== 'opend-site-export' || data.version !== 1)
    throw new ImportRefused('not an OpenD site export (format opend-site-export, version 1)');
  for (const table of EXPORT_TABLES) {
    const { rows } = await client.query(`select 1 from ${table} limit 1`);
    if (rows.length) throw new ImportRefused(`the site is not empty: ${table} has rows`);
  }
  const counts: Record<string, number> = {};
  for (const table of EXPORT_TABLES) {
    const rows = data.tables[table] ?? [];
    if (!Array.isArray(rows)) throw new ImportRefused(`${table} must be an array`);
    counts[table] = rows.length;
    if (!rows.length) continue;
    await client.query(
      `insert into ${table} select * from jsonb_populate_recordset(null::${table}, $1::jsonb)`,
      [JSON.stringify(rows)],
    );
    // Rows keep their ids, so identity sequences move past them.
    const { rows: seq } = await client.query<{ seq: string | null }>(
      `select pg_get_serial_sequence($1, 'id') as seq from information_schema.columns
       where table_schema = current_schema() and table_name = $1 and column_name = 'id'`,
      [table],
    );
    if (seq[0]?.seq)
      await client.query(`select setval($1, (select max(id) from ${table}))`, [seq[0].seq]);
  }
  return counts;
}
