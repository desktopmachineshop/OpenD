import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';

/** What a key may do. `publish` and `write` imply `read`; `publish` implies `write`. */
export const API_SCOPES = ['read', 'write', 'publish', 'builds'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Whose view of the docs a key reads: everyone's (staff), one org's, or anonymous visitors'. */
export type ApiAudience = 'staff' | 'org' | 'public';

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  audience: ApiAudience;
  orgSlug: string | null;
  editorUserId: number | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const COLUMNS = `id::int as id, name, prefix, scopes, audience, org_slug as "orgSlug",
  editor_user_id::int as "editorUserId", created_by as "createdBy", created_at as "createdAt",
  expires_at as "expiresAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt"`;

const TOKEN = /^opd_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** Scopes as stored: `publish` adds `write`, and `write` or `publish` add `read`. */
export function normalizeScopes(scopes: readonly string[]): ApiScope[] {
  const set = new Set(
    scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)),
  );
  if (set.has('publish')) set.add('write');
  if (set.has('write')) set.add('read');
  return API_SCOPES.filter((s) => set.has(s));
}

/**
 * Creates a key and returns it with its token, `opd_<prefix>_<secret>`. The
 * token is not stored and cannot be shown again.
 */
export async function createApiKey(
  db: Db,
  input: {
    name: string;
    scopes: readonly string[];
    audience: ApiAudience;
    orgSlug?: string | null;
    createdBy: string;
    expiresAt?: Date | null;
  },
): Promise<{ key: ApiKey; token: string }> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const prefix = [...randomBytes(12)].map((b) => alphabet[b % alphabet.length]).join('');
  const secret = randomBytes(32).toString('base64url');
  const scopes = normalizeScopes(input.scopes);
  const { rows } = await db.query<ApiKey>(
    `insert into api_keys (name, prefix, secret_hash, scopes, audience, org_slug, created_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLUMNS}`,
    [
      input.name.trim(),
      prefix,
      hashSecret(secret),
      scopes,
      input.audience,
      input.audience === 'org' ? (input.orgSlug ?? null) : null,
      input.createdBy,
      input.expiresAt ?? null,
    ],
  );
  return { key: rows[0]!, token: `opd_${prefix}_${secret}` };
}

/**
 * The key a bearer token names, when it is genuine, not revoked and not
 * expired. Records when it was last used (at most once a minute).
 */
export async function verifyApiKey(db: Db, token: string): Promise<ApiKey | null> {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const { rows } = await db.query<ApiKey & { secretHash: string }>(
    `select ${COLUMNS}, secret_hash as "secretHash" from api_keys where prefix = $1`,
    [m[1]],
  );
  const row = rows[0];
  if (!row) return null;
  const want = Buffer.from(row.secretHash, 'hex');
  const given = Buffer.from(hashSecret(m[2]!), 'hex');
  if (!timingSafeEqual(want, given)) return null;
  if (row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000)
    await db.query(`update api_keys set last_used_at = now() where id = $1`, [row.id]);
  const { secretHash: _secret, ...key } = row;
  return key;
}

export async function listApiKeys(db: Db): Promise<ApiKey[]> {
  const { rows } = await db.query<ApiKey>(`select ${COLUMNS} from api_keys order by id`);
  return rows;
}

export async function getApiKey(db: Db, id: number): Promise<ApiKey | null> {
  const { rows } = await db.query<ApiKey>(`select ${COLUMNS} from api_keys where id = $1`, [id]);
  return rows[0] ?? null;
}

/** Revokes a key at once. Returns false when there is no such active key. */
export async function revokeApiKey(db: Db, id: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `update api_keys set revoked_at = now() where id = $1 and revoked_at is null`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** Links a key to the editor user its commits are made as. */
export async function setApiKeyEditorUser(db: Db, id: number, editorUserId: number): Promise<void> {
  await db.query(`update api_keys set editor_user_id = $2 where id = $1`, [id, editorUserId]);
}
