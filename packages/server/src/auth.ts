import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { newPkce, type GitHubSignIn } from '@opend/editor';
import { escapeHtml } from '@opend/render-html';
import {
  audit,
  findReaderByEmail,
  findReaderForIdentity,
  findReaderForLogin,
  getReaderAccess,
  listReaders,
  upsertReader,
  withTransaction,
  type Reader,
  type ReaderAccess,
} from '@opend/store';
import type { AppContext } from './context.js';
import { publicSiteTitle, siteRepo } from './delivery.js';
import { newChecks, type OidcChecks } from './oidc.js';
import { messagePage, signInPage, simplePage } from './pages.js';

export const SESSION_COOKIE = 'opend_session';
export const EMBED_COOKIE = 'opend_embed';
const EMBED_SESSION_MINUTES = 60;
const OIDC_COOKIE = 'opend_oidc';
const GITHUB_COOKIE = 'opend_github';
const SESSION_HOURS = 12;

interface SessionValue {
  /** Reader id. */
  r: number;
  /** Expiry, epoch seconds. */
  e: number;
}

function secureCookies(ctx: AppContext): boolean {
  return ctx.config.publicUrl.startsWith('https://');
}

/** Only same-site relative paths, so `returnTo` cannot redirect off-site. */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\')
    ? value
    : '/';
}

export function setSession(reply: FastifyReply, ctx: AppContext, readerId: number): void {
  const value: SessionValue = {
    r: readerId,
    e: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600,
  };
  reply.setCookie(SESSION_COOKIE, JSON.stringify(value), {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(ctx),
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  });
}

function readSession(request: FastifyRequest, name: string): number | null {
  const raw = request.cookies[name];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;
  try {
    const value = JSON.parse(unsigned.value) as SessionValue;
    if (typeof value.r !== 'number' || typeof value.e !== 'number') return null;
    return value.e > Date.now() / 1000 ? value.r : null;
  } catch {
    return null;
  }
}

/**
 * The reader id from a valid, unexpired, correctly signed session: the docs
 * site session, or the embed session the help panel gets from a host token.
 */
export function sessionReaderId(request: FastifyRequest): number | null {
  return readSession(request, SESSION_COOKIE) ?? readSession(request, EMBED_COOKIE);
}

/** The raw value of the cookie `sessionReaderId` accepted, or `null`. */
function sessionCookieValue(request: FastifyRequest): string | null {
  for (const name of [SESSION_COOKIE, EMBED_COOKIE])
    if (readSession(request, name) !== null) return request.cookies[name]!;
  return null;
}

/**
 * CSRF token for reader forms, bound to the exact session cookie (so it
 * changes with every sign-in and expires with the session). `null` when the
 * request has no valid session.
 */
export function readerCsrfToken(request: FastifyRequest, ctx: AppContext): string | null {
  const cookie = sessionCookieValue(request);
  if (cookie === null) return null;
  return createHmac('sha256', ctx.config.sessionSecret)
    .update(`reader-csrf:${cookie}`)
    .digest('base64url');
}

/**
 * Reader POSTs must come from our own pages: the Origin (when sent) must be
 * ours, and the `_csrf` field must match the session. The embed session is a
 * SameSite=None cookie, so SameSite alone would not stop a cross-site form.
 */
