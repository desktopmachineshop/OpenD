import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { createTestDatabase, upsertRepo, type TestDatabase } from '@opend/store';
import {
  FakeGitHub,
  createEditorApp,
  type EditorApp,
  type EditorConfig,
  type OidcIdentity,
  type OidcProvider,
} from '../src/index.js';

export const STARTER = join(import.meta.dirname, '../../../templates/docs-starter');
export const REPO = 'acme/docs';
export const EDITOR_URL = 'http://editor.test';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export function readStarter(): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const entry of readdirSync(STARTER, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    files[relative(STARTER, abs).split(sep).join('/')] = readFileSync(abs);
  }
  return files;
}

/** A fake company IdP: `?code=` names the identity to sign in as. */
export function fakeOidc(identities: Record<string, OidcIdentity>): OidcProvider {
  return {
    authorizationUrl: async (redirectUri, checks) =>
      new URL(
        `https://idp.test/authorize?state=${checks.state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      ),
    exchange: async (callbackUrl, checks) => {
      if (callbackUrl.searchParams.get('state') !== checks.state) throw new Error('state mismatch');
      const identity = identities[callbackUrl.searchParams.get('code') ?? ''];
      if (!identity) throw new Error('bad code');
      return identity;
    },
  };
}

export interface Harness extends EditorApp {
  db: TestDatabase;
  gh: FakeGitHub;
  close(): Promise<void>;
}

export async function startEditor(
  url: string,
  options: { oidc?: Record<string, OidcIdentity>; config?: Partial<EditorConfig> } = {},
): Promise<Harness> {
  const db = await createTestDatabase(url);
  const gh = new FakeGitHub();
  gh.createRepo(REPO, readStarter());
  await upsertRepo(db.pool, {
    fullName: REPO,
    sourceUrl: `https://github.com/${REPO}.git`,
    installationId: 42,
  });
  const config: EditorConfig = {
    databaseUrl: db.url,
    publicUrl: EDITOR_URL,
    port: 0,
    host: '127.0.0.1',
    sessionSecret: 'editor-session-secret-0123456789abcdef',
    github: { appId: '1', privateKey, apiUrl: gh.apiUrl },
    secretKey: null,
    githubWebUrl: gh.webUrl,
    githubApiUrl: gh.apiUrl,
    githubOAuth: { clientId: 'cid', clientSecret: 'csecret', webUrl: gh.webUrl, apiUrl: gh.apiUrl },
    baseBranch: 'main',
    production: false,
    ...options.config,
  };
  const editor = await createEditorApp(config, {
    pool: db.pool,
    log: () => {},
    fetch: gh.fetch,
    oidc: fakeOidc(options.oidc ?? {}),
  });
  await editor.app.ready();
  return {
    ...editor,
    db,
    gh,
    close: async () => {
      await editor.app.close();
      await db.drop();
    },
  };
}

/** The `name=value` pairs of a response's Set-Cookie headers, for a Cookie header. */
export function cookiesFrom(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return list
    .map((c) => c.split(';')[0]!)
    .filter((c) => !c.endsWith('='))
    .join('; ');
}

export interface Session {
  cookie: string;
  csrf: string;
}

async function finishSignIn(h: Harness, cookie: string): Promise<Session> {
  const page = await h.app.inject({ method: 'GET', url: '/activity', headers: { cookie } });
  const csrf = /<meta name="opend-csrf" content="([^"]+)">/.exec(page.body)?.[1];
  if (!csrf) throw new Error(`not signed in: ${page.statusCode} ${page.body.slice(0, 200)}`);
  return { cookie, csrf };
}

/** Signs in through the GitHub OAuth flow against the fake. */
export async function signInGitHub(
  h: Harness,
  user: { id: number; login: string; name: string | null; email: string | null },
): Promise<LightMyRequestResponse & { session?: Session }> {
  const start = await h.app.inject({ method: 'GET', url: '/auth/github?returnTo=/' });
  const location = new URL(String(start.headers.location));
  const state = location.searchParams.get('state')!;
  const code = `code-${user.login}-${Math.random()}`;
  h.gh.addOAuthCode(code, user);
  const res = await h.app.inject({
    method: 'GET',
    url: `/auth/github/callback?code=${encodeURIComponent(code)}&state=${state}`,
    headers: { cookie: cookiesFrom(start) },
  });
  if (res.statusCode !== 302) return res;
  return Object.assign(res, { session: await finishSignIn(h, cookiesFrom(res)) });
}

export async function signInOidc(
  h: Harness,
  code: string,
): Promise<LightMyRequestResponse & { session?: Session }> {
  const start = await h.app.inject({ method: 'GET', url: '/auth/oidc' });
  const state = new URL(String(start.headers.location)).searchParams.get('state')!;
  const res = await h.app.inject({
    method: 'GET',
    url: `/auth/oidc/callback?code=${code}&state=${state}`,
    headers: { cookie: cookiesFrom(start) },
  });
  if (res.statusCode !== 302) return res;
  return Object.assign(res, { session: await finishSignIn(h, cookiesFrom(res)) });
}

/** A JSON request from the editor's own script. */
export function api(
  h: Harness,
  session: Session,
  method: 'GET' | 'POST',
  url: string,
  body?: object,
) {
  return h.app.inject({
    method,
    url,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      origin: EDITOR_URL,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
}

/** A plain HTML form post, as without JavaScript. */
export function form(h: Harness, session: Session, url: string, fields: Record<string, string>) {
  return h.app.inject({
    method: 'POST',
    url,
    headers: {
      cookie: session.cookie,
      origin: EDITOR_URL,
      accept: 'text/html',
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({ _csrf: session.csrf, ...fields }).toString(),
  });
}

export function page(h: Harness, session: Session, url: string) {
  return h.app.inject({
    method: 'GET',
    url,
    headers: { cookie: session.cookie, accept: 'text/html' },
  });
}

export const ADA = { id: 101, login: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };
export const BOB = { id: 102, login: 'bob', name: 'Bob Builder', email: 'bob@example.com' };
