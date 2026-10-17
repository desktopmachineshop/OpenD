import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  createEditorBranch,
  createEditorPreview,
  createEditorSession,
  createTestDatabase,
  findEditorUserForGitHub,
  findEditorUserForOidc,
  getActiveEditorBranch,
  getEditorPreview,
  getEditorSession,
  listEditorAudit,
  recordEditorAudit,
  revokeEditorSession,
  SecretBox,
  deleteEditorGitHubTokens,
  getEditorGitHubToken,
  putEditorGitHubToken,
  setEditorUserDisabled,
  updateEditorBranch,
  upsertEditorUser,
  upsertRepo,
  type TestDatabase,
} from '../src/index.js';
import { testDatabaseUrl } from '../src/testing.js';

const url = testDatabaseUrl();

describe('editor migration', () => {
  it('is 002_editor, right after the initial schema', () => {
    expect(MIGRATIONS.map((m) => m.id).slice(0, 2)).toEqual(['001_initial', '002_editor']);
  });
});

describe.skipIf(!url)('editor store', () => {
  let db: TestDatabase;
  let repoId: number;

  beforeAll(async () => {
    db = await createTestDatabase(url!);
    repoId = (
      await upsertRepo(db.pool, { fullName: 'acme/docs', sourceUrl: 'x', installationId: 1 })
    ).id;
  });
  afterAll(async () => {
    await db.drop();
  });

  it('keeps editors apart from readers and links sign-ins', async () => {
    const ada = await upsertEditorUser(db.pool, {
      email: 'ada@example.com',
      name: 'Ada',
      githubLogin: 'Ada-L',
    });
    const readers = await db.pool.query('select count(*)::int as n from readers');
    expect(readers.rows[0].n).toBe(0);
    const linked = await findEditorUserForGitHub(db.pool, {
      id: 7,
      login: 'ada-l',
      name: 'Ada Lovelace',
      verifiedEmail: null,
    });
    expect(linked).toMatchObject({ id: ada.id, githubId: 7, githubLogin: 'ada-l', name: 'Ada' });
    // Re-linking by email needs the email verified; a linked account wins afterwards.
    expect(
      await findEditorUserForGitHub(db.pool, {
        id: 8,
        login: 'other',
        name: null,
        verifiedEmail: null,
      }),
    ).toBeNull();
    await upsertEditorUser(db.pool, { email: 'carol@example.com' });
    expect(
      await findEditorUserForOidc(db.pool, {
        issuer: 'i',
        subject: 's',
        email: 'carol@example.com',
      }),
    ).toBeNull();
    const carol = await findEditorUserForOidc(db.pool, {
      issuer: 'i',
      subject: 's',
      email: 'CAROL@example.com',
      emailVerified: true,
      name: 'Carol',
    });
    expect(carol).toMatchObject({ email: 'carol@example.com', name: 'Carol' });
    expect(await findEditorUserForOidc(db.pool, { issuer: 'i', subject: 's' })).toMatchObject({
      id: carol!.id,
    });
  });

  it('revokes sessions on sign-out and when an editor is disabled', async () => {
    const user = await upsertEditorUser(db.pool, { email: 'dan@example.com' });
    const a = await createEditorSession(db.pool, user.id, 'oidc', 12);
    const b = await createEditorSession(db.pool, user.id, 'oidc', 12);
    expect((await getEditorSession(db.pool, a.id))?.user.email).toBe('dan@example.com');
    await revokeEditorSession(db.pool, a.id);
    expect(await getEditorSession(db.pool, a.id)).toBeNull();
    expect(await getEditorSession(db.pool, b.id)).not.toBeNull();
    await setEditorUserDisabled(db.pool, 'dan@example.com', true);
    expect(await getEditorSession(db.pool, b.id)).toBeNull();
    const expired = await createEditorSession(
      db.pool,
      (await upsertEditorUser(db.pool, { email: 'e@example.com' })).id,
      'github',
      0,
    );
    expect(await getEditorSession(db.pool, expired.id)).toBeNull();
  });

  it('allows one active branch per author and records audit rows', async () => {
    const user = await upsertEditorUser(db.pool, { email: 'fay@example.com' });
    const input = {
      repoId,
      userId: user.id,
      branch: 'editor/x/a',
      baseBranch: 'main',
      headSha: 'a'.repeat(40),
    };
    const first = await createEditorBranch(db.pool, input);
    expect(first).toMatchObject({ status: 'active', prNumber: null });
    expect(await createEditorBranch(db.pool, { ...input, branch: 'editor/x/b' })).toBeNull();
    await updateEditorBranch(db.pool, first!.id, { prNumber: 4 });
    expect((await getActiveEditorBranch(db.pool, repoId, user.id))?.prNumber).toBe(4);
    await updateEditorBranch(db.pool, first!.id, { status: 'merged' });
    expect(await getActiveEditorBranch(db.pool, repoId, user.id)).toBeNull();
    expect(await createEditorBranch(db.pool, { ...input, branch: 'editor/x/b' })).not.toBeNull();

    await recordEditorAudit(db.pool, {
      sessionId: 's1',
      userId: user.id,
      repoId,
      branch: 'editor/x/a',
      action: 'publish',
      commitSha: 'a'.repeat(40),
      prNumber: 4,
    });
    expect((await listEditorAudit(db.pool, { userId: user.id }))[0]).toMatchObject({
      sessionId: 's1',
      action: 'publish',
      prNumber: 4,
      email: 'fay@example.com',
    });
  });

  it('stores preview contexts with an expiry', async () => {
    const user = await upsertEditorUser(db.pool, { email: 'gus@example.com' });
    const preview = await createEditorPreview(db.pool, {
      userId: user.id,
      sessionId: 's',
      repoId,
      orgSlug: 'acme',
      context: { org: 'acme', products: ['widget'], features: [], version: '2.1' },
      commitSha: 'b'.repeat(40),
      minutes: 30,
    });
    const found = await getEditorPreview(db.pool, preview.id);
    expect(found?.context.products).toEqual(['widget']);
    expect(found!.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
  });

  it('seals GitHub user tokens per session and opens them only with the same key', async () => {
    const user = await upsertEditorUser(db.pool, { email: 'hal@example.com' });
    const session = await createEditorSession(db.pool, user.id, 'github', 1);
    const other = await createEditorSession(db.pool, user.id, 'github', 1);
    const box = new SecretBox(Buffer.alloc(32, 7));
    const grant = {
      accessToken: 'ghu_secret-access',
      refreshToken: 'ghr_secret-refresh',
      expiresIn: 28_800,
      refreshTokenExpiresIn: 15_897_600,
    };
    await putEditorGitHubToken(db.pool, box, {
      sessionId: session.id,
      userId: user.id,
      githubId: 9,
      githubLogin: 'hal',
      grant,
    });
    const { rows } = await db.pool.query('select * from editor_github_tokens');
    expect(JSON.stringify(rows)).not.toContain('secret-access');
    expect(JSON.stringify(rows)).not.toContain('secret-refresh');
    const found = await getEditorGitHubToken(db.pool, box, session.id);
    expect(found).toMatchObject({ accessToken: grant.accessToken, githubLogin: 'hal' });
    expect(found!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(7 * 3600_000);
    // Bound to its session: copied to another session's row, it does not open.
    await db.pool.query(
      `insert into editor_github_tokens (session_id, user_id, github_id, github_login, access_sealed, key_id)
       select $1, user_id, github_id, github_login, access_sealed, key_id from editor_github_tokens
       where session_id = $2`,
      [other.id, session.id],
    );
    expect(await getEditorGitHubToken(db.pool, box, other.id)).toBeNull();
    // Another key cannot open it, and the unreadable row is dropped.
    expect(
      await getEditorGitHubToken(db.pool, new SecretBox(Buffer.alloc(32, 8)), session.id),
    ).toBeNull();
    expect(await deleteEditorGitHubTokens(db.pool, { userId: user.id })).toBe(0);
    await putEditorGitHubToken(db.pool, box, {
      sessionId: session.id,
      userId: user.id,
      githubId: 9,
      githubLogin: 'hal',
      grant: { accessToken: 'ghu_plain' },
    });
    await revokeEditorSession(db.pool, session.id);
    expect(await getEditorGitHubToken(db.pool, box, session.id)).toBeNull();
    expect((await db.pool.query('select 1 from editor_github_tokens')).rowCount).toBe(0);
  });
});