export function checkReaderCsrf(request: FastifyRequest, ctx: AppContext): boolean {
  const origin = request.headers.origin;
  if (origin && origin !== new URL(ctx.config.publicUrl).origin) return false;
  const expected = readerCsrfToken(request, ctx);
  const body = request.body as Record<string, unknown> | undefined;
  const sent = typeof body?._csrf === 'string' ? body._csrf : '';
  if (expected === null) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Session for the help panel inside a host app's iframe. It is a third-party
 * cookie there, so it needs SameSite=None and Secure, and it is Partitioned
 * (CHIPS): it only exists under that host site, never as a general session.
 */
export function setEmbedSession(reply: FastifyReply, readerId: number): void {
  const value: SessionValue = {
    r: readerId,
    e: Math.floor(Date.now() / 1000) + EMBED_SESSION_MINUTES * 60,
  };
  reply.setCookie(EMBED_COOKIE, JSON.stringify(value), {
    signed: true,
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    partitioned: true,
    path: '/',
    maxAge: EMBED_SESSION_MINUTES * 60,
  });
}

/** The signed-in reader's access, cached briefly and cleared when entitlements change. */
export async function currentAccess(
  request: FastifyRequest,
  ctx: AppContext,
): Promise<ReaderAccess | null> {
  const readerId = sessionReaderId(request);
  if (readerId === null) return null;
  const cached = ctx.caches.readers.get(readerId);
  if (cached) return cached.access;
  const access = await getReaderAccess(ctx.pool, readerId);
  ctx.caches.readers.set(readerId, { access });
  return access;
}

function loginPath(returnTo: string): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function redirectToLogin(request: FastifyRequest, reply: FastifyReply) {
  return reply.redirect(loginPath(safeReturnTo(request.url)));
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** GitHub permissions that may auto-provision a reader (they can push to the docs anyway). */
const PUSH_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

/**
 * With `OPEND_GITHUB_COLLABORATOR_ORG`, a GitHub user who can push to the
 * site's repository, and whose primary email GitHub has verified and no
 * reader uses yet, becomes a reader of that org on first sign-in.
 */
async function provisionCollaborator(
  ctx: AppContext,
  login: GitHubSignIn,
  issuer: string,
): Promise<Reader | null> {
  const orgSlug = ctx.config.githubOAuth?.collaboratorOrg;
  if (!orgSlug || !ctx.repoPermission || !login.verifiedEmail) return null;
  const repo = await siteRepo(ctx);
  if (!repo) return null;
  let permission: string | null;
  try {
    permission = await ctx.repoPermission(repo, login.login);
  } catch (err) {
    ctx.log({ level: 'warn', msg: 'github permission check failed', error: String(err) });
    return null;
  }
  if (!permission || !PUSH_PERMISSIONS.has(permission)) return null;
  // Never move an existing reader to another org.
  if (await findReaderByEmail(ctx.pool, login.verifiedEmail)) return null;
  const staff = ctx.config.githubOAuth?.collaboratorStaff === true;
  const created = await withTransaction(ctx.pool, async (db) => {
    const reader = await upsertReader(db, {
      orgSlug,
      email: login.verifiedEmail!,
      name: login.name,
      staff,
    });
    if (reader)
      await audit(db, `github:${login.login}`, 'reader.provision', {
        org: orgSlug,
        email: reader.email,
        permission,
        staff,
      });
    return reader;
  });
  if (!created) {
    ctx.log({ level: 'warn', msg: 'collaborator org does not exist', org: orgSlug });
    return null;
  }
  ctx.caches.entitlementsChanged();
  return findReaderForIdentity(ctx.pool, {
    issuer,
    subject: String(login.id),
    verifiedEmails: [login.verifiedEmail],
  });
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  const callbackUrl = `${ctx.config.publicUrl}/auth/callback`;
  const githubCallbackUrl = `${ctx.config.publicUrl}/auth/github/callback`;
  const oidcName = ctx.config.oidc?.displayName ?? 'your company account';

  const html = (reply: FastifyReply, status: number, body: string) =>
    reply.code(status).type('text/html; charset=utf-8').send(body);
  const refuse = async (reply: FastifyReply, status: number, title: string, message: string) => {
    const repo = await siteRepo(ctx).catch(() => null);
    const link =
      repo?.access === 'public' ? { href: '/', text: 'Back to the documentation' } : undefined;
    return html(reply, status, messagePage(title, message, link));
  };
  const finish = (reply: FastifyReply, readerId: number, returnTo: unknown) => {
    ctx.caches.readers.delete(readerId);
    setSession(reply, ctx, readerId);
    return reply.redirect(safeReturnTo(returnTo));
  };
  const setFlowCookie = (reply: FastifyReply, name: string, value: object) =>
    reply.setCookie(name, JSON.stringify(value), {
      signed: true,
      httpOnly: true,
      // Lax lets the cookie come back on the provider's top-level redirect to the callback.
      sameSite: 'lax',
      secure: secureCookies(ctx),
      path: '/auth',
      maxAge: 600,
    });
  const readFlowCookie = <T>(request: FastifyRequest, reply: FastifyReply, name: string) => {
    const raw = request.cookies[name];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    reply.clearCookie(name, { path: '/auth' });
    if (!unsigned?.valid || !unsigned.value) return null;
    try {
      return JSON.parse(unsigned.value) as T;
    } catch {
      return null;
    }
  };

  // The sign-in page: every configured provider, and demo readers in development.
  app.get('/auth/login', async (request, reply) => {
    const returnTo = safeReturnTo((request.query as { returnTo?: unknown }).returnTo);
    const q = `?returnTo=${encodeURIComponent(returnTo)}`;
    const providers = [ctx.githubOAuth ? '/auth/github' : null, ctx.oidc ? '/auth/oidc' : null];
    const configured = providers.filter((p): p is string => p !== null);
    // A single provider needs no choice.
    if (configured.length === 1 && !ctx.config.devLogin) return reply.redirect(configured[0] + q);
    const repo = await siteRepo(ctx);
    const options: Parameters<typeof signInPage>[0] = {
      returnTo,
      github: Boolean(ctx.githubOAuth),
      backToDocs: repo?.access === 'public',
    };
    if (ctx.oidc) options.oidcName = oidcName;
    if (ctx.config.devLogin) options.demoReaders = await listReaders(ctx.pool);
    const title = await publicSiteTitle(ctx);
    if (title) options.siteTitle = title;
    const configuredAny = configured.length > 0 || ctx.config.devLogin;
    return reply
      .code(configuredAny ? 200 : 503)
      .headers({
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      })
      .type('text/html; charset=utf-8')
      .send(signInPage(options));
  });

  app.get('/auth/oidc', async (request, reply) => {
    if (!ctx.oidc) return refuse(reply, 404, 'Not available', 'Company sign-in is not configured.');
    const returnTo = safeReturnTo((request.query as { returnTo?: unknown }).returnTo);
    const checks = newChecks();
    setFlowCookie(reply, OIDC_COOKIE, { ...checks, returnTo });
    return reply.redirect((await ctx.oidc.authorizationUrl(callbackUrl, checks)).href);
  });

  app.get('/auth/callback', async (request, reply) => {
    const pending = readFlowCookie<OidcChecks & { returnTo: string }>(request, reply, OIDC_COOKIE);
    if (!ctx.oidc || !pending)
      return refuse(reply, 400, 'Sign-in expired', 'Please sign in again.');
    let identity;
    try {
      identity = await ctx.oidc.exchange(new URL(request.url, ctx.config.publicUrl), pending);
    } catch (err) {
      ctx.log({ level: 'warn', msg: 'oidc callback rejected', error: String(err) });
      return refuse(reply, 400, 'Sign-in failed', 'Please try signing in again.');
    }
    const login: Parameters<typeof findReaderForLogin>[1] = {
      issuer: identity.issuer,
      subject: identity.subject,
    };
    if (identity.email) login.email = identity.email;
    if (identity.emailVerified !== undefined) login.emailVerified = identity.emailVerified;
    const reader = await findReaderForLogin(ctx.pool, login);
    if (!reader) {
      ctx.log({
        level: 'info',
        msg: 'sign-in without access',
        issuer: identity.issuer,
        subject: identity.subject,
      });
      return refuse(
        reply,
        403,
        'No access',
        `${identity.email ?? 'This account'} is not registered for this documentation. Ask your administrator for access.`,
      );
    }
    return finish(reply, reader.id, pending.returnTo);
  });

  // GitHub sign-in: OAuth web flow with state and PKCE (S256), matched by verified email.
  app.get('/auth/github', async (request, reply) => {
    if (!ctx.githubOAuth)
      return refuse(reply, 404, 'Not available', 'GitHub sign-in is not configured.');
    const returnTo = safeReturnTo((request.query as { returnTo?: unknown }).returnTo);
    const state = randomBytes(24).toString('base64url');
    const pkce = newPkce();
    setFlowCookie(reply, GITHUB_COOKIE, { state, verifier: pkce.verifier, returnTo });
    return reply.redirect(
      ctx.githubOAuth.authorizationUrl(githubCallbackUrl, state, pkce.challenge),
    );
  });

  app.get('/auth/github/callback', async (request, reply) => {
    const pending = readFlowCookie<{ state: string; verifier: string; returnTo: string }>(
      request,
      reply,
      GITHUB_COOKIE,
    );
    const query = request.query as { code?: unknown; state?: unknown };
    if (
      !ctx.githubOAuth ||
      !ctx.config.githubOAuth ||
      !pending ||
      typeof pending.state !== 'string' ||
      typeof query.code !== 'string' ||
      typeof query.state !== 'string' ||
      !sameString(query.state, pending.state)
    )
      return refuse(reply, 400, 'Sign-in expired', 'Please sign in again.');
    let login: GitHubSignIn;
    try {
      login = await ctx.githubOAuth.exchange(query.code, githubCallbackUrl, pending.verifier);
    } catch (err) {
      ctx.log({ level: 'warn', msg: 'github sign-in rejected', error: String(err) });
      return refuse(reply, 400, 'Sign-in failed', 'Please try signing in again.');
    }
    const issuer = ctx.config.githubOAuth.webUrl;
    const identity = {
      issuer,
      subject: String(login.id),
      verifiedEmails: login.verifiedEmails,
    };
    const reader =
      (await findReaderForIdentity(ctx.pool, identity)) ??
      (await provisionCollaborator(ctx, login, issuer));
    if (!reader) {
      ctx.log({ level: 'info', msg: 'sign-in without access', github: login.login });
      return refuse(
        reply,
        403,
        'No access',
        `@${login.login} is not registered for this documentation: no verified email address on this GitHub account matches a reader. Ask your administrator for access.`,
      );
    }
    return finish(reply, reader.id, pending.returnTo);
  });

  const signedOut = (reply: FastifyReply) =>
    html(
      reply,
      200,
      simplePage(
        'Signed out',
        '<h1>Signed out</h1><p>You are signed out of the documentation.</p><p><a href="/">Back to the documentation</a> · <a href="/auth/login">Sign in again</a></p>',
      ),
    );

  // Signing out is a POST from our own pages: the session's CSRF token must match.
  app.post('/auth/logout', async (request, reply) => {
    if (sessionReaderId(request) !== null && !checkReaderCsrf(request, ctx))
      return refuse(reply, 403, 'Form expired', 'Reload the page and sign out again.');
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return signedOut(reply);
  });
  // A plain link only asks: a GET must not sign anyone out.
  app.get('/auth/logout', async (request, reply) => {
    const csrf = readerCsrfToken(request, ctx);
    if (csrf === null) return signedOut(reply);
    return html(
      reply,
      200,
      simplePage(
        'Sign out',
        `<h1>Sign out?</h1><p>You will need to sign in again to see your documentation.</p><form method="post" action="/auth/logout"><input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><button type="submit">Sign out</button></form>`,
      ),
    );
  });

  if (ctx.config.devLogin) {
    // Development only: sign in as any registered reader, from the sign-in page.
    app.get('/auth/dev', async (request, reply) => {
      const returnTo = safeReturnTo((request.query as { returnTo?: unknown }).returnTo);
      return reply.redirect(loginPath(returnTo));
    });
    app.post('/auth/dev', async (request, reply) => {
      const body = request.body as { readerId?: string; returnTo?: string } | undefined;
      const readerId = Number(body?.readerId);
      const access = Number.isInteger(readerId) ? await getReaderAccess(ctx.pool, readerId) : null;
      if (!access) return refuse(reply, 400, 'Unknown reader', 'Choose a reader from the list.');
      return finish(reply, readerId, body?.returnTo);
    });
  }
}
