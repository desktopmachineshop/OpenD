import { randomBytes } from 'node:crypto';
import type { ReaderContext } from '@opend/model';
import type { Db } from './db.js';

/** A web editor account. Separate from readers: see migration `002_editor`. */
export interface EditorUser {
  id: number;
  email: string;
  name: string;
  githubId: number | null;
  githubLogin: string | null;
  disabled: boolean;
}

const USER_COLUMNS = `u.id, u.email, u.name, u.github_id as "githubId", u.github_login as "githubLogin",
  u.disabled`;

/** Registers (or updates) an editor by email, optionally with their GitHub login. */
export async function upsertEditorUser(
  db: Db,
  user: { email: string; name?: string | null; githubLogin?: string | null },
): Promise<EditorUser> {
  const { rows } = await db.query<EditorUser>(
    `insert into editor_users as u (email, name, github_login) values ($1, coalesce($2, ''), $3)
     on conflict ((lower(email))) do update set
       name = case when excluded.name = '' then u.name else excluded.name end,
       github_login = coalesce(excluded.github_login, u.github_login), disabled = false
     returning ${USER_COLUMNS}`,
    [user.email.trim(), user.name ?? null, user.githubLogin ?? null],
  );
  return rows[0]!;
}

export async function setEditorUserDisabled(
  db: Db,
  email: string,
  disabled: boolean,
): Promise<boolean> {
  const { rowCount } = await db.query(
    'update editor_users set disabled = $2 where lower(email) = lower($1)',
    [email.trim(), disabled],
  );
  if (disabled) {
    await db.query(
      `update editor_sessions set revoked_at = now() where revoked_at is null and user_id in
         (select id from editor_users where lower(email) = lower($1))`,
      [email.trim()],
    );
  }
  return rowCount === 1;
}

export async function listEditorUsers(db: Db): Promise<EditorUser[]> {
  const { rows } = await db.query<EditorUser>(
    `select ${USER_COLUMNS} from editor_users u order by lower(u.email)`,
  );
  return rows;
}

