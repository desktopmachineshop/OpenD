import { createVerify, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SECRET_BYTES,
  appJwt,
  buildManifest,
  buildSeedYaml,
  checkPrerequisites,
  exchangeManifestCode,
  formatEnvValue,
  generateSecrets,
  githubUrls,
  isPrivateUrl,
  listInstallations,
  mergeEnv,
  newAppUrl,
  nodeVersionOk,
  parseEnv,
  runSetup,
  setAppWebhook,
  startManifestFlow,
} from '../setup.mjs';
import { createTestDatabase, testDatabaseUrl } from '../../packages/store/src/index.js';
import { applySeed } from '../../packages/server/src/seed.js';

const DEPLOY = join(import.meta.dirname, '..');
const { privateKey: PEM, publicKey: PUBLIC_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('env files', () => {
  const example = readFileSync(join(DEPLOY, '.env.example'), 'utf8');

  it('parses bare, quoted and commented lines', () => {
    const env = parseEnv(
      [
        'A=1',
        '# B=2',
        'C="line\\none \\"quoted\\""',
        "D='single # not a comment'",
        'E=value # trailing comment',
        'export F=exported',
        'G=',
      ].join('\n'),
    );
    expect(Object.fromEntries(env)).toEqual({
      A: '1',
      C: 'line\none "quoted"',
      D: 'single # not a comment',
      E: 'value',
      F: 'exported',
      G: '',
    });
  });

  it('fills unset and placeholder values in place, keeps set ones, appends new keys', () => {
    const text = [
      'PUBLIC_URL=https://docs.example',
      'SESSION_SECRET=change-me-change-me',
      'OPEND_ADMIN_TOKEN=',
      '# GITHUB_APP_ID=',
      '# trailing comment',
    ].join('\n');
    const merged = mergeEnv(text, {
      PUBLIC_URL: 'http://other',
      SESSION_SECRET: 's'.repeat(64),
      OPEND_ADMIN_TOKEN: 'a'.repeat(64),
      GITHUB_APP_ID: '42',
      POLL_INTERVAL_SECONDS: '60',
      SKIPPED: undefined,
    });
    expect(merged.written).toEqual([
      'SESSION_SECRET',
      'OPEND_ADMIN_TOKEN',
      'GITHUB_APP_ID',
      'POLL_INTERVAL_SECONDS',
    ]);
    expect(merged.kept).toEqual(['PUBLIC_URL']);
    expect(merged.text).toBe(
      [
        'PUBLIC_URL=https://docs.example',
        `SESSION_SECRET=${'s'.repeat(64)}`,
        `OPEND_ADMIN_TOKEN=${'a'.repeat(64)}`,
        'GITHUB_APP_ID=42',
        '# trailing comment',
        'POLL_INTERVAL_SECONDS=60',
        '',
      ].join('\n'),
    );
  });

  it('is idempotent: merging the same values again changes nothing', () => {
    const values = { SESSION_SECRET: 'x'.repeat(64), GITHUB_APP_PRIVATE_KEY: PEM };
    const once = mergeEnv(example, values);
    const twice = mergeEnv(once.text, { ...values, SESSION_SECRET: 'y'.repeat(64) });
    expect(twice.text).toBe(once.text);
    expect(twice.written).toEqual([]);
    // Comments from the example survive.
    expect(once.text).toContain('# Reader sign-in through your identity provider (OIDC).');
  });

  it('single-quotes values Compose would otherwise interpolate', () => {
    for (const value of ['pa$$word', 'with space', 'a"b', 'x#y']) {
      const text = mergeEnv('', { OIDC_CLIENT_SECRET: value }).text;
      expect(text).toBe(`OIDC_CLIENT_SECRET='${value}'\n`);
      expect(parseEnv(text).get('OIDC_CLIENT_SECRET')).toBe(value);
    }
    expect(formatEnvValue('plain-value_1')).toBe('plain-value_1');
    expect(formatEnvValue("it's")).toBe('"it\'s"');
    expect(() => formatEnvValue('a\n$b')).toThrow(/\$/);
  });

  it('stores a PEM key on one line with escaped newlines, and reads it back', () => {
    const line = formatEnvValue(PEM);
    expect(line).not.toContain('\n');
    expect(line).toMatch(/^"-----BEGIN RSA PRIVATE KEY-----\\n/);
    const text = mergeEnv('', { GITHUB_APP_PRIVATE_KEY: PEM }).text;
    expect(text.split('\n')).toHaveLength(2);
    expect(parseEnv(text).get('GITHUB_APP_PRIVATE_KEY')).toBe(PEM);
  });
});

describe('secrets', () => {
  it('generates hex secrets of the documented lengths, only where unset', () => {
    const env = new Map([['SESSION_SECRET', 'already-set-already-set-already-set']]);
    const secrets = generateSecrets(env, [
      'SESSION_SECRET',
      'OPEND_ADMIN_TOKEN',
      'GITHUB_WEBHOOK_SECRET',
      'POSTGRES_PASSWORD',
      'OPEND_EMBED_SECRET',
    ]);
    expect(Object.keys(secrets)).toEqual([
      'OPEND_ADMIN_TOKEN',
      'GITHUB_WEBHOOK_SECRET',
      'POSTGRES_PASSWORD',
      'OPEND_EMBED_SECRET',
    ]);
    for (const [name, value] of Object.entries(secrets)) {
      expect(value).toMatch(/^[0-9a-f]+$/);
      expect(value).toHaveLength(SECRET_BYTES[name as keyof typeof SECRET_BYTES] * 2);
    }
    // At least the server's minimums (32 for session and embed, 24 for the admin token).
    expect(secrets.OPEND_ADMIN_TOKEN!.length).toBeGreaterThanOrEqual(24);
    expect(secrets.OPEND_EMBED_SECRET!.length).toBeGreaterThanOrEqual(32);
    expect(generateSecrets(new Map(), ['SESSION_SECRET']).SESSION_SECRET).not.toBe(
      generateSecrets(new Map(), ['SESSION_SECRET']).SESSION_SECRET,
    );
  });
});

describe('GitHub App manifest', () => {
  it('asks for push events, read contents and write statuses, pointing at the webhook', () => {
    expect(
      buildManifest({
        name: 'OpenD docs',
        publicUrl: 'https://docs.example.com/',
        redirectUrl: 'http://localhost:8765/callback',
      }),
    ).toEqual({
      name: 'OpenD docs',
      url: 'https://docs.example.com',
      description: 'OpenD docs at https://docs.example.com',
      hook_attributes: { url: 'https://docs.example.com/webhooks/github', active: true },
      redirect_url: 'http://localhost:8765/callback',
      public: false,
      default_permissions: {
        contents: 'read',
        metadata: 'read',
        statuses: 'write',
        pull_requests: 'write',
      },
      default_events: ['push'],
    });
  });

  it('posts to the org or personal settings page, on github.com or GitHub Enterprise', () => {
    expect(githubUrls(undefined, undefined)).toEqual({
      web: 'https://github.com',
      api: 'https://api.github.com',
    });
    expect(githubUrls('https://ghe.example/', undefined)).toEqual({
      web: 'https://ghe.example',
      api: 'https://ghe.example/api/v3',
    });
    expect(githubUrls('https://ghe.example', 'https://api.ghe.example/')).toEqual({
      web: 'https://ghe.example',
      api: 'https://api.ghe.example',
    });
    expect(newAppUrl('https://github.com', 'acme', 's1')).toBe(
      'https://github.com/organizations/acme/settings/apps/new?state=s1',
    );
    expect(newAppUrl('https://github.com', undefined, 's1')).toBe(
      'https://github.com/settings/apps/new?state=s1',
    );
  });

  it('builds a seed file the server accepts', () => {
    const yaml = buildSeedYaml({
      org: {
        slug: 'acme',
        name: 'Acme "Corp"',
        products: ['widget'],
        version: '2.1',
        readers: ['a@acme.example'],
      },
      repo: {
        fullName: 'acme/docs',
        sourceUrl: 'https://github.com/acme/docs.git',
        installationId: 7,
        releaseRefs: ['main', 'v*'],
        docsPath: '.',
      },
    });
    expect(yaml).toContain('name: "Acme \\"Corp\\""');
    expect(yaml).toContain('installationId: 7');
    expect(yaml).toContain('releaseRefs: ["main", "v*"]');
  });
});

type Manifest = {
  redirect_url: string;
  hook_attributes: { url: string; active: boolean };
  [key: string]: unknown;
};

/** A stand-in for github.com: the app creation page and the REST API. */
class FakeGitHub {
  server: Server;
  base = '';
  manifests: { state: string; org?: string; manifest: Manifest }[] = [];
  requests: { method: string; path: string; auth?: string; body: string }[] = [];
  installations = [{ id: 777, account: { login: 'acme' } }];

  constructor() {
    this.server = createServer(async (req, res) => {
      const body = await read(req);
      const url = new URL(req.url ?? '/', this.base);
      this.requests.push({
        method: req.method ?? '',
        path: url.pathname,
        auth: req.headers.authorization,
        body,
      });
      const json = (status: number, data: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      const newApp = /^(?:\/organizations\/([^/]+))?\/settings\/apps\/new$/.exec(url.pathname);
      if (req.method === 'POST' && newApp) {
        const manifest = JSON.parse(new URLSearchParams(body).get('manifest') ?? '{}');
        const state = url.searchParams.get('state') ?? '';
        this.manifests.push({ state, manifest, ...(newApp[1] ? { org: newApp[1] } : {}) });
        const back = new URL(manifest.redirect_url);
        back.searchParams.set('code', 'manifest-code-1');
        back.searchParams.set('state', state);
        return res.writeHead(302, { location: back.toString() }).end();
      }
      if (
        req.method === 'POST' &&
        url.pathname === '/api/v3/app-manifests/manifest-code-1/conversions'
      ) {
        return json(201, {
          id: 4242,
          slug: 'opend-test',
          html_url: `${this.base}/apps/opend-test`,
          pem: PEM,
          webhook_secret: 'github-chosen-webhook-secret',
          client_id: 'Iv1.x',
          client_secret: 'client-secret',
          owner: { login: 'acme' },
        });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/v3/app-manifests/')) {
        return json(404, { message: 'Not Found' });
      }
      if (req.method === 'PATCH' && url.pathname === '/api/v3/app/hook/config')
        return json(200, {});
      if (req.method === 'GET' && url.pathname === '/api/v3/app/installations') {
        return json(200, this.installations);
      }
      json(404, { message: 'Not Found' });
    });
  }

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(resolve));
  }
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const unescapeHtml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Does what the browser does: load the start page, submit its form, follow GitHub's redirect. */
async function browse(startUrl: string): Promise<{ status: number; body: string }> {
  const page = await (await fetch(startUrl)).text();
  const action = unescapeHtml(/action="([^"]+)"/.exec(page)![1]!);
  const manifest = unescapeHtml(/name="manifest" value="([^"]*)"/.exec(page)![1]!);
  const posted = await fetch(action, {
    method: 'POST',
    body: new URLSearchParams({ manifest }),
    redirect: 'manual',
  });
  const back = await fetch(posted.headers.get('location')!);
  return { status: back.status, body: await back.text() };
}

