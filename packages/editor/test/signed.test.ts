import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  deriveSecretKey,
  listEditorAudit,
  setEditorUserDisabled,
  testDatabaseUrl,
  upsertEditorUser,
} from '@opend/store';
import { GITHUB_COMMITTER, SIGNED_COMMITS_REQUIRED, SIGN_IN_AGAIN } from '../src/index.js';
import {
  ADA,
  REPO,
  api,
  form,
  page,
  signInGitHub,
  signInOidc,
  startEditor,
  type Harness,
  type Session,
} from './helpers.js';

const url = testDatabaseUrl();
const INSTALL = 'topics/install.dita';
const DOWNLOAD = '<cmd>Download the installer from <xref keyref="support-site"/>.</cmd>';
const ADA_IDENTITY = { name: 'Ada Lovelace', email: '101+ada@users.noreply.github.com' };

describe.skipIf(!url)('signed commits from the web editor', () => {
  let h: Harness;
  let logs: Record<string, unknown>[];
  /** Every editor response in a test, to check that no token ever appears. */
  let responses: LightMyRequestResponse[];

  const original = (path = INSTALL) => h.gh.readFile(REPO, 'main', path)!;
  const keep = <T extends LightMyRequestResponse>(res: T): T => {
    responses.push(res);
    return res;
  };
  const save = async (session: Session, content: string, extra: Record<string, unknown> = {}) =>
    keep(await api(h, session, 'POST', '/save', { path: INSTALL, content, ...extra }));
  const view = async (session: Session, path: string) => keep(await page(h, session, path));
  const signIn = async (user: typeof ADA) => {
    const res = keep(await signInGitHub(h, user));
    return res.session!;
  };
  /** Classic protection on main and a ruleset on the editor's branches both require signatures. */
  const requireSigned = () => {
    h.gh.setProtection(REPO, 'main', { required_signatures: { enabled: true } });
    h.gh.setRulesets(REPO, 'editor/**', [{ type: 'required_signatures' }]);
  };
  /** Commits on a branch that `since` (an earlier main head) does not have. */
  const branchCommits = (branch: string, since: string) => {
    const old = new Set<string>();
    const walk = (sha: string, into: Set<string>) => {
      const queue = [sha];
      while (queue.length) {
        const next = queue.shift()!;
        if (into.has(next)) continue;
        into.add(next);
        queue.push(...h.gh.commit(next).parents);
      }
    };
    walk(since, old);
    const all = new Set<string>();
    walk(h.gh.branch(REPO, branch)!, all);
    return [...all].filter((c) => !old.has(c)).map((c) => h.gh.commit(c));
  };
  const writesSince = (index: number) =>
    h.gh.calls.slice(index).filter((c) => c.method !== 'GET' && c.path.startsWith('/repos/'));

  beforeEach(async () => {
    logs = [];
    responses = [];
    h = await startEditor(url!, {
      config: {
        secretKey: deriveSecretKey({ secretKey: 'signed-commits-test-key-0123456789abcdef' }),
        githubOAuth: {
          clientId: 'Iv1.acme-docs',
          clientSecret: 'csecret',
          webUrl: 'https://github.test',
          apiUrl: 'https://api.github.test',
        },
      },
      oidc: {
        carol: {
          issuer: 'https://idp.test',
          subject: 'c-1',
          email: 'carol@example.com',
          emailVerified: true,
          name: 'Carol Writer',
        },
      },
      log: (entry) => logs.push(entry),
      gh: (gh) => {
        gh.expiringUserTokens = true;
      },
    });
    h.gh.setCollaborator(REPO, ADA.login, 'write');
  });

  afterEach(async () => {
    // Whatever happened, no token reached a response or a log line.
    const tokens = h.gh.issuedTokens;
    const seen = [
      ...responses.map((r) => `${JSON.stringify(r.headers)}\n${r.body}`),
      ...logs.map((l) => JSON.stringify(l)),
    ].join('\n');
    for (const token of tokens) expect(seen).not.toContain(token);
    await h.close();
  });

  it('commits as the GitHub-signed-in author through createCommitOnBranch, signed by GitHub', async () => {
    requireSigned();
    const ada = await signIn(ADA);
    const edit = await view(ada, `/edit?path=${encodeURIComponent(INSTALL)}`);
    expect(edit.body).toContain('Commits as <strong>@ada</strong>');
    expect(edit.body).toContain('Verified by GitHub');
    expect(edit.body).toContain('Signed commits required');
    const main = h.gh.branch(REPO, 'main')!;
    const before = h.gh.calls.length;

    const content = original().replace(DOWNLOAD, '<cmd>Download the new installer.</cmd>');
    const res = await save(ada, content, { message: 'Clarify the download step' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const commit = h.gh.commit(body.sha);
    expect(commit).toMatchObject({
      signed: true,
      author: ADA_IDENTITY,
      committer: GITHUB_COMMITTER,
      parents: [main],
    });
    expect(commit.message).toBe('Clarify the download step\n\nSaved in the OpenD web editor.');
    expect(h.gh.readFile(REPO, body.branch, INSTALL)).toBe(content);
    // Every write was made with Ada's own token; none through the git data API.
    const writes = writesSince(before);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(['POST /repos/acme/docs/git/refs']);
    expect(writes.every((w) => w.as === 'ada')).toBe(true);
    expect(h.gh.calls.slice(before)).toContainEqual({
      method: 'POST',
      path: '/graphql',
      as: 'ada',
    });
    const audit = (await listEditorAudit(h.db.pool)).find((a) => a.action === 'save')!;
    expect(audit.detail).toMatchObject({ files: [INSTALL], via: 'user' });

    // The branch moved between reading it and committing: a stale save, nothing lost.
    h.gh.beforeNextGraphql(() =>
      h.gh.push(REPO, body.branch, { 'topics/elsewhere.dita': '<topic id="x"/>' }),
    );
    const stale = await save(ada, content.replace('new installer', 'newest installer'), {
      branch: body.branch,
      expectSha: body.fileSha,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ stale: true });
    expect(stale.json().error).toContain('changed since you opened it');
    expect(h.gh.readFile(REPO, body.branch, INSTALL)).toBe(content);
  });

  it('publishes with merges GitHub makes and signs: update-branch, then squash', async () => {
    requireSigned();
    const ada = await signIn(ADA);
    const content = original().replace(DOWNLOAD, '<cmd>Signed change.</cmd>');
    const saved = (await save(ada, content)).json();
    const mainBefore = h.gh.branch(REPO, 'main')!;
    h.gh.push(REPO, 'main', {
      'topics/configure.dita': original('topics/configure.dita').replace(
        '</title>',
        ' (updated)</title>',
      ),
    });
    // Without a pull request there is nothing to update yet: the branch just stays behind.
    const home = await view(ada, '/');
    expect(home.body).toContain('GitHub merges them into your branch when you publish');
    expect(h.gh.branch(REPO, saved.branch)).toBe(saved.sha);

    const before = h.gh.calls.length;
    const res = keep(await api(h, ada, 'POST', '/publish', {}));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pr: 1, created: true, merged: true });
    const writes = writesSince(before).map((w) => `${w.as} ${w.method} ${w.path}`);
    expect(writes).toEqual([
      'ada POST /repos/acme/docs/pulls',
      'ada PUT /repos/acme/docs/pulls/1/update-branch',
      'ada PUT /repos/acme/docs/pulls/1/merge',
    ]);
    expect(h.gh.pulls(REPO)[0]).toMatchObject({ openedBy: 'ada', merged: true, draft: false });
    expect(h.gh.readFile(REPO, 'main', INSTALL)).toBe(content);
    expect(h.gh.readFile(REPO, 'main', 'topics/configure.dita')).toContain('(updated)');
    const squash = h.gh.commit(h.gh.branch(REPO, 'main')!);
    expect(squash).toMatchObject({ signed: true, committer: GITHUB_COMMITTER });
    const commits = branchCommits(saved.branch, mainBefore);
    expect(commits.filter((c) => c.parents.length === 2)).toHaveLength(1);
    // The developer's commit on main is not the editor's; everything the editor made is signed.
    expect(
      commits.filter((c) => c.author.name !== 'Dev').every((c) => c.signed),
      JSON.stringify(commits),
    ).toBe(true);
  });

  it('merges line by line on signed repositories without an unsigned commit', async () => {
    requireSigned();
    const ada = await signIn(ADA);
    const base = original();
    const saved = (await save(ada, base.replace(DOWNLOAD, '<cmd>Mine.</cmd>'))).json();
    const mainBefore = h.gh.branch(REPO, 'main')!;
    h.gh.push(REPO, 'main', {
      [INSTALL]: base.replace('<p>The hub is installed.', '<p>The hub is now installed.'),
    });
    const res = keep(await api(h, ada, 'POST', '/publish', {}));
    expect(res.json()).toMatchObject({ merged: true });
    const text = original();
    expect(text).toContain('<cmd>Mine.</cmd>');
    expect(text).toContain('The hub is now installed.');
    const mine = branchCommits(saved.branch, mainBefore).filter((c) => c.author.name !== 'Dev');
    expect(mine.length).toBe(4); // save, take main's version, GitHub's merge, line-by-line merge
    expect(mine.every((c) => c.signed)).toBe(true);
    expect(h.gh.requests).not.toContain('POST /repos/acme/docs/merges');
    expect(h.gh.requests).not.toContain('POST /repos/acme/docs/git/commits');
  });

  it('resolves conflicts on signed repositories with only GitHub-signed commits', async () => {
    requireSigned();
    const ada = await signIn(ADA);
    const base = original();
    const mine = base.replace(DOWNLOAD, '<cmd>Download from the portal.</cmd>');
    const theirs = base.replace(DOWNLOAD, '<cmd>Download from the mirror.</cmd>');
    const saved = (await save(ada, mine)).json();
    const mainBefore = h.gh.branch(REPO, 'main')!;
    h.gh.push(REPO, 'main', { [INSTALL]: theirs });
    const next = await save(ada, mine.replace('portal', 'customer portal'), {
      branch: saved.branch,
    });
    expect(next.json().sync).toBe('conflict');

    const conflicts = await view(ada, '/conflicts');
    expect(conflicts.body).toContain('GitHub merges the current version into your branch');
    const oursSha = /name="oursSha" value="([0-9a-f]+)"/.exec(conflicts.body)![1]!;
    const theirsSha = /name="theirsSha" value="([0-9a-f]+)"/.exec(conflicts.body)![1]!;
    const res = keep(
      await form(h, ada, '/conflicts/resolve', {
        branch: saved.branch,
        oursSha,
        theirsSha,
        'path.0': INSTALL,
        'take.0': 'manual',
        'content.0': mine.replace('portal', 'portal or the mirror'),
      }),
    );
    expect(res.statusCode).toBe(302);
    // update-branch needs a pull request: a draft one, opened by Ada.
    expect(h.gh.pulls(REPO)).toMatchObject([{ number: 1, draft: true, openedBy: 'ada' }]);
    expect(h.gh.readFile(REPO, saved.branch, INSTALL)).toContain(
      'Download from the portal or the mirror.',
    );
    const commits = branchCommits(saved.branch, mainBefore).filter((c) => c.author.name !== 'Dev');
    expect(commits.every((c) => c.signed)).toBe(true);
    const merge = commits.find((c) => c.parents.length === 2)!;
    expect(merge.committer).toEqual(GITHUB_COMMITTER);
    const head = h.gh.commit(h.gh.branch(REPO, saved.branch)!);
    expect(head.message).toContain(`- ${INSTALL}: edited by hand`);
    expect(h.gh.requests).not.toContain('POST /repos/acme/docs/merges');
    expect(h.gh.requests).not.toContain('POST /repos/acme/docs/git/commits');
    const audit = (await listEditorAudit(h.db.pool)).find((a) => a.action === 'resolve')!;
    expect(audit.detail).toMatchObject({ signed: true, via: 'user' });
    expect((await view(ada, '/conflicts')).body).toContain('No conflicts');

    // Publishing marks the draft ready and GitHub squash-merges it.
    const published = keep(await api(h, ada, 'POST', '/publish', {}));
    expect(published.json()).toMatchObject({ pr: 1, created: false, merged: true });
    expect(original()).toContain('portal or the mirror');
  });

  it('refuses company sign-in authors on signed repositories, before any write', async () => {
    await upsertEditorUser(h.db.pool, { email: 'carol@example.com' });
    const carol = keep(await signInOidc(h, 'carol')).session!;
    // A repository without the requirement: the app commits on Carol's behalf, as before.
    const content = original().replace(DOWNLOAD, '<cmd>Carol.</cmd>');
    const saved = (await save(carol, content)).json();
    const commit = h.gh.commit(saved.sha);
    expect(commit.signed).toBe(false);
    expect(commit.author).toEqual({ name: 'Carol Writer', email: 'carol@example.com' });
    expect(commit.message).toContain('Co-authored-by: Carol Writer <carol@example.com>');
    expect((await view(carol, '/')).body).toContain('Commits as the OpenD app on your behalf');

    requireSigned();
    const before = h.gh.calls.length;
    const edit = await view(carol, `/edit?path=${encodeURIComponent(INSTALL)}`);
    expect(edit.statusCode).toBe(200);
    expect(edit.body).toContain(SIGNED_COMMITS_REQUIRED);
    expect(edit.body).toContain(
      '<a class="ed-button" href="/auth/github?returnTo=%2Fedit%3Fpath%3Dtopics%252Finstall.dita">Sign in with GitHub</a>',
    );
    expect(edit.body).toMatch(/<button type="submit" disabled[^>]*>Save<\/button>/);
    const refused = await save(carol, content.replace('Carol.', 'Carol again.'), {
      branch: saved.branch,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: SIGNED_COMMITS_REQUIRED,
      signedCommitsRequired: true,
      signInUrl: '/auth/github?returnTo=%2F',
    });
    const publish = keep(await api(h, carol, 'POST', '/publish', {}));
    expect(publish.statusCode).toBe(403);
    expect(publish.json().error).toBe(SIGNED_COMMITS_REQUIRED);
    const created = keep(
      await form(h, carol, '/new', { title: 'X', name: 'x', dir: 'topics', type: 'task', map: '' }),
    );
    expect(created.statusCode).toBe(403);
    expect((await view(carol, '/publish')).body).not.toContain('action="/publish"');
    expect(writesSince(before)).toEqual([]);
    expect(h.gh.branch(REPO, saved.branch)).toBe(saved.sha);
  });

  it('commits as the author on repositories without the requirement too', async () => {
    const ada = await signIn(ADA);
    const saved = (await save(ada, original().replace(DOWNLOAD, '<cmd>Mine.</cmd>'))).json();
    expect(h.gh.commit(saved.sha)).toMatchObject({ signed: true, author: ADA_IDENTITY });
    expect((await view(ada, '/')).body).not.toContain('Signed commits required');
    // Merging main in stays a plain merge, made with Ada's token.
    h.gh.push(REPO, 'main', { 'topics/configure.dita': '<concept id="configure"/>' });
    const before = h.gh.calls.length;
    await view(ada, '/');
    expect(writesSince(before)).toEqual([
      { method: 'POST', path: '/repos/acme/docs/merges', as: 'ada' },
    ]);
  });

  it('refreshes an expired GitHub token and keeps working', async () => {
    const ada = await signIn(ADA);
    const [first] = h.gh.liveUserTokens('ada');
    h.gh.expireUserTokens('ada');
    await h.db.pool.query(
      "update editor_github_tokens set expires_at = now() - interval '1 minute'",
    );
    const res = await save(ada, original().replace(DOWNLOAD, '<cmd>After refresh.</cmd>'));
    expect(res.statusCode).toBe(200);
    expect(h.gh.commit(res.json().sha).author).toEqual(ADA_IDENTITY);
    const live = h.gh.liveUserTokens('ada');
    expect(live).toHaveLength(1);
    expect(live[0]).not.toBe(first);
    expect(h.gh.requests.filter((r) => r === 'POST /login/oauth/access_token')).toHaveLength(2);
    const { rows } = await h.db.pool.query(
      "select expires_at > now() + interval '7 hours' as fresh from editor_github_tokens",
    );
    expect(rows).toEqual([{ fresh: true }]);
    // A second save uses the new token without refreshing again.
    await save(ada, original().replace(DOWNLOAD, '<cmd>Again.</cmd>'), {
      branch: res.json().branch,
    });
    expect(h.gh.requests.filter((r) => r === 'POST /login/oauth/access_token')).toHaveLength(2);
  });

  it('asks the author to sign in again when GitHub revoked the token', async () => {
    requireSigned();
    const ada = await signIn(ADA);
    h.gh.revokeUserTokens('ada');
    const res = await save(ada, original().replace(DOWNLOAD, '<cmd>Revoked.</cmd>'));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: SIGN_IN_AGAIN, githubSignIn: true });
    expect((await h.db.pool.query('select 1 from editor_github_tokens')).rowCount).toBe(0);
    // Now Ada has no token on a signed repository: blocked, with a way back.
    const home = await view(ada, '/');
    expect(home.body).toContain(SIGNED_COMMITS_REQUIRED);
    expect(home.body).toContain('Sign in with GitHub again');
    const again = await signIn(ADA);
    expect((await view(again, '/')).body).toContain('Commits as <strong>@ada</strong>');
  });

  it('explains when the author’s GitHub account may not write to the repository', async () => {
    const eve = { id: 300, login: 'eve', name: 'Eve', email: 'eve@example.com' };
    h.gh.setCollaborator(REPO, 'eve', 'read');
    await upsertEditorUser(h.db.pool, {
      email: 'eve@example.com',
      name: 'Eve',
      githubLogin: 'eve',
    });
    const session = await signIn(eve);
    const before = h.gh.calls.length;
    const res = await save(session, original().replace(DOWNLOAD, '<cmd>Eve.</cmd>'));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ noWriteAccess: true });
    expect(res.json().error).toBe(
      'GitHub does not let @eve write to acme/docs. Ask a maintainer of the repository for write access, then try again.',
    );
    // Only Eve's own token tried to write (and GitHub refused it).
    expect(writesSince(before).filter((c) => c.as !== 'eve')).toEqual([]);
    expect(h.gh.branch(REPO, 'main')).toBeDefined();
    expect((await h.db.pool.query('select 1 from editor_branches')).rowCount).toBe(0);
  });

  it('seals tokens at rest, keeps them out of the audit and deletes them on sign-out', async () => {
    const ada = await signIn(ADA);
    await save(ada, original().replace(DOWNLOAD, '<cmd>Sealed.</cmd>'));
    keep(await api(h, ada, 'POST', '/publish', {}));
    await view(ada, '/activity');
    const tokens = h.gh.issuedTokens;
    const stored = await h.db.pool.query('select * from editor_github_tokens');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].access_sealed).toMatch(/^v1\./);
    expect(stored.rows[0].refresh_sealed).toMatch(/^v1\./);
    const dump = JSON.stringify([
      stored.rows,
      (await h.db.pool.query('select * from editor_audit')).rows,
      (await h.db.pool.query('select * from editor_sessions')).rows,
    ]);
    for (const token of tokens) expect(dump).not.toContain(token);

    keep(await form(h, ada, '/auth/logout', {}));
    expect((await h.db.pool.query('select 1 from editor_github_tokens')).rowCount).toBe(0);

    // Disabling an author removes the tokens of all their sessions.
    await signIn(ADA);
    await signIn(ADA);
    expect((await h.db.pool.query('select 1 from editor_github_tokens')).rowCount).toBe(2);
    await setEditorUserDisabled(h.db.pool, ADA.email, true);
    expect((await h.db.pool.query('select 1 from editor_github_tokens')).rowCount).toBe(0);
  });
});
