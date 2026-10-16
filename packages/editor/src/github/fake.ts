import { createHash, randomBytes } from 'node:crypto';
import type { GitIdentity, Permission } from './client.js';

type Json = Record<string, unknown>;

export interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: GitIdentity;
}

interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
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
  private readonly blobs = new Map<string, Buffer>();
  private readonly trees = new Map<string, FileTree>();
  private readonly commits = new Map<string, FakeCommit>();
  private readonly repos = new Map<string, FakeRepo>();
  private readonly oauthCodes = new Map<string, OAuthUser>();
  private readonly oauthTokens = new Map<string, OAuthUser>();
  private readonly installationTokens = new Set<string>();
  private nextPull = 1;
  private clock = 0;
  /** Every request, for assertions: `METHOD /path`. */
  readonly requests: string[] = [];

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as Json) : {};
    const headers = new Headers(init?.headers);
    this.requests.push(`${method} ${url.pathname}`);
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

  /** Makes `code` a valid OAuth callback code for this GitHub user. */
  addOAuthCode(code: string, user: OAuthUser): void {
    this.oauthCodes.set(code, user);
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

  private putCommit(c: Omit<FakeCommit, 'sha'>): string {
    const sha = sha1(`commit ${JSON.stringify(c)} ${this.clock++}`);
    this.commits.set(sha, { ...c, sha });
    return sha;
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

  // ---- HTTP -----------------------------------------------------------------

  private handle(method: string, url: URL, body: Json, auth: string): Response {
    if (url.origin === this.webUrl && url.pathname === '/login/oauth/access_token') {
      const user = this.oauthCodes.get(String(body.code));
      if (!user) return json(200, { error: 'bad_verification_code' });
      this.oauthCodes.delete(String(body.code));
      const token = `gho_${randomBytes(8).toString('hex')}`;
      this.oauthTokens.set(token, user);
      return json(200, { access_token: token, token_type: 'bearer' });
    }
    if (url.origin !== this.apiUrl) return json(404, { message: 'Not Found' });
    const path = url.pathname;
    const token = auth.replace(/^Bearer /, '');

    const install = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (install && method === 'POST') {
      // A real App JWT has three parts; anything else is refused.
      if (token.split('.').length !== 3) return json(401, { message: 'Bad credentials' });
      const t = `ghs_${randomBytes(8).toString('hex')}`;
      this.installationTokens.add(t);
      return json(201, { token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (path === '/user' || path === '/user/emails') {
      const user = this.oauthTokens.get(token);
      if (!user) return json(401, { message: 'Bad credentials' });
      if (path === '/user') return json(200, { id: user.id, login: user.login, name: user.name });
      return json(
        200,
        user.email ? [{ email: user.email, primary: true, verified: user.verified ?? true }] : [],
      );
    }

    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(path);
    if (!m) return json(404, { message: 'Not Found' });
    if (!this.installationTokens.has(token)) return json(401, { message: 'Bad credentials' });
    const repo = this.repos.get(m[1]!);
    if (!repo) return json(404, { message: 'Not Found' });
    return this.repoRoute(repo, method, decodeURIComponent(m[2]!), url.searchParams, body);
  }

  private repoRoute(
    repo: FakeRepo,
    method: string,
    path: string,
    query: URLSearchParams,
    body: Json,
  ): Response {
    let r: RegExpExecArray | null;
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
        author: author ? { name: author.name, email: author.email } : { name: 'app', email: '' },
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
      const sha = this.putCommit({
        tree: this.putTree(merged),
        parents: [baseSha, headSha],
        message: String(body.commit_message ?? `Merge ${String(body.head)} into ${base}`),
        author: { name: 'app[bot]', email: 'app[bot]@users.noreply.github.com' },
      });
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
        state: 'open',
        merged: false,
        mergeCommit: null,
        reviews: [],
      };
      repo.pulls.push(pull);
      return json(201, this.pullJson(repo, pull));
    }
    if ((r = /^\/pulls\/(\d+)(\/reviews|\/merge)?$/.exec(path))) {
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
    }
    if ((r = /^\/branches\/(.+)\/protection$/.exec(path)) && method === 'GET') {
      const rules = repo.protection.get(r[1]!);
      if (rules === 'forbidden')
        return json(403, { message: 'Resource not accessible by integration' });
      return rules ? json(200, rules) : json(404, { message: 'Branch not protected' });
    }
    if ((r = /^\/rules\/branches\/(.+)$/.exec(path)) && method === 'GET') {
      const rules = repo.rulesets.get(r[1]!);
      if (rules === 'forbidden')
        return json(403, { message: 'Resource not accessible by integration' });
      return json(200, rules ?? []);
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
      title: p.title,
      body: p.body,
      head: { ref: p.head, sha: headSha },
      base: { ref: p.base },
    };
  }

  /** What branch protection would refuse, like GitHub's 405 "Base branch policy prohibits the merge". */
  private policyBlock(repo: FakeRepo, pull: FakePull, headSha: string): string | null {
    const protection = repo.protection.get(pull.base);
    const rulesets = repo.rulesets.get(pull.base);
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
    const statuses = repo.statuses.get(headSha) ?? [];
    for (const context of checks) {
      if (statuses.find((s) => s.context === context)?.state !== 'success')
        return `Base branch policy prohibits the merge: required status check "${context}" is expected`;
    }
    return null;
  }

  private mergePull(repo: FakeRepo, pull: FakePull, body: Json): Response {
    if (pull.state !== 'open') return json(405, { message: 'Pull Request is not mergeable' });
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
    });
    repo.refs.set(pull.base, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommit = sha;
    return json(200, { merged: true, sha, message: 'Pull Request successfully merged' });
  }
}