function verifyJwt(jwt: string) {
  const [header, payload, signature] = jwt.split('.');
  const ok = createVerify('RSA-SHA256')
    .update(`${header}.${payload}`)
    .verify(PUBLIC_KEY, signature!, 'base64url');
  return { ok, payload: JSON.parse(Buffer.from(payload!, 'base64url').toString()) };
}

describe('GitHub API calls', () => {
  const github = new FakeGitHub();
  beforeAll(() => github.start());
  afterAll(() => github.stop());

  it('exchanges the manifest code for the app credentials', async () => {
    const app = await exchangeManifestCode(`${github.base}/api/v3`, 'manifest-code-1');
    expect(app).toMatchObject({ id: 4242, slug: 'opend-test', pem: PEM });
    await expect(exchangeManifestCode(`${github.base}/api/v3`, 'expired')).rejects.toThrow(
      'GitHub app manifest conversion failed with 404: Not Found',
    );
  });

  it('authenticates as the app with an RS256 JWT to set the webhook and list installations', async () => {
    github.requests.length = 0;
    const api = `${github.base}/api/v3`;
    await setAppWebhook(
      api,
      { id: 4242, pem: PEM },
      { url: 'https://docs.example/webhooks/github', secret: 'ours' },
    );
    expect(await listInstallations(api, { id: 4242, pem: PEM })).toEqual(github.installations);
    const [patch] = github.requests;
    expect(JSON.parse(patch!.body)).toEqual({
      url: 'https://docs.example/webhooks/github',
      secret: 'ours',
      content_type: 'json',
    });
    const { ok, payload } = verifyJwt(patch!.auth!.replace('Bearer ', ''));
    expect(ok).toBe(true);
    expect(payload.iss).toBe('4242');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(verifyJwt(appJwt(1, PEM, 1000)).payload).toEqual({ iat: 940, exp: 1540, iss: '1' });
  });
});

