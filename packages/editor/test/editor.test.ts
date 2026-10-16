import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getActiveEditorBranch,
  listEditorAudit,
  setEntitlements,
  testDatabaseUrl,
  upsertEditorUser,
  upsertOrg,
} from '@opend/store';
import { EDITOR_COOKIE } from '../src/index.js';
import {
  ADA,
  BOB,
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

describe.skipIf(!url)('web editor', () => {
  let h: Harness;
  let ada: Session;

  const original = (path = INSTALL) => h.gh.readFile(REPO, 'main', path)!;
  const save = (session: Session, content: string, extra: Record<string, unknown> = {}) =>
    api(h, session, 'POST', '/save', { path: INSTALL, content, ...extra });

  beforeEach(async () => {
    h = await startEditor(url!, {
      oidc: {
        carol: {
          issuer: 'https://idp.test',
          subject: 'c-1',
          email: 'carol@example.com',
          emailVerified: true,
          name: 'Carol Writer',
        },
        mallory: {
          issuer: 'https://idp.test',
          subject: 'm-1',
          email: 'carol@example.com',
          emailVerified: false,
        },
        stranger: {
          issuer: 'https://idp.test',
          subject: 's-1',
          email: 'stranger@example.com',
          emailVerified: true,
        },
      },
    });
    h.gh.setCollaborator(REPO, ADA.login, 'write');
    h.gh.setCollaborator(REPO, BOB.login, 'maintain');
    ada = (await signInGitHub(h, ADA)).session!;
  });

  afterEach(async () => {
    await h.close();
  });

  describe('sign-in', () => {
    it('lets developers with write access in through GitHub and records the sign-in', async () => {
      const users = await h.db.pool.query('select email, name, github_login from editor_users');
      expect(users.rows).toEqual([{ email: ADA.email, name: ADA.name, github_login: 'ada' }]);
      const audit = await listEditorAudit(h.db.pool);
      expect(audit[0]).toMatchObject({
        action: 'sign_in',
        email: ADA.email,
        detail: { provider: 'github' },
      });
      const home = await page(h, ada, '/');
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain('Ada Lovelace');
    });

    it('refuses GitHub users without write access unless an admin registered them', async () => {
      h.gh.setCollaborator(REPO, 'eve', 'read');
      const eve = { id: 200, login: 'eve', name: 'Eve', email: 'eve@example.com' };
      const refused = await signInGitHub(h, eve);
      expect(refused.statusCode).toBe(403);
      expect(refused.body).toContain('cannot edit these docs');
      await upsertEditorUser(h.db.pool, {
        email: 'eve.work@example.com',
        name: 'Eve',
        githubLogin: 'EVE',
      });
      const allowed = await signInGitHub(h, eve);
      expect(allowed.statusCode).toBe(302);
      expect(allowed.session).toBeDefined();
    });

    it('signs company authors in with OIDC by verified, registered email only', async () => {
      expect((await signInOidc(h, 'carol')).statusCode).toBe(403);
      await upsertEditorUser(h.db.pool, { email: 'Carol@example.com' });
      expect((await signInOidc(h, 'mallory')).statusCode).toBe(403);
      const carol = await signInOidc(h, 'carol');
      expect(carol.statusCode).toBe(302);
      const home = await page(h, carol.session!, '/');
      expect(home.body).toContain('Carol Writer');
      expect((await signInOidc(h, 'stranger')).statusCode).toBe(403);
    });

    it('never accepts a reader session, a forged cookie or a signed-out session', async () => {
      // The docs site's reader cookie, correctly signed with the docs server's secret.
      const readerValue = JSON.stringify({ r: 1, e: Math.floor(Date.now() / 1000) + 3600 });
      const sig = createHmac('sha256', 'docs-site-session-secret-0123456789')
        .update(readerValue)
        .digest('base64')
        .replace(/=+$/, '');
      for (const cookie of [
        `opend_session=${encodeURIComponent(`${readerValue}.${sig}`)}`,
        `${EDITOR_COOKIE}=${encodeURIComponent(`${readerValue}.${sig}`)}`,
        `${EDITOR_COOKIE}=not-a-session`,
      ]) {
        const res = await h.app.inject({ method: 'GET', url: '/', headers: { cookie } });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/auth/login?returnTo=%2F');
        const write = await h.app.inject({
          method: 'POST',
          url: '/save',
          headers: { cookie, 'content-type': 'application/json', accept: 'application/json' },
          payload: JSON.stringify({ path: INSTALL, content: '<x/>' }),
        });
        expect(write.statusCode).toBe(401);
      }
      const out = await form(h, ada, '/auth/logout', {});
      expect(out.statusCode).toBe(302);
      expect((await page(h, ada, '/')).statusCode).toBe(302);
    });

    it('refuses writes without the CSRF token or from another origin', async () => {
      const content = original().replace(DOWNLOAD, '<cmd>Changed.</cmd>');
      const noToken = await h.app.inject({
        method: 'POST',
        url: '/save',
        headers: {
          cookie: ada.cookie,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        payload: JSON.stringify({ path: INSTALL, content }),
      });
      expect(noToken.statusCode).toBe(403);
      const otherOrigin = await h.app.inject({
        method: 'POST',
        url: '/save',
        headers: {
          cookie: ada.cookie,
          'x-csrf-token': ada.csrf,
          origin: 'https://evil.test',
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ path: INSTALL, content }),
      });
      expect(otherOrigin.statusCode).toBe(403);
      expect(await getActiveEditorBranch(h.db.pool, 1, 1)).toBeNull();
    });
  });

  describe('saving', () => {
    it('commits to the author’s own branch with the author and trailer from the session', async () => {
      const content = original().replace(DOWNLOAD, '<cmd>Download the new installer.</cmd>');
      const res = await save(ada, content, {
        // Anything the browser says about the author is ignored.
        authorName: 'Mallory',
        authorEmail: 'mallory@evil.test',
        message: 'Clarify the download step',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.branch).toMatch(/^editor\/1\/ada-lovelace-[0-9a-f]{6}$/);
      expect(body.sync).toBe('up-to-date');
      const head = h.gh.branch(REPO, body.branch)!;
      expect(head).toBe(body.sha);
      const commit = h.gh.commit(head);
      expect(commit.author).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
      expect(commit.message).toMatch(/^Clarify the download step\n/);
      expect(commit.message.trim().split('\n').at(-1)).toBe(
        'Co-authored-by: Ada Lovelace <ada@example.com>',
      );
      expect(commit.message).not.toContain('Mallory');
      expect(h.gh.readFile(REPO, body.branch, INSTALL)).toBe(content);
      // Saving never opens a pull request or touches main.
      expect(h.gh.pulls(REPO)).toEqual([]);
      expect(original()).not.toContain('new installer');

      // A second save goes to the same branch.
      const again = await save(ada, content.replace('new installer', 'newest installer'), {
        branch: body.branch,
        expectSha: body.fileSha,
      });
      expect(again.json().branch).toBe(body.branch);
      expect(h.gh.commit(again.json().sha).parents).toEqual([body.sha]);

      const audit = (await listEditorAudit(h.db.pool)).filter((a) => a.action === 'save');
      expect(audit).toHaveLength(2);
      expect(audit[1]).toMatchObject({
        userId: 1,
        branch: body.branch,
        commitSha: body.sha,
        prNumber: null,
        detail: { files: [INSTALL] },
      });
      expect(audit[1]!.sessionId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    });

    it('refuses writes to anyone else’s branch, or to main', async () => {
      const adas = (await save(ada, original().replace(DOWNLOAD, '<cmd>Ada.</cmd>'))).json();
      const bob = (await signInGitHub(h, BOB)).session!;
      const before = h.gh.branch(REPO, adas.branch);
      for (const branch of [adas.branch, 'main', 'editor/1/made-up']) {
        const res = await save(bob, original().replace(DOWNLOAD, '<cmd>Bob.</cmd>'), { branch });
        expect(res.statusCode, branch).toBe(403);
        expect(res.json().error).toBe('You can only change your own working branch.');
      }
      expect(h.gh.branch(REPO, adas.branch)).toBe(before);
      expect(h.gh.readFile(REPO, 'main', INSTALL)).not.toContain('Bob.');
      expect((await api(h, bob, 'POST', '/publish', { branch: adas.branch })).statusCode).toBe(403);
      const resolve = await api(h, bob, 'POST', '/conflicts/resolve', {
        branch: adas.branch,
        oursSha: 'x',
        theirsSha: 'y',
      });
      expect(resolve.statusCode).toBe(403);
      // Bob's own save gets his own branch.
      const bobs = (await save(bob, original().replace(DOWNLOAD, '<cmd>Bob.</cmd>'))).json();
      expect(bobs.branch).toMatch(/^editor\/2\//);
    });

    it('refuses XML that is not well-formed, and files it may not edit', async () => {
      const broken = await save(ada, '<task id="install"><title>Broken</task>');
      expect(broken.statusCode).toBe(422);
      expect(broken.json().diagnostics[0]).toMatchObject({ code: 'xml-syntax', file: INSTALL });
      const config = await api(h, ada, 'POST', '/save', {
        path: 'opend.config.yaml',
        content: 'title: x',
      });
      expect(config.statusCode).toBe(400);
      const escape = await api(h, ada, 'POST', '/save', {
        path: '../outside.dita',
        content: '<topic/>',
      });
      expect(escape.statusCode).toBe(400);
      expect(await getActiveEditorBranch(h.db.pool, 1, 1)).toBeNull();
    });

    it('refuses a save over a version the author did not start from', async () => {
      const first = (await save(ada, original().replace(DOWNLOAD, '<cmd>One.</cmd>'))).json();
      const stale = await save(ada, original().replace(DOWNLOAD, '<cmd>Two.</cmd>'), {
        branch: first.branch,
        expectSha: 'f'.repeat(40),
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().stale).toBe(true);
    });

    it('works without JavaScript through plain form posts', async () => {
      const content = original().replace(DOWNLOAD, '<cmd>From a form.</cmd>');
      const editor = await page(h, ada, `/edit?path=${encodeURIComponent(INSTALL)}`);
      const expectSha = /name="expectSha" value="([0-9a-f]+)"/.exec(editor.body)![1]!;
      const res = await form(h, ada, '/save', { path: INSTALL, content, branch: '', expectSha });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(
        /^\/edit\?path=topics%2Finstall\.dita&saved=[0-9a-f]{40}$/,
      );
      const edit = await page(h, ada, String(res.headers.location));
      expect(edit.body).toContain('From a form.');
      expect(edit.body).toContain('Saved as commit');
    });

    it('creates a topic from a template and adds it to the map', async () => {
      const res = await form(h, ada, '/new', {
        title: 'Back up the hub',
        name: 'backup',
        dir: 'topics',
        type: 'task',
        map: 'maps/user-guide.ditamap',
      });
      expect(res.statusCode).toBe(302);
      const branch = (await getActiveEditorBranch(h.db.pool, 1, 1))!.branch;
      expect(h.gh.readFile(REPO, branch, 'topics/backup.dita')).toContain(
        '<title>Back up the hub</title>',
      );
      expect(h.gh.readFile(REPO, branch, 'maps/user-guide.ditamap')).toContain(
        '<topicref href="../topics/backup.dita"/>\n</map>',
      );
      const preview = await page(h, ada, '/preview/saved/topics/backup.html');
      expect(preview.statusCode).toBe(200);
      expect(preview.body).toContain('Back up the hub');
      const dup = await form(h, ada, '/new', {
        title: 'Again',
        name: 'backup',
        dir: 'topics',
        type: 'task',
        map: '',
      });
      expect(dup.statusCode).toBe(409);
    });
  });

  describe('preview', () => {
    it('shows the unsaved draft with diagnostics, separately from the saved branch', async () => {
      const draft = original().replace(
        DOWNLOAD,
        '<cmd>DRAFT-MARKER-71 <xref href="missing-topic.dita"/></cmd>',
      );
      const res = await api(h, ada, 'POST', '/api/preview', { path: INSTALL, content: draft });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.errors).toBeGreaterThan(0);
      expect(
        body.diagnostics.some(
          (d: { file: string; code: string }) => d.file === INSTALL && d.code === 'broken-link',
        ),
      ).toBe(true);
      expect(body.previewUrl).toMatch(/^\/preview\/draft\/topics\/install\.html\?v=/);
      const shown = await page(h, ada, body.previewUrl);
      expect(shown.statusCode).toBe(200);
      expect(shown.body).toContain('DRAFT-MARKER-71');
      expect(shown.body).toContain('unsaved changes');
      expect(shown.headers['content-security-policy']).toContain("frame-ancestors 'self'");
      // Nothing was saved.
      const saved = await page(h, ada, '/preview/saved/topics/install.html');
      expect(saved.body).not.toContain('DRAFT-MARKER-71');
      expect(h.gh.pulls(REPO)).toEqual([]);

      // Saving refreshes the saved preview and reports the same diagnostics.
      const after = (await save(ada, draft)).json();
      expect(after.diagnostics.some((d: { code: string }) => d.code === 'broken-link')).toBe(true);
      expect(after.previewUrl).toMatch(/^\/preview\/saved\/topics\/install\.html\?v=/);
      expect((await page(h, ada, after.previewUrl)).body).toContain('DRAFT-MARKER-71');
    });

    it('renders the edit page with source, problems and the preview frame', async () => {
      const res = await page(h, ada, `/edit?path=${encodeURIComponent(INSTALL)}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('&lt;task id=&quot;install&quot;&gt;');
      expect(res.body).toContain(
        '<iframe id="ed-preview" title="Preview of topics/install.dita" src="/preview/saved/topics/install.html">',
      );
      expect(res.body).toContain('No problems found.');
      const missing = await page(h, ada, '/edit?path=topics/nope.dita');
      expect(missing.statusCode).toBe(404);
    });

    it('previews any page as an org through an expiring, logged preview', async () => {
      await upsertOrg(h.db.pool, { slug: 'initech', name: 'Initech' });
      await setEntitlements(h.db.pool, 'initech', {
        products: ['widget'],
        features: [],
        version: '2.1',
      });
      const res = await form(h, ada, '/preview-as', {
        org: 'initech',
        page: 'topics/install.html',
      });
      expect(res.statusCode).toBe(302);
      const location = String(res.headers.location);
      expect(location).toMatch(/^\/preview\/as\/[A-Za-z0-9_-]+\/topics\/install\.html$/);
      const shown = await page(h, ada, location);
      expect(shown.statusCode).toBe(200);
      expect(shown.body).toContain('as initech');
      expect(shown.body).toContain('this preview is logged');
      // Filtered like the reader: no gadget step, no gadget pages.
      expect(shown.body).not.toContain('Pair the Gadget');
      const base = location.replace('topics/install.html', '');
      expect((await page(h, ada, `${base}topics/gadget-pairing.html`)).statusCode).toBe(404);
      const staff = await page(h, ada, '/preview/main/topics/install.html');
      expect(staff.body).toContain('Pair the Gadget');

      const audit = (await listEditorAudit(h.db.pool)).find((a) => a.action === 'preview_as')!;
      expect(audit).toMatchObject({
        userId: 1,
        branch: 'main',
        commitSha: h.gh.branch(REPO, 'main'),
      });
      expect(audit.detail).toMatchObject({ org: 'initech' });
      expect(audit.sessionId).toBeTruthy();

      // Someone else cannot use it.
      const bob = (await signInGitHub(h, BOB)).session!;
      expect((await page(h, bob, location)).statusCode).toBe(404);
      // It expires.
      await h.db.pool.query("update editor_previews set expires_at = now() - interval '1 second'");
      const expired = await page(h, ada, location);
      expect(expired.statusCode).toBe(410);
      expect(expired.body).toContain('expired');
    });
  });

  describe('publishing', () => {
    it('opens one pull request and merges it at once when no rules apply', async () => {
      const content = original().replace(DOWNLOAD, '<cmd>Published change.</cmd>');
      const saved = (await save(ada, content)).json();
      const status = await page(h, ada, '/publish');
      expect(status.body).toContain('No review rules apply');
      const res = await api(h, ada, 'POST', '/publish', {});
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ pr: 1, created: true, merged: true, blockers: [] });
      const [pull] = h.gh.pulls(REPO);
      expect(pull).toMatchObject({ head: saved.branch, base: 'main', merged: true });
      expect(pull!.body).toContain('Docs changes by **Ada Lovelace** (ada@example.com)');
      expect(pull!.body).toContain(`- \`${INSTALL}\``);
      expect(pull!.body).toContain('Co-authored-by: Ada Lovelace <ada@example.com>');
      expect(h.gh.readFile(REPO, 'main', INSTALL)).toBe(content);
      const squash = h.gh.commit(h.gh.branch(REPO, 'main')!);
      expect(squash.parents).toHaveLength(1);
      expect(squash.message).toContain('(#1)');
      expect(squash.message.trim().split('\n').at(-1)).toBe(
        'Co-authored-by: Ada Lovelace <ada@example.com>',
      );

      const audit = await listEditorAudit(h.db.pool);
      expect(audit[0]).toMatchObject({ action: 'merge', prNumber: 1, commitSha: body.mergeSha });
      expect(audit[1]).toMatchObject({ action: 'publish', prNumber: 1, commitSha: saved.sha });

      // The next save starts a fresh branch.
      expect(await getActiveEditorBranch(h.db.pool, 1, 1)).toBeNull();
      const next = (await save(ada, content.replace('Published change.', 'Follow-up.'))).json();
      expect(next.branch).not.toBe(saved.branch);
    });

    it('waits for required reviews and checks, shows what blocks, and merges once they pass', async () => {
      h.gh.setProtection(REPO, 'main', {
        required_pull_request_reviews: { required_approving_review_count: 1 },
        required_status_checks: { contexts: ['opend/build'] },
      });
      await save(ada, original().replace(DOWNLOAD, '<cmd>Reviewed change.</cmd>'));
      const first = (await api(h, ada, 'POST', '/publish', {})).json();
      expect(first).toMatchObject({ pr: 1, created: true, merged: false });
      expect(first.blockers).toEqual([
        'Needs 1 approving review (has 0).',
        'Required check "opend/build" has not passed yet.',
      ]);
      expect(h.gh.readFile(REPO, 'main', INSTALL)).not.toContain('Reviewed change.');
      const status = await page(h, ada, '/publish');
      expect(status.body).toContain(
        'need 1 approving review, the check <code>opend/build</code> to pass (from branch protection)',
      );
      expect(status.body).toContain('Still blocking the merge');

      // Changes requested: back to editing on the same branch; the save updates the PR.
      h.gh.review(REPO, 1, 'carol', 'CHANGES_REQUESTED');
      const asked = await page(h, ada, '/publish');
      expect(asked.body).toContain('Changes requested by carol. Keep editing on your branch');
      const branch = (await getActiveEditorBranch(h.db.pool, 1, 1))!;
      const fix = await save(
        ada,
        original().replace(DOWNLOAD, '<cmd>Reviewed change, fixed.</cmd>'),
        {
          branch: branch.branch,
        },
      );
      expect(fix.json().branch).toBe(branch.branch);
      expect(h.gh.pulls(REPO)).toHaveLength(1);

      h.gh.review(REPO, 1, 'carol', 'APPROVED');
      h.gh.setStatus(REPO, fix.json().sha, 'opend/build', 'success');
      const second = (await api(h, ada, 'POST', '/publish', {})).json();
      expect(second).toMatchObject({ pr: 1, created: false, merged: true, blockers: [] });
      expect(h.gh.readFile(REPO, 'main', INSTALL)).toContain('Reviewed change, fixed.');
    });

    it('reads rulesets, and never auto-merges when the rules are hidden from the app', async () => {
      h.gh.setRulesets(REPO, 'main', [
        { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
      ]);
      expect((await page(h, ada, '/publish')).body).toContain(
        'need 2 approving reviews (from rulesets)',
      );
      h.gh.setRulesets(REPO, 'main', null);
      h.gh.setProtection(REPO, 'main', 'forbidden');
      await save(ada, original().replace(DOWNLOAD, '<cmd>Hidden rules.</cmd>'));
      const res = (await api(h, ada, 'POST', '/publish', {})).json();
      expect(res.merged).toBe(false);
      expect(res.blockers).toContain('The branch rules could not be read.');
      expect((await page(h, ada, '/publish')).body).toContain(
        'GitHub does not let the editor read the branch protection of main',
      );
    });

    it('refuses to publish validation errors or an empty branch', async () => {
      expect((await api(h, ada, 'POST', '/publish', {})).statusCode).toBe(400);
      await save(ada, original().replace(DOWNLOAD, '<cmd><xref href="nowhere.dita"/></cmd>'));
      const res = await api(h, ada, 'POST', '/publish', {});
      expect(res.statusCode).toBe(422);
      expect(res.json().diagnostics.length).toBeGreaterThan(0);
      expect(h.gh.pulls(REPO)).toEqual([]);
    });
  });

  describe('merging main into the branch', () => {
    it('merges main in on open and on save, never rewriting the branch', async () => {
      const saved = (await save(ada, original().replace(DOWNLOAD, '<cmd>Mine.</cmd>'))).json();
      h.gh.push(REPO, 'main', {
        'topics/configure.dita': original('topics/configure.dita').replace(
          '</title>',
          ' (updated)</title>',
        ),
      });
      await page(h, ada, '/');
      const head = h.gh.branch(REPO, saved.branch)!;
      const merge = h.gh.commit(head);
      expect(merge.parents).toEqual([saved.sha, h.gh.branch(REPO, 'main')]);
      expect(h.gh.readFile(REPO, saved.branch, 'topics/configure.dita')).toContain('(updated)');
      const audit = (await listEditorAudit(h.db.pool)).find((a) => a.action === 'sync')!;
      expect(audit.commitSha).toBe(head);
    });

    it('merges line by line where GitHub reports a file-level conflict', async () => {
      const base = original();
      const saved = (await save(ada, base.replace(DOWNLOAD, '<cmd>Mine.</cmd>'))).json();
      h.gh.push(REPO, 'main', {
        [INSTALL]: base.replace('<p>The hub is installed.', '<p>The hub is now installed.'),
      });
      const res = await save(ada, base.replace(DOWNLOAD, '<cmd>Mine, again.</cmd>'), {
        branch: saved.branch,
      });
      expect(res.json().sync).toBe('merged');
      const text = h.gh.readFile(REPO, saved.branch, INSTALL)!;
      expect(text).toContain('Mine, again.');
      expect(text).toContain('The hub is now installed.');
      expect(h.gh.commit(h.gh.branch(REPO, saved.branch)!).parents).toHaveLength(2);
    });

    it('shows both versions of a conflicting file and commits the author’s choice', async () => {
      const base = original();
      const mine = base.replace(DOWNLOAD, '<cmd>Download from the portal.</cmd>');
      const theirs = base.replace(DOWNLOAD, '<cmd>Download from the mirror.</cmd>');
      const saved = (await save(ada, mine)).json();
      const mainHead = h.gh.push(REPO, 'main', { [INSTALL]: theirs });

      const next = await save(ada, mine.replace('portal', 'customer portal'), {
        branch: saved.branch,
      });
      expect(next.json().sync).toBe('conflict');
      const view = await page(h, ada, '/conflicts');
      expect(view.statusCode).toBe(200);
      expect(view.body).toContain('Your version');
      expect(view.body).toContain('Current version on main');
      expect(view.body).toContain('Download from the customer portal.');
      expect(view.body).toContain('Download from the mirror.');
      expect(view.body).toContain('&lt;&lt;&lt;&lt;&lt;&lt;&lt; your version');
      const oursSha = /name="oursSha" value="([0-9a-f]+)"/.exec(view.body)![1]!;
      const theirsSha = /name="theirsSha" value="([0-9a-f]+)"/.exec(view.body)![1]!;
      expect(theirsSha).toBe(mainHead);

      // Leftover markers in a hand edit are refused.
      const bad = await api(h, ada, 'POST', '/conflicts/resolve', {
        branch: saved.branch,
        oursSha,
        theirsSha,
        choices: [{ path: INSTALL, take: 'manual', content: '<<<<<<< your version\n<task/>' }],
      });
      expect(bad.statusCode).toBe(422);

      const res = await form(h, ada, '/conflicts/resolve', {
        branch: saved.branch,
        oursSha,
        theirsSha,
        'path.0': INSTALL,
        'take.0': 'manual',
        'content.0': mine.replace('portal', 'portal or the mirror'),
      });
      expect(res.statusCode).toBe(302);
      const head = h.gh.branch(REPO, saved.branch)!;
      const commit = h.gh.commit(head);
      expect(commit.parents).toEqual([oursSha, theirsSha]);
      expect(commit.author.email).toBe('ada@example.com');
      expect(commit.message).toContain(`- ${INSTALL}: edited by hand`);
      expect(commit.message).toContain('Co-authored-by: Ada Lovelace <ada@example.com>');
      expect(h.gh.readFile(REPO, saved.branch, INSTALL)).toContain(
        'Download from the portal or the mirror.',
      );
      const audit = (await listEditorAudit(h.db.pool)).find((a) => a.action === 'resolve')!;
      expect(audit).toMatchObject({ commitSha: head, branch: saved.branch });
      expect((await page(h, ada, '/conflicts')).body).toContain('No conflicts');
      // Now it publishes cleanly.
      expect((await api(h, ada, 'POST', '/publish', {})).json().merged).toBe(true);
      expect(h.gh.readFile(REPO, 'main', INSTALL)).toContain('portal or the mirror');
    });

    it('refuses a resolution when main moved after the choices were shown', async () => {
      const base = original();
      const saved = (await save(ada, base.replace(DOWNLOAD, '<cmd>A.</cmd>'))).json();
      h.gh.push(REPO, 'main', { [INSTALL]: base.replace(DOWNLOAD, '<cmd>B.</cmd>') });
      const view = await page(h, ada, '/conflicts');
      const oursSha = /name="oursSha" value="([0-9a-f]+)"/.exec(view.body)![1]!;
      const theirsSha = /name="theirsSha" value="([0-9a-f]+)"/.exec(view.body)![1]!;
      h.gh.push(REPO, 'main', { 'topics/overview.dita': original('topics/overview.dita') + '\n' });
      const res = await api(h, ada, 'POST', '/conflicts/resolve', {
        branch: saved.branch,
        oursSha,
        theirsSha,
        choices: [{ path: INSTALL, take: 'mine' }],
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().stale).toBe(true);
    });

    it('escalates structural conflicts to a developer in the pull request', async () => {
      const configure = original('topics/configure.dita');
      const saved = (
        await api(h, ada, 'POST', '/save', {
          path: 'topics/configure.dita',
          content: configure.replace('</title>', ' now</title>'),
        })
      ).json();
      h.gh.push(REPO, 'main', { 'topics/configure.dita': null }, 'Remove configure topic');
      const view = await page(h, ada, '/conflicts');
      expect(view.body).toContain('A developer needs to resolve this');
      expect(view.body).toContain('This file was removed on the main branch after you changed it.');
      expect(view.body).not.toContain('Save my choices');
      const oursSha = h.gh.branch(REPO, saved.branch)!;
      const refused = await api(h, ada, 'POST', '/conflicts/resolve', {
        branch: saved.branch,
        oursSha,
        theirsSha: h.gh.branch(REPO, 'main'),
        choices: [],
      });
      expect(refused.statusCode).toBe(409);
      const publish = await api(h, ada, 'POST', '/publish', {});
      expect(publish.statusCode).toBe(409);
      expect(publish.json().conflicts).toBe(true);

      const res = await api(h, ada, 'POST', '/escalate', {});
      expect(res.json()).toMatchObject({ pr: 1 });
      const [pull] = h.gh.pulls(REPO);
      expect(pull!.state).toBe('open');
      expect(pull!.body).toContain(
        'Needs a developer: merging main into this branch conflicts in topics/configure.dita',
      );
      const audit = (await listEditorAudit(h.db.pool)).find((a) => a.action === 'escalate')!;
      expect(audit).toMatchObject({ prNumber: 1, commitSha: oursSha });
    });

    it('escalates a deleted section the author still edits', async () => {
      const base = original();
      const withSection = base.replace(
        '<result>',
        '<section id="extra"><p>Extra.</p></section>\n    <result>',
      );
      // Put the section on main first, so it is in the merge base.
      h.gh.push(REPO, 'main', { [INSTALL]: withSection });
      const saved = (
        await save(ada, withSection.replace('<p>Extra.</p>', '<p>Extra, edited.</p>'))
      ).json();
      h.gh.push(REPO, 'main', { [INSTALL]: base });
      await page(h, ada, '/');
      const view = await page(h, ada, '/conflicts');
      expect(view.body).toContain('Sections you edited were deleted on the main branch (extra).');
      expect(h.gh.branch(REPO, saved.branch)).toBe(saved.sha);
    });
  });

  describe('pages', () => {
    it('sends a strict CSP and no inline script on every editor page', async () => {
      for (const path of [
        '/',
        '/publish',
        '/activity',
        `/edit?path=${encodeURIComponent(INSTALL)}`,
        '/conflicts',
      ]) {
        const res = await page(h, ada, path);
        expect(res.statusCode, path).toBe(200);
        const csp = String(res.headers['content-security-policy']);
        expect(csp, path).toContain("script-src 'self'");
        expect(csp, path).not.toContain('unsafe-inline');
        expect(csp, path).toContain("frame-ancestors 'none'");
        expect(res.headers['cache-control']).toBe('private, no-store');
        for (const tag of res.body.match(/<script[^>]*>/g) ?? [])
          expect(tag, path).toMatch(/ src="\/assets\/editor\.js"/);
        expect(res.body, path).not.toMatch(/ on[a-z]+="/);
        expect(res.body, path).not.toContain('style="');
      }
      const login = await h.app.inject({ method: 'GET', url: '/auth/login' });
      expect(String(login.headers['content-security-policy'])).not.toContain('unsafe-inline');
      const preview = await page(h, ada, '/preview/main/');
      expect(String(preview.headers['content-security-policy'])).not.toContain('script-src');
      expect(preview.body).not.toMatch(/<script/);
      const js = await h.app.inject({ method: 'GET', url: '/assets/editor.js' });
      expect(js.headers['content-type']).toContain('text/javascript');
      expect(js.body).toContain('installEditor');
    });

    it('lists the author’s activity', async () => {
      await save(ada, original().replace(DOWNLOAD, '<cmd>Logged.</cmd>'));
      const res = await page(h, ada, '/activity');
      expect(res.body).toContain('<td>save</td>');
      expect(res.body).toContain('<td>sign_in</td>');
    });
  });
});