export async function getEditorUser(db: Db, id: number): Promise<EditorUser | null> {
  const { rows } = await db.query<EditorUser>(
    `select ${USER_COLUMNS} from editor_users u where u.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface GitHubLogin {
  id: number;
  login: string;
  name: string | null;
  /** The account's primary email, only when GitHub reports it verified. */
  verifiedEmail: string | null;
}

/**
 * The editor for a GitHub sign-in: an account already linked to this GitHub
 * id, else one an admin registered with this login or verified email (linked
 * now). Returns null for unknown people; the caller may then provision them.
 */
export async function findEditorUserForGitHub(
  db: Db,
  login: GitHubLogin,
): Promise<EditorUser | null> {
  const linked = await db.query<EditorUser>(
    `select ${USER_COLUMNS} from editor_users u where u.github_id = $1`,
    [login.id],
  );
  if (linked.rows[0]) return linked.rows[0];
  const { rows } = await db.query<EditorUser>(
    `update editor_users u set github_id = $1, github_login = $2,
       name = case when u.name = '' then coalesce($4, '') else u.name end
     where u.id = (
       select id from editor_users where github_id is null
         and (lower(github_login) = lower($2) or ($3::text is not null and lower(email) = lower($3)))
       order by (lower(github_login) = lower($2)) desc nulls last limit 1)
     returning ${USER_COLUMNS}`,
    [login.id, login.login, login.verifiedEmail, login.name],
  );
  return rows[0] ?? null;
}

/** Creates an editor for a GitHub account the repository already trusts with write access. */
export async function createEditorUserFromGitHub(
  db: Db,
  login: GitHubLogin,
  email: string,
): Promise<EditorUser> {
  const { rows } = await db.query<EditorUser>(
    `insert into editor_users as u (email, name, github_id, github_login) values ($1, $2, $3, $4)
     returning ${USER_COLUMNS}`,
    [email, login.name ?? login.login, login.id, login.login],
  );
  return rows[0]!;
}

/**
 * The editor for a company OIDC sign-in: linked by issuer and subject, else a
 * registered, verified email (linked now). Unverified emails never match.
 */
export async function findEditorUserForOidc(
  db: Db,
  login: {
    issuer: string;
    subject: string;
    email?: string;
    emailVerified?: boolean;
    name?: string;
  },
): Promise<EditorUser | null> {
  const linked = await db.query<EditorUser>(
    `select ${USER_COLUMNS} from editor_users u where oidc_issuer = $1 and oidc_subject = $2`,
    [login.issuer, login.subject],
  );
  if (linked.rows[0]) return linked.rows[0];
  if (!login.email || login.emailVerified !== true) return null;
  const { rows } = await db.query<EditorUser>(
    `update editor_users u set oidc_issuer = $1, oidc_subject = $2,
       name = case when u.name = '' then coalesce($4, '') else u.name end
     where lower(email) = lower($3) and oidc_subject is null
     returning ${USER_COLUMNS}`,
    [login.issuer, login.subject, login.email, login.name ?? null],
  );
  return rows[0] ?? null;
}

export interface EditorSession {
  id: string;
  userId: number;
  provider: 'github' | 'oidc';
  expiresAt: Date;
}

export async function createEditorSession(
  db: Db,
  userId: number,
  provider: EditorSession['provider'],
  hours: number,
): Promise<EditorSession> {
  const id = randomBytes(24).toString('base64url');
  const { rows } = await db.query<EditorSession>(
    `insert into editor_sessions (id, user_id, provider, expires_at)
     values ($1, $2, $3, now() + make_interval(hours => $4))
     returning id, user_id as "userId", provider, expires_at as "expiresAt"`,
    [id, userId, provider, hours],
  );
  return rows[0]!;
}

/** A live session and its user: not expired, not revoked, and the user not disabled. */
export async function getEditorSession(
  db: Db,
  id: string,
): Promise<{ session: EditorSession; user: EditorUser } | null> {
  const { rows } = await db.query<
    EditorUser & { sessionId: string; provider: EditorSession['provider']; expiresAt: Date }
  >(
    `select ${USER_COLUMNS}, s.id as "sessionId", s.provider, s.expires_at as "expiresAt"
     from editor_sessions s join editor_users u on u.id = s.user_id
     where s.id = $1 and s.revoked_at is null and s.expires_at > now() and not u.disabled`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const { sessionId, provider, expiresAt, ...user } = row;
  return { session: { id: sessionId, userId: user.id, provider, expiresAt }, user };
}

export async function revokeEditorSession(db: Db, id: string): Promise<void> {
  await db.query('update editor_sessions set revoked_at = now() where id = $1', [id]);
}

export interface EditorBranch {
  id: number;
  repoId: number;
  userId: number;
  branch: string;
  baseBranch: string;
  headSha: string | null;
  prNumber: number | null;
  status: 'active' | 'merged' | 'abandoned';
}

const BRANCH_COLUMNS = `id, repo_id as "repoId", user_id as "userId", branch, base_branch as "baseBranch",
  head_sha as "headSha", pr_number as "prNumber", status`;

/** The author's working branch in a repository, if they have one. */
export async function getActiveEditorBranch(
  db: Db,
  repoId: number,
  userId: number,
): Promise<EditorBranch | null> {
  const { rows } = await db.query<EditorBranch>(
    `select ${BRANCH_COLUMNS} from editor_branches
     where repo_id = $1 and user_id = $2 and status = 'active'`,
    [repoId, userId],
  );
  return rows[0] ?? null;
}

export async function findEditorBranch(
  db: Db,
  repoId: number,
  branch: string,
): Promise<EditorBranch | null> {
  const { rows } = await db.query<EditorBranch>(
    `select ${BRANCH_COLUMNS} from editor_branches where repo_id = $1 and branch = $2`,
    [repoId, branch],
  );
  return rows[0] ?? null;
}

/**
 * Registers a new working branch. Returns null when the author already has an
 * active one (another request won the race); the caller re-reads it.
 */
export async function createEditorBranch(
  db: Db,
  input: { repoId: number; userId: number; branch: string; baseBranch: string; headSha: string },
): Promise<EditorBranch | null> {
  const { rows } = await db.query<EditorBranch>(
    `insert into editor_branches (repo_id, user_id, branch, base_branch, head_sha)
     values ($1, $2, $3, $4, $5) on conflict do nothing returning ${BRANCH_COLUMNS}`,
    [input.repoId, input.userId, input.branch, input.baseBranch, input.headSha],
  );
  return rows[0] ?? null;
}

export async function updateEditorBranch(
  db: Db,
  id: number,
  patch: { headSha?: string; prNumber?: number | null; status?: EditorBranch['status'] },
): Promise<void> {
  await db.query(
    `update editor_branches set
       head_sha = coalesce($2, head_sha),
       pr_number = case when $3::boolean then $4 else pr_number end,
       status = coalesce($5, status),
       updated_at = now()
     where id = $1`,
    [
      id,
      patch.headSha ?? null,
      patch.prNumber !== undefined,
      patch.prNumber ?? null,
      patch.status ?? null,
    ],
  );
}

export type EditorAction =
  | 'sign_in'
  | 'sign_out'
  | 'save'
  | 'sync'
  | 'resolve'
  | 'publish'
  | 'merge'
  | 'escalate'
  | 'preview_as';

export interface EditorAuditEntry {
  sessionId: string | null;
  userId: number | null;
  repoId?: number | null;
  branch?: string | null;
  action: EditorAction;
  commitSha?: string | null;
  prNumber?: number | null;
  detail?: object;
}

export async function recordEditorAudit(db: Db, entry: EditorAuditEntry): Promise<void> {
  await db.query(
    `insert into editor_audit (session_id, user_id, repo_id, branch, action, commit_sha, pr_number, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.sessionId,
      entry.userId,
      entry.repoId ?? null,
      entry.branch ?? null,
      entry.action,
      entry.commitSha ?? null,
      entry.prNumber ?? null,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
}

export interface EditorAuditRow extends Required<Omit<EditorAuditEntry, 'detail'>> {
  id: number;
  at: Date;
  email: string | null;
  detail: Record<string, unknown>;
}

export async function listEditorAudit(
  db: Db,
  options: { userId?: number; limit?: number } = {},
): Promise<EditorAuditRow[]> {
  const { rows } = await db.query<EditorAuditRow>(
    `select a.id, a.at, a.session_id as "sessionId", a.user_id as "userId", a.repo_id as "repoId",
       a.branch, a.action, a.commit_sha as "commitSha", a.pr_number as "prNumber", a.detail,
       u.email
     from editor_audit a left join editor_users u on u.id = a.user_id
     where ($1::bigint is null or a.user_id = $1)
     order by a.id desc limit $2`,
    [options.userId ?? null, options.limit ?? 100],
  );
  return rows;
}

export interface EditorPreview {
  id: string;
  userId: number;
  sessionId: string;
  repoId: number;
  orgSlug: string;
  context: ReaderContext;
  commitSha: string;
  expiresAt: Date;
}

const PREVIEW_COLUMNS = `id, user_id as "userId", session_id as "sessionId", repo_id as "repoId",
  org_slug as "orgSlug", context, commit_sha as "commitSha", expires_at as "expiresAt"`;

export async function createEditorPreview(
  db: Db,
  input: Omit<EditorPreview, 'id' | 'expiresAt'> & { minutes: number },
): Promise<EditorPreview> {
  const { rows } = await db.query<EditorPreview>(
    `insert into editor_previews (id, user_id, session_id, repo_id, org_slug, context, commit_sha, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8))
     returning ${PREVIEW_COLUMNS}`,
    [
      randomBytes(18).toString('base64url'),
      input.userId,
      input.sessionId,
      input.repoId,
      input.orgSlug,
      JSON.stringify(input.context),
      input.commitSha,
      input.minutes,
    ],
  );
  return rows[0]!;
}

/** A preview context by id, expired or not; callers check `expiresAt` and the owner. */
export async function getEditorPreview(db: Db, id: string): Promise<EditorPreview | null> {
  const { rows } = await db.query<EditorPreview>(
    `select ${PREVIEW_COLUMNS} from editor_previews where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
