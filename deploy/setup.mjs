#!/usr/bin/env node
// @ts-check
/**
 * OpenD self-hosting setup. Needs only Node 22 and Docker, no install step:
 *
 *   node deploy/setup.mjs                 # asks questions
 *   node deploy/setup.mjs --help          # every flag, for non-interactive use
 *
 * It checks prerequisites, writes deploy/.env (generated secrets, never
 * overwriting a value already set), creates a GitHub App through GitHub's
 * App Manifest flow, writes deploy/seed/seed.yaml with a first org, reader
 * and repo, then starts the stack (migrations run on start) and loads the seed.
 * Running it again is safe: it only fills in what is missing.
 */
import { spawn } from 'node:child_process';
import { createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const MIN_NODE = [22, 12];

// ---------------------------------------------------------------------------
// .env files

/**
 * Parses KEY=value lines, ignoring comments. Double-quoted values may use
 * \n, \" and \\ escapes, as Docker Compose reads them.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = /** @type {[string, string, string]} */ (m);
    values.set(key, parseValue(raw));
  }
  return values;
}

/** @param {string} raw */
function parseValue(raw) {
  if (raw.startsWith('"')) {
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i];
      if (c === '"') return out;
      if (c === '\\' && i + 1 < raw.length) {
        const n = raw[++i];
        out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
      } else out += c;
    }
    return out;
  }
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  return raw.replace(/\s+#.*$/, '').trim();
}

/**
 * Formats a value for an env file: bare when safe; single-quoted, which
 * Compose takes literally (no `$` interpolation), when it fits on one line;
 * otherwise double-quoted with newlines escaped, so a PEM key becomes one line.
 * @param {string} value
 */