describe('manifest callback server', () => {
  it('serves a form that posts the manifest, and accepts only the matching state', async () => {
    const flow = await startManifestFlow({
      web: 'https://github.com',
      org: 'acme',
      manifest: (redirectUrl: string) =>
        buildManifest({ name: 'x', publicUrl: 'https://d.example', redirectUrl }),
    });
    try {
      const page = await (await fetch(flow.startUrl)).text();
      expect(unescapeHtml(page)).toContain(
        `action="https://github.com/organizations/acme/settings/apps/new?state=${flow.state}"`,
      );
      expect(unescapeHtml(page)).toContain(`"redirect_url":"${flow.redirectUrl}"`);

      let settled = false;
      void flow.code.then(() => (settled = true));
      const forged = await fetch(`${flow.redirectUrl}?code=attacker&state=${'0'.repeat(32)}`);
      expect(forged.status).toBe(400);
      expect((await fetch(`${flow.redirectUrl}?code=attacker`)).status).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false);

      const ok = await fetch(`${flow.redirectUrl}?code=real-code&state=${flow.state}`);
      expect(ok.status).toBe(200);
      expect(await flow.code).toBe('real-code');
    } finally {
      await flow.close();
    }
  });

  it('times out if GitHub never redirects back', async () => {
    const flow = await startManifestFlow({
      web: 'https://github.com',
      manifest: () => ({}),
      timeoutMs: 20,
    });
    await expect(flow.code).rejects.toThrow(/timed out/);
    await flow.close();
  });
});

