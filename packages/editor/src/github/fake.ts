import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { GitIdentity, Permission } from './client.js';

type Json = Record<string, unknown>;

export interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: GitIdentity;
  committer: GitIdentity;
  /** Signed by GitHub (shown "Verified"): createCommitOnBranch, update-branch and squash merges. */
  signed: boolean;
}

/** GitHub's own committer on commits it makes and signs. */
export const GITHUB_COMMITTER: GitIdentity = { name: 'GitHub', email: 'noreply@github.com' };

interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  /** Who opened it: `app` or a user login. */
  openedBy: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommit: string | null;
  reviews: { user: string; state: string; at: string }[];
}

interface FakeRepo {
  refs: Map<string, string>;
  pulls: FakePull[];
  protection: Map<string, Json | 'forbidden'>;
  rulesets: Map<string, Json[] | 'forbidden'>;
  statuses: Map<string, { context: string; state: string }[]>;
  collaborators: Map<string, Permission>;
}

interface OAuthUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  verified?: boolean;
  /** Further addresses on the account, as `/user/emails` lists them. */
  otherEmails?: { email: string; verified: boolean }[];
}

type FileTree = Map<string, { sha: string; mode: string }>;

const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex');

function json(status: number, body?: unknown): Response {
  if (status === 204 || body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * An in-memory GitHub for tests: the REST endpoints the editor uses (git data
 * API, merges, compare, pulls, reviews, branch protection, rulesets, statuses,
 * collaborators), App installation tokens and the OAuth web flow. Pass
 * `fake.fetch` wherever a `fetch` is accepted. Merges are three-way at file
 * level: a file changed differently on both sides is a conflict (409), which
 * is stricter than GitHub's line-level merge.
 */
export class FakeGitHub {
  readonly apiUrl = 'https://api.github.test';
  readonly webUrl = 'https://github.test';
  /** Simulate an app without the account-level "Email addresses" permission. */
  noEmailPermission = false;
  private readonly blobs = new Map<string, Buffer>();
  private readonly trees = new Map<string, FileTree>();
  private readonly commits = new Map<string, FakeCommit>();
  private readonly repos = new Map<string, FakeRepo>();
  private readonly oauthCodes = new Map<string, { user: OAuthUser; challenge?: string }>();
  private readonly oauthTokens = new Map<string, { user: OAuthUser; expiresAt: number | null }>();
  private readonly refreshTokens = new Map<string, OAuthUser>();
  /** Every user access and refresh token ever issued, for "never leaked" assertions. */
  readonly issuedTokens: string[] = [];
  /** Issue expiring user tokens with refresh tokens, as GitHub Apps do by default. */
  expiringUserTokens = false;
  private graphqlHooks: (() => void)[] = [];
  private readonly installationTokens = new Map<string, number>();
  private readonly manifestCodes = new Map<string, Json>();
  /** Apps created through the manifest flow, by id. */
  readonly apps = new Map<number, { slug: string; pem: string; webhookSecret: string }>();
  private readonly installations = new Map<
    number,
    { appId: number | null; account: string; repos: string[] }
  >();
  private nextApp = 1000;
  private nextPull = 1;
  private clock = 0;
  /** Every request, for assertions: `METHOD /path`. */
  readonly requests: string[] = [];
  /** Every request with who made it: `app` (installation token), a user's login, or `none`. */
  readonly calls: { method: string; path: string; as: string }[] = [];

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as Json) : {};
    const headers = new Headers(init?.headers);
    this.requests.push(`${method} ${url.pathname}`);
    const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    this.calls.push({
      method,
      path: url.pathname,
      as: this.installationTokens.has(token)
        ? 'app'
        : (this.oauthTokens.get(token)?.user.login ?? 'none'),
    });
    return this.handle(method, url, body, headers.get('authorization') ?? '');
  }) as typeof fetch;

  // ---- test helpers ------------------------------------------------------

  /** Creates a repository whose `branch` holds `files`. Returns the commit sha. */
  createRepo(fullName: string, files: Record<string, string | Buffer>, branch = 'main'): string {
    this.repos.set(fullName, {
      refs: new Map(),
      pulls: [],
      protection: new Map(),
      rulesets: new Map(),
      statuses: new Map(),
      collaborators: new Map(),
    });
    const tree: FileTree = new Map();
    for (const [path, content] of Object.entries(files))
      tree.set(path, { sha: this.putBlob(content), mode: '100644' });
    const sha = this.putCommit({
      tree: this.putTree(tree),
      parents: [],
      message: 'Initial commit',
      author: { name: 'Dev', email: 'dev@example.com' },
    });
    this.repo(fullName).refs.set(branch, sha);
    return sha;
  }

  /** Pushes a commit to a branch, as a developer would outside the editor. `null` deletes a file. */
  push(
    fullName: string,
    branch: string,
    files: Record<string, string | null>,
    message = 'Developer change',
  ): string {
    const repo = this.repo(fullName);
    const parent = repo.refs.get(branch);
    if (!parent) throw new Error(`no branch ${branch}`);
    const tree = new Map(this.fileTree(this.commit(parent).tree));
    for (const [path, content] of Object.entries(files)) {
      if (content === null) tree.delete(path);
      else tree.set(path, { sha: this.putBlob(content), mode: '100644' });
    }
    const sha = this.putCommit({
      tree: this.putTree(tree),
      parents: [parent],
      message,
      author: { name: 'Dev', email: 'dev@example.com' },
    });
    repo.refs.set(branch, sha);
    return sha;
  }

  branch(fullName: string, branch: string): string | undefined {
    return this.repo(fullName).refs.get(branch);
  }

  commit(sha: string): FakeCommit {
    const c = this.commits.get(sha);
    if (!c) throw new Error(`no commit ${sha}`);
    return c;
  }

  /** A file's text at a branch or commit, or `null` when absent. */
  readFile(fullName: string, ref: string, path: string): string | null {
    const sha = this.repo(fullName).refs.get(ref) ?? ref;
    const entry = this.fileTree(this.commit(sha).tree).get(path);
    return entry ? this.blobs.get(entry.sha)!.toString('utf8') : null;
  }

  pulls(fullName: string): Readonly<FakePull>[] {
    return this.repo(fullName).pulls;
  }

  setProtection(fullName: string, branch: string, rules: Json | 'forbidden' | null): void {
    if (rules === null) this.repo(fullName).protection.delete(branch);
    else this.repo(fullName).protection.set(branch, rules);
  }

  setRulesets(fullName: string, branch: string, rules: Json[] | 'forbidden' | null): void {
    if (rules === null) this.repo(fullName).rulesets.delete(branch);
    else this.repo(fullName).rulesets.set(branch, rules);
  }

  setStatus(fullName: string, sha: string, context: string, state: string): void {
    const list = this.repo(fullName).statuses.get(sha) ?? [];
    list.unshift({ context, state });
    this.repo(fullName).statuses.set(sha, list);
  }

  review(fullName: string, number: number, user: string, state: string): void {
    const pull = this.repo(fullName).pulls.find((p) => p.number === number);
    if (!pull) throw new Error(`no pull ${number}`);
    pull.reviews.push({ user, state, at: new Date(Date.now() + this.clock++).toISOString() });
  }

  setCollaborator(fullName: string, login: string, permission: Permission): void {
    this.repo(fullName).collaborators.set(login.toLowerCase(), permission);
  }

  /**
   * Makes `code` a valid OAuth callback code for this GitHub user. With a PKCE
   * `challenge` (from the authorization URL), the exchange must send the
   * matching verifier, as GitHub requires.
   */
  addOAuthCode(code: string, user: OAuthUser, challenge?: string): void {
    this.oauthCodes.set(code, challenge === undefined ? { user } : { user, challenge });
  }

  /**
   * Makes `code` a manifest code, as GitHub's redirect after "Create GitHub
   * App" carries. Converting it creates an app with a fresh private key.
   */
  addManifestCode(code: string, app: { name: string; owner?: string }): void {
    this.manifestCodes.set(code, app);
  }

  /** Makes every user token of `login` expired (refresh tokens still work). */
  expireUserTokens(login: string): void {
    for (const entry of this.oauthTokens.values())
      if (entry.user.login === login) entry.expiresAt = Date.now() - 1000;
  }

  /** Revokes every access and refresh token of `login`, as the user would in their settings. */
  revokeUserTokens(login: string): void {
    for (const [token, entry] of this.oauthTokens)
      if (entry.user.login === login) this.oauthTokens.delete(token);
    for (const [token, user] of this.refreshTokens)
      if (user.login === login) this.refreshTokens.delete(token);
  }

  /** Access tokens of `login` that GitHub would accept now. */
  liveUserTokens(login: string): string[] {
    return [...this.oauthTokens]
      .filter(
        ([, e]) => e.user.login === login && (e.expiresAt === null || e.expiresAt > Date.now()),
      )
      .map(([t]) => t);
  }

  /** Runs `fn` just before the next GraphQL request is handled (to simulate a race). */
  beforeNextGraphql(fn: () => void): void {
    this.graphqlHooks.push(fn);
  }

  /** An installation of an app (by id; `null`: any app) on `account`, with access to `repos`. */
  addInstallation(id: number, account: string, repos: string[], appId: number | null = null): void {
    this.installations.set(id, { appId, account, repos });
  }

  // ---- object store --------------------------------------------------------

  private repo(fullName: string): FakeRepo {
    const repo = this.repos.get(fullName);
    if (!repo) throw new Error(`no repo ${fullName}`);
    return repo;
  }

  private putBlob(content: string | Buffer): string {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const sha = sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
    this.blobs.set(sha, buf);
    return sha;
  }

  private putTree(tree: FileTree): string {
    const sorted = [...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sha = sha1(`tree ${JSON.stringify(sorted)}`);
    this.trees.set(sha, new Map(sorted));
    return sha;
  }

  private putCommit(
    input: Omit<FakeCommit, 'sha' | 'committer' | 'signed'> &
      Partial<Pick<FakeCommit, 'committer' | 'signed'>>,
  ): string {
    const c = {
      ...input,
      committer: input.committer ?? input.author,
      signed: input.signed ?? false,
    };
    const sha = sha1(`commit ${JSON.stringify(c)} ${this.clock++}`);
    this.commits.set(sha, { ...c, sha });
    return sha;
  }

  /** Whether classic protection or a ruleset requires signed commits on a branch. */
  private requiresSignatures(repo: FakeRepo, branch: string): boolean {
    const protection = repo.protection.get(branch);
    if (
      protection &&
      protection !== 'forbidden' &&
      (protection.required_signatures as Json | undefined)?.enabled === true
    )
      return true;
    const rules = this.rulesFor(repo, branch);
    return Array.isArray(rules) && rules.some((r) => r.type === 'required_signatures');
  }

  /** Rulesets set for the branch name or for a pattern matching it (`*`, `**`). */
  private rulesFor(repo: FakeRepo, branch: string): Json[] | 'forbidden' {
    const out: Json[] = [];
    for (const [pattern, rules] of repo.rulesets) {
      if (!globMatch(pattern, branch)) continue;
      if (rules === 'forbidden') return 'forbidden';
      out.push(...rules);
    }
    return out;
  }

  /** Commits `sha` brings that no branch has yet: what signature rules check on an update. */
  private newCommits(repo: FakeRepo, sha: string): FakeCommit[] {
    const known = new Set<string>();
    for (const head of repo.refs.values()) for (const c of this.ancestors(head)) known.add(c);
    return this.ancestors(sha)
      .filter((c) => !known.has(c))
      .map((c) => this.commit(c));
  }

  private signatureViolation(repo: FakeRepo, branch: string, sha: string): Response | null {
    if (!this.requiresSignatures(repo, branch)) return null;
    if (this.newCommits(repo, sha).every((c) => c.signed)) return null;
    return json(422, {
      message: 'Repository rule violations found\n\nCommits must have verified signatures.',
    });
  }

  /** The identity GitHub gives a user's commits: their name and no-reply address. */
  private identityOf(user: OAuthUser): GitIdentity {
    return {
      name: user.name ?? user.login,
      email: `${user.id}+${user.login}@users.noreply.github.com`,
    };
  }

  private fileTree(sha: string): FileTree {
    const tree = this.trees.get(sha);
    if (!tree) throw new Error(`no tree ${sha}`);
    return tree;
  }

  private ancestors(sha: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue = [sha];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      order.push(next);
      queue.push(...(this.commits.get(next)?.parents ?? []));
    }
    return order;
  }

  private mergeBase(a: string, b: string): string | null {
    const inA = new Set(this.ancestors(a));
    return this.ancestors(b).find((c) => inA.has(c)) ?? null;
  }

  /** Three-way merge of trees at file level, or `null` on conflict. */
  private mergeTrees(baseSha: string, oursSha: string, theirsSha: string): FileTree | null {
    const base = this.fileTree(baseSha);
    const ours = this.fileTree(oursSha);
    const theirs = this.fileTree(theirsSha);
    const out: FileTree = new Map();
    for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
      const b = base.get(path)?.sha;
      const o = ours.get(path);
      const t = theirs.get(path);
      let pick: { sha: string; mode: string } | undefined;
      if (o?.sha === t?.sha) pick = o;
      else if (o?.sha === b) pick = t;
      else if (t?.sha === b) pick = o;
      else return null;
      if (pick) out.set(path, pick);
    }
    return out;
  }

  private revokeAccessTokens(login: string): void {
    for (const [token, entry] of this.oauthTokens)
      if (entry.user.login === login) this.oauthTokens.delete(token);
  }

  private issueUserToken(user: OAuthUser): Json {
    const token = `ghu_${randomBytes(12).toString('hex')}`;
    this.issuedTokens.push(token);
    if (!this.expiringUserTokens) {
      this.oauthTokens.set(token, { user, expiresAt: null });
      return { access_token: token, token_type: 'bearer', scope: '' };
    }
    const refresh = `ghr_${randomBytes(16).toString('hex')}`;
    this.issuedTokens.push(refresh);
    this.oauthTokens.set(token, { user, expiresAt: Date.now() + 28_800_000 });
    this.refreshTokens.set(refresh, user);
    return {
      access_token: token,
      token_type: 'bearer',
      scope: '',
      expires_in: 28_800,
      refresh_token: refresh,
      refresh_token_expires_in: 15_897_600,
    };
  }

  private userFor(token: string): OAuthUser | undefined {
    const entry = this.oauthTokens.get(token);
    if (!entry || (entry.expiresAt !== null && entry.expiresAt <= Date.now())) return undefined;
    return entry.user;
  }

  // ---- HTTP -----------------------------------------------------------------

  private handle(method: string, url: URL, body: Json, auth: string): Response {
    if (
      url.origin === this.webUrl &&
      url.pathname === '/login/oauth/access_token' &&
      body.grant_type === 'refresh_token'
    ) {
      const user = this.refreshTokens.get(String(body.refresh_token));
      if (!user) return json(200, { error: 'bad_refresh_token' });
      // Using a refresh token invalidates it and the access token it came with.
      this.refreshTokens.delete(String(body.refresh_token));
      this.revokeAccessTokens(user.login);
      return json(200, this.issueUserToken(user));
    }
    if (url.origin === this.webUrl && url.pathname === '/login/oauth/access_token') {
      const pending = this.oauthCodes.get(String(body.code));
      if (!pending) return json(200, { error: 'bad_verification_code' });
      this.oauthCodes.delete(String(body.code));
      if (pending.challenge !== undefined) {
        const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (challenge !== pending.challenge) return json(200, { error: 'invalid_grant' });
      }
      return json(200, this.issueUserToken(pending.user));
    }
    if (url.origin !== this.apiUrl) return json(404, { message: 'Not Found' });
    const path = url.pathname;
    const token = auth.replace(/^Bearer /, '');

    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (conversion && method === 'POST') {
      const pending = this.manifestCodes.get(decodeURIComponent(conversion[1]!));
      if (!pending) return json(404, { message: 'Not Found' });
      this.manifestCodes.delete(decodeURIComponent(conversion[1]!));
      const id = this.nextApp++;
      const slug = String(pending.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs1', format: 'pem' })
        .toString();
      const webhookSecret = randomBytes(16).toString('hex');
      this.apps.set(id, { slug, pem, webhookSecret });
      const owner = typeof pending.owner === 'string' ? pending.owner : 'octo-owner';
      return json(201, {
        id,
        slug,
        name: pending.name,
        owner: { login: owner },
        html_url: `${this.webUrl}/apps/${slug}`,
        client_id: `Iv1.${slug}`,
        client_secret: `secret-${randomBytes(8).toString('hex')}`,
        webhook_secret: webhookSecret,
        pem,
      });
    }
    const appIssuer = () => {
      // A real App JWT has three parts; anything else is refused.
      const parts = token.split('.');
      if (parts.length !== 3) return undefined;
      try {
        const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
          iss?: unknown;
        };
        return Number(payload.iss);
      } catch {
        return undefined;
      }
    };
    const install = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (install && method === 'POST') {
      if (appIssuer() === undefined) return json(401, { message: 'Bad credentials' });
      const t = `ghs_${randomBytes(8).toString('hex')}`;
      this.installationTokens.set(t, Number(install[1]));
      return json(201, { token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    const installation = /^\/app\/installations\/(\d+)$/.exec(path);
    if (installation && method === 'GET') {
      const iss = appIssuer();
      if (iss === undefined) return json(401, { message: 'Bad credentials' });
      const found = this.installations.get(Number(installation[1]));
      if (!found || (found.appId !== null && found.appId !== iss))
        return json(404, { message: 'Not Found' });
      return json(200, { id: Number(installation[1]), account: { login: found.account } });
    }
    if (path === '/installation/repositories' && method === 'GET') {
      const id = this.installationTokens.get(token);
      if (id === undefined) return json(401, { message: 'Bad credentials' });
      const repos = this.installations.get(id)?.repos ?? [];
      return json(200, {
        total_count: repos.length,
        repositories: repos.map((full_name) => ({
          full_name,
          private: true,
          default_branch: 'main',
        })),
      });
    }
    if (path === '/graphql' && method === 'POST') return this.graphql(token, body);
    if (path === '/user' || path === '/user/emails') {
      const user = this.userFor(token);
      if (!user) return json(401, { message: 'Bad credentials' });
      if (path === '/user')
        return json(200, {
          id: user.id,
          login: user.login,
          name: user.name,
          ...(this.noEmailPermission ? { email: user.email } : {}),
        });
      // An app without the "Email addresses" permission can't list a user's emails.
      if (this.noEmailPermission)
        return json(403, { message: 'Resource not accessible by integration' });
      return json(200, [
        ...(user.email
          ? [{ email: user.email, primary: true, verified: user.verified ?? true }]
          : []),
        ...(user.otherEmails ?? []).map((e) => ({ ...e, primary: false })),
      ]);
    }

    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(path);
    if (!m) return json(404, { message: 'Not Found' });
    const user = this.installationTokens.has(token) ? null : this.userFor(token);
    if (!this.installationTokens.has(token) && !user)
      return json(401, { message: 'Bad credentials' });
    const repo = this.repos.get(m[1]!);
    if (!repo) return json(404, { message: 'Not Found' });
    if (user) {
      // A user token can do only what the user may (and the app allows).
      const permission = repo.collaborators.get(user.login.toLowerCase());
      if (!permission || permission === 'none') return json(404, { message: 'Not Found' });
      if (method !== 'GET' && !['write', 'maintain', 'admin'].includes(permission))
        return json(403, { message: 'Resource not accessible by integration' });
    }
    return this.repoRoute(repo, method, decodeURIComponent(m[2]!), url.searchParams, body, user);
  }

  private graphql(token: string, body: Json): Response {
    for (const hook of this.graphqlHooks.splice(0)) hook();
    const user = this.userFor(token);
    if (!user && !this.installationTokens.has(token))
      return json(401, { message: 'Bad credentials' });
    const query = String(body.query ?? '');
    const input = ((body.variables as Json | undefined)?.input ?? {}) as Json;
    const fail = (type: string, message: string) =>
      json(200, { data: null, errors: [{ type, message }] });
    if (query.includes('createCommitOnBranch')) {
      const branchInput = (input.branch ?? {}) as Json;
      const repo = this.repos.get(String(branchInput.repositoryNameWithOwner));
      if (!repo) return fail('NOT_FOUND', 'Could not resolve to a Repository.');
      if (user) {
        const permission = repo.collaborators.get(user.login.toLowerCase());
        if (!permission || !['write', 'maintain', 'admin'].includes(permission))
          return fail(
            'FORBIDDEN',
            `${user.login} does not have the correct permissions to execute \`CreateCommitOnBranch\``,
          );
      }
      const branch = String(branchInput.branchName).replace(/^refs\/heads\//, '');
      const head = repo.refs.get(branch);
      if (!head) return fail('NOT_FOUND', `A ref named "${branch}" does not exist.`);
      if (head !== input.expectedHeadOid)
        return fail(
          'STALE_DATA',
          `Expected branch to point to "${String(input.expectedHeadOid)}" but it did not. Pull and try again.`,
        );
      const changes = (input.fileChanges ?? {}) as Json;
      const tree = new Map(this.fileTree(this.commit(head).tree));
      for (const d of (changes.deletions as Json[] | undefined) ?? []) tree.delete(String(d.path));
      for (const a of (changes.additions as Json[] | undefined) ?? [])
        tree.set(String(a.path), {
          sha: this.putBlob(Buffer.from(String(a.contents), 'base64')),
          mode: '100644',
        });
      const message = (input.message ?? {}) as Json;
      const sha = this.putCommit({
        tree: this.putTree(tree),
        parents: [head],
        message: message.body
          ? `${String(message.headline)}\n\n${String(message.body)}`
          : String(message.headline),
        author: user
          ? this.identityOf(user)
          : { name: 'app[bot]', email: 'app[bot]@users.noreply.github.com' },
        committer: GITHUB_COMMITTER,
        signed: true,
      });
      repo.refs.set(branch, sha);
      return json(200, { data: { createCommitOnBranch: { commit: { oid: sha } } } });
    }
    if (query.includes('markPullRequestReadyForReview')) {
      const id = String(input.pullRequestId);
      for (const repo of this.repos.values()) {
        const pull = repo.pulls.find((p) => `PR_${p.number}` === id);
        if (pull) {
          pull.draft = false;
          return json(200, {
            data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
          });
        }
      }
      return fail('NOT_FOUND', 'Could not resolve to a node.');
    }
    return fail('UNKNOWN', 'Fake GitHub has no such GraphQL operation');
  }

  private repoRoute(
    repo: FakeRepo,
    method: string,
    path: string,
    query: URLSearchParams,
    body: Json,
    user: OAuthUser | null = null,
  ): Response {
    let r: RegExpExecArray | null;
    const actorIdentity = user
      ? this.identityOf(user)
      : { name: 'app[bot]', email: 'app[bot]@users.noreply.github.com' };
    if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(path)) && method === 'GET') {
      const sha = repo.refs.get(r[1]!);
      return sha
        ? json(200, { object: { sha, type: 'commit' } })
        : json(404, { message: 'Not Found' });
    }
    if (path === '/git/refs' && method === 'POST') {
      const name = String(body.ref).replace(/^refs\/heads\//, '');
      if (repo.refs.has(name)) return json(422, { message: 'Reference already exists' });
      if (!this.commits.has(String(body.sha)))
        return json(422, { message: 'Object does not exist' });
      repo.refs.set(name, String(body.sha));
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(path)) && method === 'PATCH') {
      const current = repo.refs.get(r[1]!);
      if (!current) return json(422, { message: 'Reference does not exist' });
      const sha = String(body.sha);
      if (!this.commits.has(sha)) return json(422, { message: 'Object does not exist' });
      if (!body.force && !this.ancestors(sha).includes(current))
        return json(422, { message: 'Update is not a fast forward' });
      const violation = this.signatureViolation(repo, r[1]!, sha);
      if (violation) return violation;
      repo.refs.set(r[1]!, sha);
      return json(200, { object: { sha } });
    }
    if ((r = /^\/git\/commits\/([0-9a-f]+)$/.exec(path)) && method === 'GET') {
      const c = this.commits.get(r[1]!);
      if (!c) return json(404, { message: 'Not Found' });
      return json(200, {
        sha: c.sha,
        tree: { sha: c.tree },
        parents: c.parents.map((sha) => ({ sha })),
        message: c.message,
        author: c.author,
      });
    }
    if (path === '/git/commits' && method === 'POST') {
      const parents = (body.parents as string[]) ?? [];
      if (!this.trees.has(String(body.tree)) || parents.some((p) => !this.commits.has(p)))
        return json(422, { message: 'Object does not exist' });
      const author = body.author as GitIdentity | undefined;
      const sha = this.putCommit({
        tree: String(body.tree),
        parents,
        message: String(body.message),
        author: author ? { name: author.name, email: author.email } : actorIdentity,
      });
      return json(201, { sha });
    }
    if ((r = /^\/git\/trees\/([0-9a-f]+)$/.exec(path)) && method === 'GET') {
      const tree = this.trees.get(r[1]!);
      if (!tree) return json(404, { message: 'Not Found' });
      return json(200, {
        sha: r[1],
        truncated: false,
        tree: [...tree].map(([p, e]) => ({ path: p, mode: e.mode, type: 'blob', sha: e.sha })),
      });
    }
    if (path === '/git/trees' && method === 'POST') {
      const base = this.trees.get(String(body.base_tree));
      if (!base) return json(422, { message: 'base_tree does not exist' });
      const tree = new Map(base);
      for (const e of body.tree as Json[]) {
        if (e.sha === null) tree.delete(String(e.path));
        else if (!this.blobs.has(String(e.sha))) return json(422, { message: 'Bad blob' });
        else tree.set(String(e.path), { sha: String(e.sha), mode: String(e.mode ?? '100644') });
      }
      return json(201, { sha: this.putTree(tree) });
    }
    if ((r = /^\/git\/blobs\/([0-9a-f]+)$/.exec(path)) && method === 'GET') {
      const blob = this.blobs.get(r[1]!);
      if (!blob) return json(404, { message: 'Not Found' });
      return json(200, { sha: r[1], content: blob.toString('base64'), encoding: 'base64' });
    }
    if (path === '/git/blobs' && method === 'POST') {
      const content =
        body.encoding === 'base64'
          ? Buffer.from(String(body.content), 'base64')
          : Buffer.from(String(body.content), 'utf8');
      return json(201, { sha: this.putBlob(content) });
    }
    if (path === '/merges' && method === 'POST') {
      const base = String(body.base);
      const baseSha = repo.refs.get(base);
      const headSha = repo.refs.get(String(body.head)) ?? String(body.head);
      if (!baseSha || !this.commits.has(headSha)) return json(404, { message: 'Not Found' });
      if (this.ancestors(baseSha).includes(headSha)) return json(204);
      const mergeBase = this.mergeBase(baseSha, headSha);
      const merged = mergeBase
        ? this.mergeTrees(
            this.commit(mergeBase).tree,
            this.commit(baseSha).tree,
            this.commit(headSha).tree,
          )
        : null;
      if (!merged) return json(409, { message: 'Merge conflict' });
      // Not documented to be signed by GitHub, so the fake treats it as unsigned.
      const sha = this.putCommit({
        tree: this.putTree(merged),
        parents: [baseSha, headSha],
        message: String(body.commit_message ?? `Merge ${String(body.head)} into ${base}`),
        author: actorIdentity,
      });
      const violation = this.signatureViolation(repo, base, sha);
      if (violation) return violation;
      repo.refs.set(base, sha);
      return json(201, { sha });
    }
    if ((r = /^\/compare\/(.+)\.\.\.(.+)$/.exec(path)) && method === 'GET') {
      const base = repo.refs.get(r[1]!) ?? r[1]!;
      const head = repo.refs.get(r[2]!) ?? r[2]!;
      if (!this.commits.has(base) || !this.commits.has(head))
        return json(404, { message: 'Not Found' });
      const mergeBase = this.mergeBase(base, head)!;
      const from = this.fileTree(this.commit(mergeBase).tree);
      const to = this.fileTree(this.commit(head).tree);
      const files: Json[] = [];
      for (const p of new Set([...from.keys(), ...to.keys()])) {
        const a = from.get(p)?.sha;
        const b = to.get(p)?.sha;
        if (a === b) continue;
        files.push({ filename: p, status: !a ? 'added' : !b ? 'removed' : 'modified' });
      }
      const count = (tip: string) =>
        this.ancestors(tip).filter((c) => !this.ancestors(mergeBase).includes(c)).length;
      return json(200, {
        merge_base_commit: { sha: mergeBase },
        ahead_by: count(head),
        behind_by: count(base),
        files,
      });
    }
    if (path === '/pulls' && method === 'GET') {
      const head = (query.get('head') ?? '').split(':').pop();
      const list = repo.pulls.filter(
        (p) =>
          (!query.get('state') || query.get('state') === 'all' || p.state === query.get('state')) &&
          (!head || p.head === head) &&
          (!query.get('base') || p.base === query.get('base')),
      );
      return json(
        200,
        list.map((p) => this.pullJson(repo, p)),
      );
    }
    if (path === '/pulls' && method === 'POST') {
      const head = String(body.head);
      if (!repo.refs.has(head)) return json(422, { message: 'Validation Failed: head' });
      if (repo.pulls.some((p) => p.head === head && p.state === 'open'))
        return json(422, { message: 'A pull request already exists' });
      const pull: FakePull = {
        number: this.nextPull++,
        head,
        base: String(body.base),
        title: String(body.title),
        body: String(body.body ?? ''),
        draft: body.draft === true,
        openedBy: user?.login ?? 'app',
        state: 'open',
        merged: false,
        mergeCommit: null,
        reviews: [],
      };
      repo.pulls.push(pull);
      return json(201, this.pullJson(repo, pull));
    }
    if ((r = /^\/pulls\/(\d+)(\/reviews|\/merge|\/update-branch)?$/.exec(path))) {
      const pull = repo.pulls.find((p) => p.number === Number(r![1]));
      if (!pull) return json(404, { message: 'Not Found' });
      if (!r[2] && method === 'GET') return json(200, this.pullJson(repo, pull));
      if (!r[2] && method === 'PATCH') {
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        return json(200, this.pullJson(repo, pull));
      }
      if (r[2] === '/reviews' && method === 'GET')
        return json(
          200,
          pull.reviews.map((rv) => ({
            user: { login: rv.user },
            state: rv.state,
            submitted_at: rv.at,
          })),
        );
      if (r[2] === '/merge' && method === 'PUT') return this.mergePull(repo, pull, body);
      if (r[2] === '/update-branch' && method === 'PUT')
        return this.updatePullBranch(repo, pull, body, actorIdentity);
    }
    if (
      (r = /^\/branches\/(.+)\/protection\/required_signatures$/.exec(path)) &&
      method === 'GET'
    ) {
      const rules = repo.protection.get(r[1]!);
      if (rules === 'forbidden')
        return json(403, { message: 'Resource not accessible by integration' });
      if (!rules) return json(404, { message: 'Branch not protected' });
      return json(200, {
        enabled: (rules.required_signatures as Json | undefined)?.enabled === true,
      });
    }
    if ((r = /^\/branches\/(.+)\/protection$/.exec(path)) && method === 'GET') {
      const rules = repo.protection.get(r[1]!);
      if (rules === 'forbidden')
        return json(403, { message: 'Resource not accessible by integration' });
      return rules ? json(200, rules) : json(404, { message: 'Branch not protected' });
    }
    if ((r = /^\/rules\/branches\/(.+)$/.exec(path)) && method === 'GET') {
      const rules = this.rulesFor(repo, r[1]!);
      if (rules === 'forbidden')
        return json(403, { message: 'Resource not accessible by integration' });
      return json(200, rules);
    }
    if ((r = /^\/commits\/([^/]+)\/status$/.exec(path)) && method === 'GET') {
      const statuses = repo.statuses.get(repo.refs.get(r[1]!) ?? r[1]!) ?? [];
      return json(200, { statuses });
    }
    if ((r = /^\/commits\/([^/]+)\/check-runs$/.exec(path)) && method === 'GET') {
      return json(200, { total_count: 0, check_runs: [] });
    }
    if ((r = /^\/collaborators\/([^/]+)\/permission$/.exec(path)) && method === 'GET') {
      const permission = repo.collaborators.get(r[1]!.toLowerCase());
      if (!permission) return json(404, { message: 'Not a collaborator' });
      return json(200, {
        permission: permission === 'maintain' ? 'write' : permission,
        role_name: permission,
      });
    }
    return json(404, { message: `Fake GitHub has no route for ${method} ${path}` });
  }

  private pullJson(repo: FakeRepo, p: FakePull): Json {
    const headSha = repo.refs.get(p.head) ?? null;
    let mergeable: boolean | null = null;
    const baseSha = repo.refs.get(p.base);
    if (p.state === 'open' && headSha && baseSha) {
      const mb = this.mergeBase(baseSha, headSha);
      mergeable =
        mb !== null &&
        this.mergeTrees(
          this.commit(mb).tree,
          this.commit(baseSha).tree,
          this.commit(headSha).tree,
        ) !== null;
    }
    return {
      number: p.number,
      html_url: `${this.webUrl}/pull/${p.number}`,
      state: p.state,
      merged: p.merged,
      mergeable,
      draft: p.draft,
      node_id: `PR_${p.number}`,
      title: p.title,
      body: p.body,
      head: { ref: p.head, sha: headSha },
      base: { ref: p.base },
    };
  }

  /** What branch protection would refuse, like GitHub's 405 "Base branch policy prohibits the merge". */
  private policyBlock(repo: FakeRepo, pull: FakePull, headSha: string): string | null {
    const protection = repo.protection.get(pull.base);
    const rulesets = this.rulesFor(repo, pull.base);
    let approvals = 0;
    const checks: string[] = [];
    if (protection && protection !== 'forbidden') {
      const reviews = protection.required_pull_request_reviews as Json | undefined;
      if (reviews) approvals = (reviews.required_approving_review_count as number | undefined) ?? 1;
      const status = protection.required_status_checks as Json | undefined;
      checks.push(...((status?.contexts as string[] | undefined) ?? []));
    }
    if (Array.isArray(rulesets)) {
      for (const rule of rulesets) {
        const p = (rule.parameters ?? {}) as Json;
        if (rule.type === 'pull_request')
          approvals = Math.max(approvals, (p.required_approving_review_count as number) ?? 0);
        if (rule.type === 'required_status_checks')
          for (const c of (p.required_status_checks as Json[]) ?? [])
            checks.push(String(c.context));
      }
    }
    const latest = new Map<string, string>();
    for (const rv of pull.reviews) if (rv.state !== 'COMMENTED') latest.set(rv.user, rv.state);
    const states = [...latest.values()];
    if (states.includes('CHANGES_REQUESTED')) return 'Changes requested';
    if (states.filter((s) => s === 'APPROVED').length < approvals)
      return 'Base branch policy prohibits the merge: approving review required';
    if (this.requiresSignatures(repo, pull.base)) {
      // GitHub's test merge checks the head branch's commits, though it signs the squash itself.
      const inBase = new Set(this.ancestors(repo.refs.get(pull.base)!));
      if (this.ancestors(headSha).some((c) => !inBase.has(c) && !this.commit(c).signed))
        return 'Base branch policy prohibits the merge: commits must have verified signatures';
    }
    const statuses = repo.statuses.get(headSha) ?? [];
    for (const context of checks) {
      if (statuses.find((s) => s.context === context)?.state !== 'success')
        return `Base branch policy prohibits the merge: required status check "${context}" is expected`;
    }
    return null;
  }

  private mergePull(repo: FakeRepo, pull: FakePull, body: Json): Response {
    if (pull.state !== 'open') return json(405, { message: 'Pull Request is not mergeable' });
    if (pull.draft) return json(405, { message: 'Pull Request is still a draft' });
    const headSha = repo.refs.get(pull.head)!;
    if (body.sha && body.sha !== headSha)
      return json(409, { message: 'Head branch was modified. Review and try the merge again.' });
    const blocked = this.policyBlock(repo, pull, headSha);
    if (blocked) return json(405, { message: blocked });
    const baseSha = repo.refs.get(pull.base)!;
    const mb = this.mergeBase(baseSha, headSha);
    const merged = mb
      ? this.mergeTrees(this.commit(mb).tree, this.commit(baseSha).tree, this.commit(headSha).tree)
      : null;
    if (!merged) return json(405, { message: 'Pull Request is not mergeable' });
    const title = String(body.commit_title ?? pull.title);
    const message = String(body.commit_message ?? '');
    const sha = this.putCommit({
      tree: this.putTree(merged),
      parents: [baseSha],
      message: message ? `${title}\n\n${message}` : title,
      author: { name: 'app[bot]', email: 'app[bot]@users.noreply.github.com' },
      committer: GITHUB_COMMITTER,
      signed: true,
    });
    repo.refs.set(pull.base, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommit = sha;
    return json(200, { merged: true, sha, message: 'Pull Request successfully merged' });
  }

  /** PUT /pulls/{n}/update-branch: GitHub merges the base branch into the head branch and signs it. */
  private updatePullBranch(
    repo: FakeRepo,
    pull: FakePull,
    body: Json,
    author: GitIdentity,
  ): Response {
    if (pull.state !== 'open') return json(422, { message: 'Pull request is closed' });
    const headSha = repo.refs.get(pull.head);
    const baseSha = repo.refs.get(pull.base);
    if (!headSha || !baseSha) return json(422, { message: 'Branch not found' });
    if (body.expected_head_sha && body.expected_head_sha !== headSha)
      return json(422, { message: "expected head sha didn't match current head ref." });
    if (this.ancestors(headSha).includes(baseSha))
      return json(422, { message: 'There are no new commits on the base branch.' });
    const mb = this.mergeBase(headSha, baseSha);
    const merged = mb
      ? this.mergeTrees(this.commit(mb).tree, this.commit(headSha).tree, this.commit(baseSha).tree)
      : null;
    if (!merged) return json(422, { message: 'merge conflict between base and head' });
    const sha = this.putCommit({
      tree: this.putTree(merged),
      parents: [headSha, baseSha],
      message: `Merge branch '${pull.base}' into ${pull.head}`,
      author,
      committer: GITHUB_COMMITTER,
      signed: true,
    });
    repo.refs.set(pull.head, sha);
    return json(202, {
      message: 'Updating pull request branch.',
      url: `${this.webUrl}/pull/${pull.number}`,
    });
  }
}

/** GitHub's ref patterns: `*` within one path segment, `**` across segments. */
function globMatch(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${re}$`).test(name);
}