export function formatEnvValue(value) {
  if (/^[A-Za-z0-9_\-.:/@+=,]*$/.test(value)) return value;
  if (!/['\r\n]/.test(value)) return `'${value}'`;
  if (value.includes('$')) {
    throw new Error('cannot store a multi-line value containing $ in an env file');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/**
 * A value counts as unset when it is missing, empty, or still the
 * placeholder from .env.example.
 * @param {string | undefined} value
 */
export function isUnset(value) {
  return value === undefined || value.trim() === '' || /^change-?me/i.test(value);
}

/**
 * Fills in keys that are unset, in place: an existing `KEY=` line or a
 * commented-out `# KEY=` example line is replaced, otherwise the key is
 * appended. Keys that already have a value are never changed.
 * @param {string} text
 * @param {Record<string, string | undefined>} updates
 * @returns {{ text: string, written: string[], kept: string[] }}
 */
export function mergeEnv(text, updates) {
  const current = parseEnv(text);
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const written = [];
  const kept = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (!isUnset(current.get(key))) {
      kept.push(key);
      continue;
    }
    const line = `${key}=${formatEnvValue(value)}`;
    const set = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const example = new RegExp(`^\\s*#\\s*${key}\\s*=`);
    let at = lines.findIndex((l) => set.test(l));
    if (at === -1) at = lines.findIndex((l) => example.test(l));
    if (at === -1) lines.push(line);
    else lines[at] = line;
    current.set(key, value);
    written.push(key);
  }
  return { text: `${lines.join('\n')}\n`, written, kept };
}

// ---------------------------------------------------------------------------
// Secrets

/** Secret name → random bytes; hex-encoded, so every value is URL- and shell-safe. */
export const SECRET_BYTES = {
  SESSION_SECRET: 32,
  OPEND_ADMIN_TOKEN: 32,
  GITHUB_WEBHOOK_SECRET: 32,
  POSTGRES_PASSWORD: 24,
  OPEND_EMBED_SECRET: 32,
  ENTITLEMENT_WEBHOOK_SECRET: 32,
};

/**
 * Generates the named secrets that are unset in `env`.
 * @param {Map<string, string>} env
 * @param {(keyof typeof SECRET_BYTES)[]} names
 * @returns {Record<string, string>}
 */
export function generateSecrets(env, names) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of names) {
    if (isUnset(env.get(name))) out[name] = randomBytes(SECRET_BYTES[name]).toString('hex');
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub App Manifest flow

/**
 * @param {string | undefined} webUrl GitHub (or GitHub Enterprise Server) web URL
 * @param {string | undefined} apiUrl explicit API base URL
 */
export function githubUrls(webUrl, apiUrl) {
  const web = (webUrl || 'https://github.com').replace(/\/+$/, '');
  const api = (
    apiUrl || (new URL(web).hostname === 'github.com' ? 'https://api.github.com' : `${web}/api/v3`)
  ).replace(/\/+$/, '');
  return { web, api };
}

/**
 * The GitHub App manifest: push events to the webhook, read access to
 * contents, and write access to commit statuses (and pull requests, for the
 * editor's review flow).
 * @param {{ name: string, publicUrl: string, redirectUrl: string, webhookActive?: boolean }} options
 */
export function buildManifest({ name, publicUrl, redirectUrl, webhookActive = true }) {
  const base = publicUrl.replace(/\/+$/, '');
  return {
    name,
    url: base,
    description: `OpenD docs at ${base}`,
    hook_attributes: { url: `${base}/webhooks/github`, active: webhookActive },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: {
      contents: 'read',
      metadata: 'read',
      statuses: 'write',
      pull_requests: 'write',
    },
    default_events: ['push'],
  };
}

/**
 * Where the manifest is posted: an organization's app settings, or the
 * signed-in user's when no org is given.
 * @param {string} web
 * @param {string | undefined} org
 * @param {string} state
 */
export function newAppUrl(web, org, state) {
  const path = org
    ? `/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : '/settings/apps/new';
  return `${web}${path}?state=${encodeURIComponent(state)}`;
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      /** @type {Record<string, string>} */ ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] ?? c,
  );
}

/**
 * @typedef {object} ManifestFlow
 * @property {string} startUrl local page that posts the manifest to GitHub
 * @property {string} redirectUrl where GitHub sends the browser back
 * @property {string} state CSRF token GitHub must echo back
 * @property {Promise<string>} code resolves with the code from GitHub's redirect
 * @property {() => Promise<void>} close
 */

/**
 * Starts a local HTTP server for the manifest flow. GET / serves a page that
 * POSTs the manifest to GitHub; GitHub redirects back to /callback with a
 * `code` and the `state`, which must match, so another site cannot feed this
 * flow a code of its choosing.
 * @param {{ web: string, org?: string, manifest: (redirectUrl: string) => object,
 *   port?: number, host?: string, timeoutMs?: number }} options
 * @returns {Promise<ManifestFlow>}
 */
export async function startManifestFlow(options) {
  const state = randomBytes(16).toString('hex');
  /** @type {(code: string) => void} */
  let resolveCode = () => {};
  /** @type {(err: Error) => void} */
  let rejectCode = () => {};
  /** @type {Promise<string>} */
  const code = new Promise((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  code.catch(() => {}); // the caller awaits it; avoid an unhandled rejection on close
  let redirectUrl = '';

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const page = (status, body) =>
      res
        .writeHead(status, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        .end(`<!doctype html><meta charset="utf-8"><title>OpenD setup</title>${body}`);
    if (req.method === 'GET' && url.pathname === '/') {
      const manifest = JSON.stringify(options.manifest(redirectUrl));
      return page(
        200,
        `<p>Sending you to GitHub to create the OpenD GitHub App…</p>
<form id="f" method="post" action="${escapeHtml(newAppUrl(options.web, options.org, state))}">
<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">
<button type="submit">Continue to GitHub</button></form>
<script>document.getElementById('f').submit()</script>`,
      );
    }
    if (req.method === 'GET' && url.pathname === '/callback') {
      const given = Buffer.from(url.searchParams.get('state') ?? '');
      const want = Buffer.from(state);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        return page(
          400,
          '<p>This link is not from the setup run in progress. Start again from the setup terminal.</p>',
        );
      }
      const c = url.searchParams.get('code') ?? '';
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(c)) return page(400, '<p>GitHub sent no code.</p>');
      page(200, '<p>GitHub App created. You can close this tab and return to the terminal.</p>');
      return resolveCode(c);
    }
    page(404, '<p>Not found</p>');
  });

  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => res(undefined));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://localhost:${address.port}`;
  redirectUrl = `${origin}/callback`;
  const timer = setTimeout(
    () => rejectCode(new Error('timed out waiting for GitHub to redirect back')),
    options.timeoutMs ?? 15 * 60_000,
  );
  return {
    startUrl: `${origin}/`,
    redirectUrl,
    state,
    code,
    close: async () => {
      clearTimeout(timer);
      rejectCode(new Error('manifest flow closed'));
      server.closeAllConnections();
      await new Promise((res) => server.close(() => res(undefined)));
    },
  };
}

/**
 * @typedef {object} CreatedApp
 * @property {number} id
 * @property {string} slug
 * @property {string} html_url
 * @property {string} pem
 * @property {string} webhook_secret
 * @property {{ login: string }} [owner]
 */

/**
 * @param {Response} res
 * @param {string} what
 */
async function githubError(res, what) {
  let detail = '';
  try {
    const body = /** @type {{ message?: string }} */ (await res.json());
    if (body.message) detail = `: ${body.message}`;
  } catch {
    // not JSON
  }
  return new Error(`GitHub ${what} failed with ${res.status}${detail}`);
}

/**
 * Exchanges the manifest code for the new app's id, private key and webhook
 * secret. The code is single-use and expires after an hour.
 * @param {string} api
 * @param {string} code
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<CreatedApp>}
 */
export async function exchangeManifestCode(api, code, fetchImpl = fetch) {
  const res = await fetchImpl(`${api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!res.ok) throw await githubError(res, 'app manifest conversion');
  const app = /** @type {CreatedApp} */ (await res.json());
  if (!app.id || !app.pem) throw new Error('GitHub returned no app id or private key');
  return app;
}

/**
 * A short-lived JWT that authenticates as the app (RS256).
 * @param {string | number} appId
 * @param {string} pem
 * @param {number} [nowSeconds]
 */
export function appJwt(appId, pem, nowSeconds = Math.floor(Date.now() / 1000)) {
  const enc = (/** @type {object} */ o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(pem, 'base64url')}`;
}

/**
 * @param {string} api
 * @param {{ id: number | string, pem: string }} app
 * @param {string} path
 * @param {RequestInit} init
 * @param {typeof fetch} fetchImpl
 */
async function appRequest(api, app, path, init, fetchImpl) {
  return fetchImpl(`${api}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${appJwt(app.id, app.pem)}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
  });
}

/**
 * Points the app's webhook at our secret, when deploy/.env already had one.
 * @param {string} api
 * @param {{ id: number | string, pem: string }} app
 * @param {{ url: string, secret: string }} hook
 * @param {typeof fetch} [fetchImpl]
 */
export async function setAppWebhook(api, app, hook, fetchImpl = fetch) {
  const res = await appRequest(
    api,
    app,
    '/app/hook/config',
    {
      method: 'PATCH',
      body: JSON.stringify({ url: hook.url, secret: hook.secret, content_type: 'json' }),
    },
    fetchImpl,
  );
  if (!res.ok) throw await githubError(res, 'webhook update');
}

/**
 * The app's installations, to fill in the repo's installation id.
 * @param {string} api
 * @param {{ id: number | string, pem: string }} app
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ id: number, account: { login: string } }[]>}
 */
export async function listInstallations(api, app, fetchImpl = fetch) {
  const res = await appRequest(api, app, '/app/installations', { method: 'GET' }, fetchImpl);
  if (!res.ok) throw await githubError(res, 'installation list');
  return /** @type {any} */ (await res.json());
}

// ---------------------------------------------------------------------------
// Seed file

/**
 * @param {string} s
 */
const q = (s) => JSON.stringify(s); // a JSON string is a valid YAML scalar

/**
 * The first org, reader and docs repo, in the format `opend-server seed` reads.
 * @param {{ org?: { slug: string, name: string, products: string[], version: string, readers: string[] },
 *   repo?: { fullName: string, sourceUrl: string, installationId?: number, releaseRefs: string[], docsPath: string } }} seed
 */
export function buildSeedYaml({ org, repo }) {
  const out = [
    '# Written by deploy/setup.mjs. Safe to edit and re-run:',
    '#   docker compose -f deploy/docker-compose.yml run --rm migrate seed /seed/seed.yaml',
    '',
  ];
  if (repo) {
    out.push(
      'repos:',
      `  - fullName: ${q(repo.fullName)}`,
      `    sourceUrl: ${q(repo.sourceUrl)}`,
      ...(repo.installationId ? [`    installationId: ${repo.installationId}`] : []),
      `    releaseRefs: [${repo.releaseRefs.map(q).join(', ')}]`,
      `    docsPath: ${q(repo.docsPath)}`,
      '',
    );
  }
  if (org) {
    out.push(
      'orgs:',
      `  - slug: ${q(org.slug)}`,
      `    name: ${q(org.name)}`,
      '    entitlements:',
      `      products: [${org.products.map(q).join(', ')}]`,
      '      features: []',
      `      version: ${q(org.version)}`,
      `    readers: [${org.readers.map(q).join(', ')}]`,
      '',
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Processes and prerequisites

/**
 * @typedef {(cmd: string, args: string[], options?: { inherit?: boolean, cwd?: string }) =>
 *   Promise<{ code: number, stdout: string, stderr: string }>} Run
 */

/** @type {Run} */
export const runCommand = (cmd, args, options = {}) =>
  new Promise((res) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (err) => res({ code: 127, stdout, stderr: stderr || err.message }));
    child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
  });

/**
 * @param {string} version e.g. 22.12.0
 */
export function nodeVersionOk(version) {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/**
 * Checks Node, Docker and Docker Compose. Docker problems are only fatal when
 * the stack is to be started.
 * @param {Run} run
 * @param {{ nodeVersion?: string }} [options]
 * @returns {Promise<{ problems: string[], docker: boolean }>}
 */
export async function checkPrerequisites(run, options = {}) {
  const problems = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (!nodeVersionOk(nodeVersion)) {
    problems.push(`Node ${MIN_NODE.join('.')} or newer is required (found ${nodeVersion})`);
  }
  let docker = true;
  if ((await run('docker', ['--version'])).code !== 0) {
    problems.push('Docker is not installed: https://docs.docker.com/get-docker/');
    docker = false;
  } else if ((await run('docker', ['compose', 'version'])).code !== 0) {
    problems.push('Docker Compose v2 is not installed (the `docker compose` plugin)');
    docker = false;
  } else if ((await run('docker', ['info', '--format', '{{.ServerVersion}}'])).code !== 0) {
    problems.push('Docker is installed but the daemon is not running (or you lack permission)');
    docker = false;
  }
  return { problems, docker };
}

// ---------------------------------------------------------------------------
// Questions

/**
 * @typedef {object} Io
 * @property {(question: string, fallback?: string) => Promise<string>} ask
 * @property {(message: string) => void} log
 * @property {(url: string) => Promise<void>} open shows a URL the person must visit
 * @property {() => void} [close]
 */

/**
 * @param {boolean} interactive
 * @param {Run} run
 * @returns {Io}
 */
export function terminalIo(interactive, run) {
  const rl = interactive ? createInterface({ input: process.stdin }) : null;
  // Lines are queued as they arrive, so answers piped in ahead of the
  // questions (`printf ... | node deploy/setup.mjs`) are not lost.
  /** @type {string[]} */
  const lines = [];
  /** @type {((line: string | null) => void) | null} */
  let waiting = null;
  let closed = false;
  rl?.on('line', (line) => (waiting ? (waiting(line), (waiting = null)) : lines.push(line)));
  rl?.on('close', () => {
    closed = true;
    waiting?.(null);
  });
  return {
    ask: async (question, fallback = '') => {
      if (!rl) return fallback;
      process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ''}: `);
      const line =
        lines.shift() ?? (closed ? null : await new Promise((resolve) => (waiting = resolve)));
      if (line === null) throw new Error('input ended before setup finished');
      return line.trim() || fallback;
    },
    log: (message) => process.stdout.write(`${message}\n`),
    open: async (url) => {
      process.stdout.write(`\n  Open this URL in your browser:\n\n    ${url}\n\n`);
      if (!interactive) return;
      const opener =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer'
            : 'xdg-open';
      await run(opener, [url]).catch(() => undefined);
    },
    close: () => rl?.close(),
  };
}

/** @param {string} answer */
const yes = (answer) => /^y(es)?$/i.test(answer.trim());

/** @param {string} url */
export function isPrivateUrl(url) {
  const host = new URL(url).hostname;
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    /^(127|10)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '[::1]'
  );
}

/** @param {string} list */
const csv = (list) =>
  list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// ---------------------------------------------------------------------------
// Main flow

export const USAGE = `Usage: node deploy/setup.mjs [options]

Sets up a self-hosted OpenD: deploy/.env, a GitHub App, a first org and
reader, then starts Docker Compose. Safe to re-run; existing values are kept.

General
  --non-interactive         Ask nothing; use flags, existing values and defaults
  --public-url <url>        Where readers reach the site (default http://localhost:3000)
  --no-start                Do not start Docker; print the commands instead
  --poll-interval <secs>    Poll repos instead of relying on webhooks (0 = off)
  --dev-login               Development sign-in without an identity provider (local only)

GitHub
  --github-app / --no-github-app   Create a GitHub App (asked when interactive)
  --github-org <org>        Create the app under this organization (default: your account)
  --app-name <name>         GitHub App name (editable on GitHub before creating)
  --github-url <url>        GitHub Enterprise Server URL (default https://github.com)
  --github-api-url <url>    API URL (default derived from --github-url)
  --callback-port <port>    Local port for GitHub's redirect (default: any free port)
  --installation-id <id>    GitHub App installation for the docs repo

Sign-in and embedding
  --oidc-issuer <url>  --oidc-client-id <id>  --oidc-client-secret <secret>
  --embed-origins <list>    Origins allowed to embed help (comma-separated)
  --entitlement-webhook     Generate ENTITLEMENT_WEBHOOK_SECRET for CRM webhooks

First org, reader and docs repo (deploy/seed/seed.yaml)
  --org-slug <slug>  --org-name <name>  --reader-email <email>
  --products <list>  --entitled-version <version>
  --repo <owner/name>  --repo-url <url>  --release-refs <list>  --docs-path <path>
`;

const OPTIONS = /** @type {const} */ ({
  help: { type: 'boolean', short: 'h' },
  'non-interactive': { type: 'boolean' },
  'public-url': { type: 'string' },
  start: { type: 'boolean', default: true },
  'poll-interval': { type: 'string' },
  'dev-login': { type: 'boolean' },
  'github-app': { type: 'boolean' },
  'github-org': { type: 'string' },
  'app-name': { type: 'string' },
  'github-url': { type: 'string' },
  'github-api-url': { type: 'string' },
  'callback-port': { type: 'string' },
  'installation-id': { type: 'string' },
  'oidc-issuer': { type: 'string' },
  'oidc-client-id': { type: 'string' },
  'oidc-client-secret': { type: 'string' },
  'embed-origins': { type: 'string' },
  'entitlement-webhook': { type: 'boolean' },
  'org-slug': { type: 'string' },
  'org-name': { type: 'string' },
  'reader-email': { type: 'string' },
  products: { type: 'string' },
  'entitled-version': { type: 'string' },
  repo: { type: 'string' },
  'repo-url': { type: 'string' },
  'release-refs': { type: 'string' },
  'docs-path': { type: 'string' },
});

/** @param {string[]} argv */
export function parseSetupArgs(argv) {
  return parseArgs({ args: argv, options: OPTIONS, allowNegative: true, strict: true }).values;
}

/**
 * @typedef {object} SetupDeps
 * @property {string} [deployDir] folder holding docker-compose.yml and .env
 * @property {Io} [io]
 * @property {Run} [run]
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [nodeVersion]
 * @property {number} [healthTimeoutMs]
 * @property {number} [callbackTimeoutMs]
 */

/**
 * Runs the whole setup. Returns the values written, for tests and scripting.
 * @param {string[]} argv
 * @param {SetupDeps} [deps]
 */
export async function runSetup(argv, deps = {}) {
  const flags = parseSetupArgs(argv);
  const run = deps.run ?? runCommand;
  const interactive = !flags['non-interactive'];
  const io = deps.io ?? terminalIo(interactive, run);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const deployDir = deps.deployDir ?? dirname(fileURLToPath(import.meta.url));
  const envPath = join(deployDir, '.env');
  const seedPath = join(deployDir, 'seed', 'seed.yaml');
  const composeFile = join(deployDir, 'docker-compose.yml');
  const start = flags.start !== false;
  /** @param {string} q @param {string} [fallback] */
  const ask = (q, fallback) => io.ask(q, fallback);

  try {
    if (flags.help) {
      io.log(USAGE);
      return null;
    }

    // 1. Prerequisites
    io.log('Checking prerequisites…');
    const pre = await checkPrerequisites(
      run,
      deps.nodeVersion ? { nodeVersion: deps.nodeVersion } : {},
    );
    for (const p of pre.problems) io.log(`  ✗ ${p}`);
    if (!nodeVersionOk(deps.nodeVersion ?? process.versions.node))
      throw new Error('unsupported Node version');
    if (start && !pre.docker)
      throw new Error('Docker is needed to start OpenD (or pass --no-start)');
    if (pre.problems.length === 0) io.log('  ✓ Node, Docker and Docker Compose');

    // 2. Existing settings
    if (!existsSync(envPath)) {
      const example = join(deployDir, '.env.example');
      if (existsSync(example)) await copyFile(example, envPath);
      else await writeFile(envPath, '');
      io.log(`Created ${envPath}`);
    }
    let envText = await readFile(envPath, 'utf8');
    let env = parseEnv(envText);
    const write = async (/** @type {Record<string, string | undefined>} */ updates) => {
      const merged = mergeEnv(envText, updates);
      envText = merged.text;
      env = parseEnv(envText);
      await writeFile(envPath, envText, { mode: 0o600 });
      await chmod(envPath, 0o600).catch(() => undefined);
      return merged;
    };
    const has = (/** @type {string} */ key) => !isUnset(env.get(key));
    const pollSeconds = () => Number(env.get('POLL_INTERVAL_SECONDS') || 0);

    // 3. Questions
    // An existing PUBLIC_URL wins, like every other value already in deploy/.env.
    const existingUrl = has('PUBLIC_URL') ? env.get('PUBLIC_URL') : undefined;
    if (existingUrl && flags['public-url'] && flags['public-url'] !== existingUrl) {
      io.log(`  ! Keeping PUBLIC_URL=${existingUrl} from deploy/.env; edit it there to change it.`);
    }
    const publicUrl = (
      existingUrl ??
      flags['public-url'] ??
      (await ask('Public URL readers will use', 'http://localhost:3000'))
    ).replace(/\/+$/, '');
    if (!URL.canParse(publicUrl) || !/^https?:/.test(publicUrl))
      throw new Error(`not an http(s) URL: ${publicUrl}`);
    const privateUrl = isPrivateUrl(publicUrl);

    /** @type {Record<string, string | undefined>} */
    const settings = { PUBLIC_URL: publicUrl };
    if (!has('POLL_INTERVAL_SECONDS')) {
      let poll = flags['poll-interval'];
      if (poll === undefined && privateUrl) {
        poll = interactive
          ? yes(
              await ask(
                `GitHub cannot reach ${publicUrl}. Poll repos for changes every 60 seconds instead? (y/n)`,
                'y',
              ),
            )
            ? '60'
            : '0'
          : '60';
      }
      if (poll !== undefined && poll !== '0') settings.POLL_INTERVAL_SECONDS = poll;
    }

    if (!has('OIDC_ISSUER')) {
      const issuer =
        flags['oidc-issuer'] ??
        (await ask('OIDC issuer URL for reader sign-in (blank to set up later)', ''));
      if (issuer) {
        settings.OIDC_ISSUER = issuer;
        settings.OIDC_CLIENT_ID = flags['oidc-client-id'] ?? (await ask('OIDC client id', ''));
        settings.OIDC_CLIENT_SECRET =
          flags['oidc-client-secret'] ?? (await ask('OIDC client secret', ''));
        if (!settings.OIDC_CLIENT_ID || !settings.OIDC_CLIENT_SECRET) {
          throw new Error('an OIDC issuer needs a client id and secret');
        }
      } else if (!has('OPEND_DEV_LOGIN')) {
        const dev =
          flags['dev-login'] ??
          (privateUrl &&
            yes(
              await ask(
                'No identity provider yet. Enable development sign-in for local evaluation? (y/n)',
                'n',
              ),
            ));
        if (dev) {
          if (!privateUrl)
            throw new Error('--dev-login is only for local evaluation, not a public URL');
          Object.assign(settings, { NODE_ENV: 'development', OPEND_DEV_LOGIN: '1' });
        }
      }
    }

    /** @type {(keyof typeof SECRET_BYTES)[]} */
    const secrets = ['SESSION_SECRET', 'OPEND_ADMIN_TOKEN'];
    if (!has('OPEND_EMBED_ORIGINS')) {
      const origins =
        flags['embed-origins'] ??
        (await ask('Origins allowed to embed help, comma-separated (blank to skip)', ''));
      if (origins) {
        settings.OPEND_EMBED_ORIGINS = csv(origins).join(',');
        secrets.push('OPEND_EMBED_SECRET');
      }
    }
    if (flags['entitlement-webhook']) secrets.push('ENTITLEMENT_WEBHOOK_SECRET');

    // A Postgres volume from an earlier run keeps its first password.
    if (!has('POSTGRES_PASSWORD')) {
      const volume = await run('docker', ['volume', 'inspect', 'opend_pgdata']);
      if (pre.docker && volume.code === 0) {
        io.log(
          '  ! An existing opend_pgdata volume was found: keeping the default database password.',
        );
        settings.POSTGRES_PASSWORD = 'opend';
      } else secrets.push('POSTGRES_PASSWORD');
    }

    const wantApp = !has('GITHUB_APP_ID')
      ? (flags['github-app'] ??
        (interactive && yes(await ask('Create a GitHub App for push-to-publish now? (y/n)', 'y'))))
      : false;
    const gh = githubUrls(
      flags['github-url'] ?? env.get('GITHUB_WEB_URL'),
      flags['github-api-url'] ?? env.get('GITHUB_API_URL'),
    );
    if (gh.web !== 'https://github.com') {
      settings.GITHUB_API_URL = gh.api;
      settings.GITHUB_WEB_URL = gh.web;
    }
    // Without an app, the webhook secret is ours to choose; with one, GitHub's is used.
    if (!wantApp) secrets.push('GITHUB_WEBHOOK_SECRET');

    const first = await write({ ...settings, ...generateSecrets(env, secrets) });
    io.log(
      `Wrote ${envPath}: ${first.written.join(', ') || 'nothing new'}${first.kept.length ? ` (kept ${first.kept.join(', ')})` : ''}`,
    );

    // 4. GitHub App
    /** @type {{ id: number, pem: string, html_url: string, slug: string } | null} */
    let app = null;
    if (wantApp) {
      const org =
        flags['github-org'] ??
        (await ask('GitHub organization to own the app (blank for your account)', ''));
      const name =
        flags['app-name'] ??
        (await ask('GitHub App name', `OpenD ${new URL(publicUrl).host}`.slice(0, 34)));
      const port = flags['callback-port'] ? Number(flags['callback-port']) : 0;
      const flow = await startManifestFlow({
        web: gh.web,
        ...(org ? { org } : {}),
        port,
        // With polling on, GitHub cannot reach the server, so its webhook starts inactive.
        manifest: (redirectUrl) =>
          buildManifest({ name, publicUrl, redirectUrl, webhookActive: pollSeconds() === 0 }),
        ...(deps.callbackTimeoutMs ? { timeoutMs: deps.callbackTimeoutMs } : {}),
      });
      try {
        io.log(
          'Create the GitHub App: the page posts the app manifest to GitHub, then GitHub sends you back here.',
        );
        await io.open(flow.startUrl);
        const created = await exchangeManifestCode(gh.api, await flow.code, fetchImpl);
        app = created;
        /** @type {Record<string, string>} */
        const appValues = {
          GITHUB_APP_ID: String(created.id),
          GITHUB_APP_PRIVATE_KEY: created.pem,
        };
        if (has('GITHUB_WEBHOOK_SECRET')) {
          // Keep the secret already in deploy/.env and tell GitHub to use it.
          try {
            await setAppWebhook(
              gh.api,
              created,
              {
                url: `${publicUrl}/webhooks/github`,
                secret: /** @type {string} */ (env.get('GITHUB_WEBHOOK_SECRET')),
              },
              fetchImpl,
            );
          } catch (err) {
            io.log(
              `  ! Could not set the app's webhook secret (${err instanceof Error ? err.message : err}). Set it to GITHUB_WEBHOOK_SECRET from deploy/.env in the app's settings.`,
            );
          }
        } else appValues.GITHUB_WEBHOOK_SECRET = created.webhook_secret;
        await write(appValues);
        io.log(
          `  ✓ Created GitHub App ${created.slug} (id ${created.id}); credentials saved to deploy/.env`,
        );
      } finally {
        await flow.close();
      }
    }
    const appId = env.get('GITHUB_APP_ID');
    const appKey = env.get('GITHUB_APP_PRIVATE_KEY');
    const installUrl = app ? `${app.html_url}/installations/new` : undefined;

    // 5. First org, reader and repo
    let seeded = existsSync(seedPath);
    if (seeded) io.log(`Keeping ${seedPath}`);
    else {
      const wantSeed = interactive
        ? yes(await ask('Create a first org, reader and docs repo now? (y/n)', 'y'))
        : Boolean(flags['org-slug'] || flags.repo);
      if (wantSeed) {
        const repoName =
          flags.repo ?? (await ask('Docs repository (owner/name, blank to add later)', ''));
        let installationId = flags['installation-id']
          ? Number(flags['installation-id'])
          : undefined;
        if (repoName && !installationId && installUrl && appId && appKey) {
          await ask(
            `Install the app on ${repoName.split('/')[0]}: ${installUrl}\nPress Enter once it is installed`,
            '',
          );
          try {
            const owner = repoName.split('/')[0]?.toLowerCase();
            const found = (
              await listInstallations(gh.api, { id: appId, pem: appKey }, fetchImpl)
            ).find((i) => i.account.login.toLowerCase() === owner);
            if (found) installationId = found.id;
          } catch (err) {
            io.log(`  ! Could not list installations: ${err instanceof Error ? err.message : err}`);
          }
        }
        const slug =
          flags['org-slug'] ?? (await ask('First customer org slug (lowercase, dashes)', 'acme'));
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug))
          throw new Error(`org slug must be lowercase letters, digits and dashes: ${slug}`);
        const reader =
          flags['reader-email'] ??
          (await ask('First reader email (signs in through your identity provider)', ''));
        await mkdir(dirname(seedPath), { recursive: true });
        await writeFile(
          seedPath,
          buildSeedYaml({
            org: {
              slug,
              name: flags['org-name'] ?? (await ask('Org name', slug)),
              products: csv(
                flags.products ??
                  (await ask('Products the org is entitled to, comma-separated', 'widget')),
              ),
              version:
                flags['entitled-version'] ??
                (await ask('Product version the org runs (picks the docs line, e.g. 2.1)', '1.0')),
              readers: reader ? [reader] : [],
            },
            ...(repoName
              ? {
                  repo: {
                    fullName: repoName,
                    sourceUrl: flags['repo-url'] ?? `${gh.web}/${repoName}.git`,
                    ...(installationId ? { installationId } : {}),
                    releaseRefs: csv(
                      flags['release-refs'] ??
                        (await ask('Branches and tags that publish', 'main,v*')),
                    ),
                    docsPath:
                      flags['docs-path'] ?? (await ask('Docs folder inside the repository', '.')),
                  },
                }
              : {}),
          }),
        );
        io.log(`Wrote ${seedPath}`);
        seeded = true;
      }
    }

    // 6. Start, migrate (on start) and seed
    const compose = ['compose', '-f', composeFile];
    const commands = [
      ['docker', ...compose, 'up', '-d', '--build'],
      ...(seeded
        ? [['docker', ...compose, 'run', '--rm', 'migrate', 'seed', '/seed/seed.yaml']]
        : []),
    ];
    const port = env.get('OPEND_PORT') || '3000';
    if (start) {
      io.log('Starting OpenD (the first build of the image takes a few minutes)…');
      const up = await run('docker', [...compose, 'up', '-d', '--build'], { inherit: true });
      if (up.code !== 0)
        throw new Error(`docker compose up failed; see: docker ${compose.join(' ')} logs`);
      await waitForHealth(
        `http://localhost:${port}/healthz`,
        fetchImpl,
        deps.healthTimeoutMs ?? 180_000,
      );
      io.log('  ✓ OpenD is up; migrations applied');
      if (seeded) {
        const seed = await run(
          'docker',
          [...compose, 'run', '--rm', 'migrate', 'seed', '/seed/seed.yaml'],
          { inherit: true },
        );
        if (seed.code !== 0) throw new Error('loading the seed failed');
        io.log('  ✓ Seed loaded');
      }
    } else {
      io.log('\nStart OpenD with:\n');
      for (const c of commands) io.log(`  ${c.join(' ')}`);
    }

    // 7. Next steps
    io.log(`\nDone. OpenD: ${publicUrl}`);
    if (installUrl) io.log(`- Install the GitHub App on your docs repositories: ${installUrl}`);
    if (pollSeconds() > 0)
      io.log(`- Polling mode: the worker checks release refs every ${pollSeconds()}s`);
    else io.log(`- GitHub must reach ${publicUrl}/webhooks/github`);
    if (env.get('OIDC_ISSUER'))
      io.log(
        `- Register ${publicUrl}/auth/callback as the redirect URI with your identity provider`,
      );
    else if (env.get('OPEND_DEV_LOGIN')) io.log(`- Development sign-in: ${publicUrl}/auth/dev`);
    else
      io.log(
        '- Connect sign-in: set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET in deploy/.env',
      );
    io.log('- Admin API token: OPEND_ADMIN_TOKEN in deploy/.env (not printed here)');
    io.log('- Guide: docs/self-hosting.md');
    return { env: Object.fromEntries(env), seeded, commands, installUrl };
  } finally {
    io.close?.();
  }
}

/**
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 */
export async function waitForHealth(url, fetchImpl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetchImpl(url, { signal: AbortSignal.timeout(5000) })).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline)
      throw new Error(`OpenD did not become healthy at ${url}; see docker compose logs`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSetup(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`\nsetup: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
