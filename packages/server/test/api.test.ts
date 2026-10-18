import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeGitHub } from '@opend/editor';
import type { ReaderContext } from '@opend/model';
import { FsBlobStore, enqueueJob, testDatabaseUrl, upsertRepo } from '@opend/store';
import { createDocsRepo, processNext, type DocsRepo } from '@opend/worker';
import { MARKERS } from '../../cli/test/markers.js';
import { OPENAPI, applySeed } from '../src/index.js';
import { STARTER, admin, startHarness, type Harness } from './helpers.js';

const url = testDatabaseUrl();

const ORGS: Record<string, ReaderContext> = {
  acme: { products: ['widget'], features: [], version: '1.4' },
  globex: { products: ['widget', 'gadget'], features: ['sso', 'audit-log'], version: '2.1' },
};

function starterFiles(): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const entry of readdirSync(STARTER, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    files[relative(STARTER, abs).split(sep).join('/')] = readFileSync(abs);
  }
  return files;
}

describe.skipIf(!url)('public API (/api/v1)', () => {
  let h: Harness;
  let docs: DocsRepo;
  const gh = new FakeGitHub();
  const keys: Record<string, string> = {};
  const call = (method: 'GET' | 'POST', path: string, key: string | null, payload?: object) =>
    h.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: key ? { authorization: `Bearer ${key}` } : {},
      ...(payload ? { payload } : {}),
    });
  const get = (path: string, key: string | null) => call('GET', path, key);
  const makeKey = async (body: object) => {
    const res = await admin(h.app, 'POST', '/api-keys', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: number; token: string };
  };

  beforeAll(async () => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    h = await startHarness(url!, {
      githubFetch: gh.fetch,
      config: { github: { appId: '1', privateKey, apiUrl: gh.apiUrl } },
    });
    gh.createRepo('acme/docs', starterFiles());
    docs = createDocsRepo(STARTER);
    const repo = await upsertRepo(h.db.pool, {
      fullName: 'acme/docs',
      sourceUrl: docs.dir,
      installationId: 42,
      releaseRefs: ['main', 'v*'],
    });
    await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'main', sha: docs.head() });
    const config = readFileSync(join(docs.dir, 'opend.config.yaml'), 'utf8');
    const v1 = docs.commit({
      'opend.config.yaml': config.replace(/^release: .*$/m, 'release: "1.4"'),
    });
    await enqueueJob(h.db.pool, { repoId: repo.id, ref: 'v1', sha: v1 });
    const deps = { pool: h.db.pool, blobs: new FsBlobStore(h.blobDir), log: () => {} };
    expect(await processNext(deps)).toBe('published');
    expect(await processNext(deps)).toBe('published');
    await applySeed(
      h.db.pool,
      `orgs:
  - { slug: acme, name: Acme, entitlements: { products: [widget], version: "1.4" } }
  - { slug: globex, name: Globex, entitlements: { products: [widget, gadget], features: [sso, audit-log], version: "2.1" } }
`,
    );
    keys.staff = (
      await makeKey({ name: 'Staff reader', scopes: ['read'], audience: 'staff' })
    ).token;
    keys.acme = (
      await makeKey({ name: 'Acme bot', scopes: ['read'], audience: 'org', org: 'acme' })
    ).token;
    keys.globex = (
      await makeKey({ name: 'Globex bot', scopes: ['read'], audience: 'org', org: 'globex' })
    ).token;
    keys.public = (await makeKey({ name: 'Public', scopes: ['read'], audience: 'public' })).token;
    keys.writer = (
      await makeKey({ name: 'Docs assistant', scopes: ['write'], audience: 'staff' })
    ).token;
    keys.builder = (
      await makeKey({ name: 'CI', scopes: ['read', 'builds'], audience: 'staff' })
    ).token;
  });
  afterAll(async () => {
    await h?.close();
    docs?.remove();
  });

  it('refuses missing, malformed, revoked and expired keys', async () => {
    const none = await get('/me', null);
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer realm="opend"');
    expect((await get('/me', 'opd_nope')).statusCode).toBe(401);
    // A genuine prefix with the wrong secret.
    const forged = `${keys.staff!.slice(0, 17)}${'A'.repeat(43)}`;
    expect((await get('/me', forged)).statusCode).toBe(401);
    const revoked = await makeKey({ name: 'Old', scopes: ['read'], audience: 'staff' });
    expect((await get('/me', revoked.token)).statusCode).toBe(200);
    expect((await admin(h.app, 'DELETE', `/api-keys/${revoked.id}`)).statusCode).toBe(204);
    expect((await get('/me', revoked.token)).statusCode).toBe(401);
    await h.db.pool.query(
      `update api_keys set expires_at = now() - interval '1 minute' where id = $1`,
      [(await makeKey({ name: 'Expired', scopes: ['read'], audience: 'staff' })).id],
    );
    const listed = (await admin(h.app, 'GET', '/api-keys')).json() as { name: string }[];
    expect(listed.map((k) => k.name)).toContain('Expired');
    // The admin API never returns a token or its hash after creation.
    const raw = JSON.stringify(listed);
    expect(raw).not.toContain(keys.staff!.slice(18));
    expect(raw).not.toMatch(/secret|hash/i);
  });

  it('describes the calling key', async () => {
    const res = await get('/me', keys.acme!);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json()).toMatchObject({
      key: { name: 'Acme bot', scopes: ['read'], audience: 'org', org: 'acme' },
      site: { url: 'http://docs.test' },
    });
  });

  it('serves an OpenAPI description of every route', async () => {
    const res = await get('/openapi.json', null);
    expect(res.statusCode).toBe(200);
    const spec = res.json() as typeof OPENAPI & { servers: { url: string }[] };
    expect(spec.servers[0]!.url).toBe('http://docs.test/api/v1');
    for (const [path, methods] of Object.entries(spec.paths))
      for (const method of Object.keys(methods)) {
        const concrete = path.replace('{id}', 'x/y').replace('{path}', 'topics/a.dita');
        expect(
          h.app.hasRoute({
            method: method.toUpperCase() as 'GET',
            url: `/api/v1${concrete.replace(/\/x\/y$|\/topics\/a\.dita$/, '/*')}`,
          }),
          `${method} ${path}`,
        ).toBe(true);
      }
  });

  it('lists release lines: all for staff, their own for an org', async () => {
    const staff = (await get('/versions', keys.staff!)).json() as {
      current: string;
      versions: { line: string }[];
    };
    expect(staff.current).toBe('2');
    expect(staff.versions.map((v) => v.line).sort()).toEqual(['1', '2']);
    const acme = (await get('/versions', keys.acme!)).json() as typeof staff;
    expect(acme).toMatchObject({ current: '1', versions: [{ line: '1' }] });
    expect((await get('/topics?version=2', keys.acme!)).statusCode).toBe(403);
    expect((await get('/topics?version=1', keys.staff!)).statusCode).toBe(200);
  });

  it('never shows an org key anything its readers could not see', async () => {
    for (const [org, context] of Object.entries(ORGS)) {
      const key = keys[org]!;
      const list = (await get('/topics', key)).json() as {
        topics: { id: string; title: string }[];
      };
      const nav = (await get('/nav', key)).body;
      let html = nav + JSON.stringify(list);
      let markdown = html;
      for (const t of list.topics) {
        html += (await get(`/topics/${t.id}?format=html`, key)).body;
        markdown += (await get(`/topics/${t.id}`, key)).body;
        markdown += (await get(`/topics/${t.id}?format=text`, key)).body;
      }
      for (const [phrase, rule] of MARKERS) {
        const plain = phrase.replace(/^>|<$/g, '');
        if (phrase.startsWith('>')) {
          // A navigation label: in the API's JSON navigation, a title.
          expect(nav.includes(`"title":"${plain}"`), `${org} nav ${phrase}`).toBe(rule(context));
          continue;
        }
        expect(html.includes(phrase), `${org} html ${phrase}`).toBe(rule(context));
        expect(markdown.includes(plain), `${org} markdown ${phrase}`).toBe(rule(context));
        const search = JSON.stringify(
          ((await get(`/search?q=${encodeURIComponent(plain)}`, key)).json() as { hits: unknown })
            .hits,
        );
        if (!rule(context)) expect(search.includes(plain), `${org} search ${phrase}`).toBe(false);
      }
    }
  });

  it('labels conditional content for staff keys only', async () => {
    const staff = (await get('/topics/topics/overview', keys.staff!)).json() as { content: string };
    expect(staff.content).toContain('Only for');
    expect(staff.content).toMatch(/^# /m);
    const globex = (await get('/topics/topics/overview', keys.globex!)).json() as {
      content: string;
    };
    expect(globex.content).not.toContain('Only for');
    expect(globex.content).toContain('Single sign-on is available');
  });

  it('hides topics an org cannot see, as not found', async () => {
    const res = await get('/topics/topics/gadget-pairing', keys.acme!);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('Gadget');
    expect((await get('/topics/topics/gadget-pairing', keys.globex!)).statusCode).toBe(200);
  });

  it('searches, and wants a query', async () => {
    expect((await get('/search', keys.staff!)).statusCode).toBe(400);
    const res = (await get('/search?q=install', keys.staff!)).json() as {
      hits: { topicId: string; url: string }[];
    };
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0]!.url).toMatch(/^http:\/\/docs\.test\/.+\.html$/);
  });

  it('reads as anonymous visitors only on public sites', async () => {
    expect((await get('/topics', keys.public!)).statusCode).toBe(403);
    const repo = ((await admin(h.app, 'GET', '/repos')).json() as { id: number }[])[0]!;
    await admin(h.app, 'PUT', `/repos/${repo.id}/access`, {
      access: 'public',
      publicEntitlements: { products: ['widget'], features: [], version: '2.1' },
    });
    const list = (await get('/topics', keys.public!)).json() as { topics: { id: string }[] };
    expect(list.topics.map((t) => t.id)).not.toContain('topics/gadget-pairing');
    await admin(h.app, 'PUT', `/repos/${repo.id}/access`, { access: 'private' });
  });

  it('keeps write and build endpoints behind their scopes', async () => {
    expect((await get('/source/files', keys.staff!)).statusCode).toBe(403);
    expect((await call('POST', '/changes', keys.staff!, { files: [] })).statusCode).toBe(403);
    expect((await get('/builds', keys.writer!)).statusCode).toBe(403);
    expect((await get('/builds', keys.builder!)).statusCode).toBe(200);
  });

  it('reads the source and validates a change without saving it', async () => {
    const files = (await get('/source/files', keys.writer!)).json() as {
      files: { path: string }[];
    };
    expect(files.files.map((f) => f.path)).toContain('topics/install.dita');
    const file = (await get('/source/files/topics/install.dita', keys.writer!)).json() as {
      content: string;
      sha: string;
    };
    expect(file.content).toContain('<task id="install">');
    const broken = (
      await call('POST', '/validate', keys.writer!, {
        files: [{ path: 'topics/install.dita', content: '<task id="install"><title>x</task>' }],
      })
    ).json() as { valid: boolean; diagnostics: { code: string }[] };
    expect(broken.valid).toBe(false);
    expect(broken.diagnostics.map((d) => d.code)).toContain('xml-syntax');
    expect(
      (
        await call('POST', '/validate', keys.writer!, {
          files: [{ path: '../etc/passwd.dita', content: 'x' }],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('saves to the key’s own branch and opens a pull request without merging', async () => {
    const original = (await get('/source/files/topics/install.dita', keys.writer!)).json() as {
      content: string;
      sha: string;
    };
    const content = original.content.replace('<shortdesc>', '<shortdesc>API-MARKER ');
    const saved = await call('POST', '/changes', keys.writer!, {
      files: [{ path: 'topics/install.dita', content }],
      message: 'Mention the API',
      expectSha: original.sha,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const body = saved.json() as { branch: string; commit: string };
    expect(body.branch).toMatch(/^editor\//);
    expect(gh.readFile('acme/docs', body.branch, 'topics/install.dita')).toContain('API-MARKER');
    expect(gh.readFile('acme/docs', 'main', 'topics/install.dita')).not.toContain('API-MARKER');
    const commit = gh.commit(body.commit);
    expect(commit.author.name).toBe('Docs assistant (API key)');
    // A stale expectSha is refused rather than overwriting the newer commit.
    expect(
      (
        await call('POST', '/changes', keys.writer!, {
          files: [{ path: 'topics/install.dita', content: content.replace('API-MARKER', 'OTHER') }],
          expectSha: original.sha,
        })
      ).statusCode,
    ).toBe(409);
    // Without the publish scope, merge is refused; a pull request is fine.
    expect((await call('POST', '/changes/publish', keys.writer!, { merge: true })).statusCode).toBe(
      403,
    );
    const published = await call('POST', '/changes/publish', keys.writer!, {});
    expect(published.statusCode, published.body).toBe(200);
    const outcome = published.json() as {
      pull: { number: number; state: string };
      merged: boolean;
    };
    expect(outcome).toMatchObject({ merged: false, pull: { state: 'open' } });
    expect(gh.readFile('acme/docs', 'main', 'topics/install.dita')).not.toContain('API-MARKER');
    const state = (await get('/changes', keys.writer!)).json() as { pull: { number: number } };
    expect(state.pull.number).toBe(outcome.pull.number);
  });

  it('merges with the publish scope when the rules allow', async () => {
    const publisher = (
      await makeKey({ name: 'Release bot', scopes: ['publish'], audience: 'staff' })
    ).token;
    const file = (await get('/source/files/topics/configure.dita', publisher)).json() as {
      content: string;
    };
    expect(
      (
        await call('POST', '/changes', publisher, {
          files: [
            {
              path: 'topics/configure.dita',
              content: file.content.replace('<title>', '<title>Now '),
            },
          ],
        })
      ).statusCode,
    ).toBe(200);
    const res = (await call('POST', '/changes/publish', publisher, { merge: true })).json() as {
      merged: boolean;
    };
    expect(res.merged).toBe(true);
    expect(gh.readFile('acme/docs', 'main', 'topics/configure.dita')).toContain('<title>Now ');
  });

  it('rate-limits each key', async () => {
    const key = (await makeKey({ name: 'Busy', scopes: ['read'], audience: 'staff' })).token;
    let last = 200;
    for (let i = 0; i < 301; i++) last = (await get('/me', key)).statusCode;
    expect(last).toBe(429);
    expect((await get('/me', keys.staff!)).statusCode).toBe(200);
  });
});