describe('prerequisites', () => {
  const runner =
    (failing: string[] = []) =>
    async (cmd: string, args: string[]) => ({
      code: failing.some((f) => `${cmd} ${args.join(' ')}`.startsWith(f)) ? 1 : 0,
      stdout: '',
      stderr: '',
    });

  it('checks Node, Docker, Compose and the Docker daemon', async () => {
    expect(nodeVersionOk('22.12.0')).toBe(true);
    expect(nodeVersionOk('23.0.0')).toBe(true);
    expect(nodeVersionOk('22.11.9')).toBe(false);
    expect(await checkPrerequisites(runner(), { nodeVersion: '22.12.0' })).toEqual({
      problems: [],
      docker: true,
    });
    expect(
      await checkPrerequisites(runner(['docker --version']), { nodeVersion: '20.1.0' }),
    ).toEqual({
      problems: [
        expect.stringMatching(/Node 22.12/),
        expect.stringMatching(/Docker is not installed/),
      ],
      docker: false,
    });
    expect(
      (await checkPrerequisites(runner(['docker compose']), { nodeVersion: '22.12.0' })).problems,
    ).toEqual([expect.stringMatching(/Compose/)]);
    expect(
      (await checkPrerequisites(runner(['docker info']), { nodeVersion: '22.12.0' })).problems,
    ).toEqual([expect.stringMatching(/daemon is not running/)]);
  });

  it('knows which URLs GitHub cannot reach', () => {
    expect(isPrivateUrl('http://localhost:3000')).toBe(true);
    expect(isPrivateUrl('http://192.168.1.10')).toBe(true);
    expect(isPrivateUrl('http://172.20.0.1')).toBe(true);
    expect(isPrivateUrl('https://docs.example.com')).toBe(false);
  });
});

describe('runSetup (non-interactive, Docker stubbed)', () => {
  const github = new FakeGitHub();
  let dir: string;
  let commands: string[];
  let logs: string[];
  const url = testDatabaseUrl();

  const run = async (cmd: string, args: string[]) => {
    commands.push(`${cmd} ${args.join(' ')}`.replace(dir, '<deploy>'));
    // No Postgres volume from an earlier install.
    return { code: args[0] === 'volume' ? 1 : 0, stdout: '', stderr: '' };
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith('/healthz')
      ? new Response('{"status":"ok"}')
      : fetch(input, init)) as typeof fetch;
  const deps = () => ({
    deployDir: dir,
    run,
    fetchImpl,
    nodeVersion: '22.12.0',
    io: {
      ask: async (_q: string, fallback = '') => fallback,
      log: (m: string) => void logs.push(m),
      open: async (startUrl: string) => {
        const back = await browse(startUrl);
        expect(back.status).toBe(200);
      },
    },
  });
  const ARGS = [
    '--non-interactive',
    '--public-url',
    'http://localhost:3000',
    '--github-app',
    '--github-org',
    'acme',
    '--github-url',
    '',
    '--org-slug',
    'acme',
    '--org-name',
    'Acme Corp',
    '--reader-email',
    'ann@acme.example',
    '--entitled-version',
    '2.1',
    '--repo',
    'acme/docs',
  ];

  beforeAll(() => github.start());
  afterAll(() => github.stop());
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opend-setup-'));
    copyFileSync(join(DEPLOY, '.env.example'), join(dir, '.env.example'));
    copyFileSync(join(DEPLOY, 'docker-compose.yml'), join(dir, 'docker-compose.yml'));
    commands = [];
    logs = [];
    ARGS[ARGS.indexOf('--github-url') + 1] = github.base;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes .env, creates the GitHub App, writes the seed, starts and seeds', async () => {
    const result = await runSetup(ARGS, deps());
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(env.get('PUBLIC_URL')).toBe('http://localhost:3000');
    expect(env.get('SESSION_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    expect(env.get('OPEND_ADMIN_TOKEN')).toMatch(/^[0-9a-f]{64}$/);
    expect(env.get('POSTGRES_PASSWORD')).toMatch(/^[0-9a-f]{48}$/);
    expect(env.get('POLL_INTERVAL_SECONDS')).toBe('60'); // localhost: GitHub cannot reach it
    expect(env.get('GITHUB_APP_ID')).toBe('4242');
    expect(env.get('GITHUB_APP_PRIVATE_KEY')).toBe(PEM);
    expect(env.get('GITHUB_WEBHOOK_SECRET')).toBe('github-chosen-webhook-secret');
    expect(env.get('GITHUB_API_URL')).toBe(`${github.base}/api/v3`);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toMatch(
      /^GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n.*\\n"$/m,
    );

    const [created] = github.manifests;
    expect(created).toMatchObject({
      org: 'acme',
      manifest: {
        hook_attributes: { url: 'http://localhost:3000/webhooks/github', active: false },
        default_events: ['push'],
        public: false,
      },
    });
    expect(result?.installUrl).toBe(`${github.base}/apps/opend-test/installations/new`);

    const seed = readFileSync(join(dir, 'seed', 'seed.yaml'), 'utf8');
    expect(seed).toContain('installationId: 777');
    expect(seed).toContain(`sourceUrl: "${github.base}/acme/docs.git"`);
    expect(seed).toContain('readers: ["ann@acme.example"]');

    expect(commands).toEqual([
      'docker --version',
      'docker compose version',
      'docker info --format {{.ServerVersion}}',
      'docker volume inspect opend_pgdata',
      'docker compose -f <deploy>/docker-compose.yml up -d --build',
      'docker compose -f <deploy>/docker-compose.yml run --rm migrate seed /seed/seed.yaml',
    ]);
    expect(logs.join('\n')).not.toContain(env.get('OPEND_ADMIN_TOKEN'));

    // A second run changes nothing and creates no second app.
    const before = readFileSync(join(dir, '.env'), 'utf8');
    commands = [];
    await runSetup([...ARGS, '--no-start'], deps());
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(before);
    expect(github.manifests).toHaveLength(1);
    expect(readFileSync(join(dir, 'seed', 'seed.yaml'), 'utf8')).toBe(seed);
    expect(commands.some((c) => c.includes(' up '))).toBe(false);
    expect(logs.join('\n')).toContain('docker compose -f');
  });

  it.skipIf(!url)('writes a seed file that opend-server seed loads', async () => {
    await runSetup(
      [...ARGS.filter((a) => a !== '--github-app'), '--no-github-app', '--no-start'],
      deps(),
    );
    const db = await createTestDatabase(url!);
    try {
      expect(
        await applySeed(db.pool, readFileSync(join(dir, 'seed', 'seed.yaml'), 'utf8')),
      ).toEqual({
        repos: 1,
        orgs: 1,
        readers: 1,
      });
    } finally {
      await db.drop();
    }
  });

  it('keeps an existing webhook secret and points the new app at it', async () => {
    writeFileSync(
      join(dir, '.env'),
      'GITHUB_WEBHOOK_SECRET=our-existing-secret\nPOLL_INTERVAL_SECONDS=0\n',
    );
    github.requests.length = 0;
    await runSetup([...ARGS, '--public-url', 'https://docs.example.com', '--no-start'], deps());
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    expect(env.get('GITHUB_WEBHOOK_SECRET')).toBe('our-existing-secret');
    expect(env.get('PUBLIC_URL')).toBe('https://docs.example.com');
    const patch = github.requests.find((r) => r.method === 'PATCH');
    expect(JSON.parse(patch!.body)).toMatchObject({
      secret: 'our-existing-secret',
      url: 'https://docs.example.com/webhooks/github',
    });
    expect(github.manifests.at(-1)!.manifest.hook_attributes.active).toBe(true);
  });

  it('without an app, generates the webhook secret and needs no GitHub at all', async () => {
    await runSetup(
      [
        '--non-interactive',
        '--public-url',
        'https://docs.example.com',
        '--no-start',
        '--embed-origins',
        'https://app.example.com, https://b.example.com',
      ],
      deps(),
    );
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
    expect(env.get('GITHUB_WEBHOOK_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    expect(env.get('GITHUB_APP_ID')).toBeUndefined();
    expect(env.get('POLL_INTERVAL_SECONDS')).toBeUndefined();
    expect(env.get('OPEND_EMBED_ORIGINS')).toBe('https://app.example.com,https://b.example.com');
    expect(env.get('OPEND_EMBED_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    expect(() => readFileSync(join(dir, 'seed', 'seed.yaml'))).toThrow();
  });

  it('stops early without Docker unless told not to start', async () => {
    const noDocker = async (cmd: string, args: string[]) => {
      commands.push(`${cmd} ${args.join(' ')}`);
      return { code: 127, stdout: '', stderr: 'not found' };
    };
    await expect(
      runSetup(['--non-interactive', '--public-url', 'https://docs.example.com'], {
        ...deps(),
        run: noDocker,
      }),
    ).rejects.toThrow(/Docker is needed/);
    await runSetup(
      ['--non-interactive', '--public-url', 'https://docs.example.com', '--no-start'],
      {
        ...deps(),
        run: noDocker,
      },
    );
    expect(parseEnv(readFileSync(join(dir, '.env'), 'utf8')).get('SESSION_SECRET')).toMatch(
      /^[0-9a-f]{64}$/,
    );
    await expect(
      runSetup(['--non-interactive', '--no-start'], { ...deps(), nodeVersion: '20.0.0' }),
    ).rejects.toThrow(/Node version/);
    await expect(runSetup(['--bogus'], deps())).rejects.toThrow(/bogus/);
  });
});
