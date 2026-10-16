import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { escapeHtml } from '@opend/render-html';
import { findReaderForLogin, getReaderAccess, listReaders, type ReaderAccess } from '@opend/store';
import type { AppContext } from './context.js';
import { newChecks, type OidcChecks } from './oidc.js';
import { messagePage, simplePage } from './pages.js';

export const SESSION_COOKIE = 'opend_session';
export const EMBED_COOKIE = 'opend_embed';
const EMBED_SESSION_MINUTES = 60;
const OIDC_COOKIE = 'opend_oidc';
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

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  const callbackUrl = `${ctx.config.publicUrl}/auth/callback`;

  app.get('/auth/login', async (request, reply) => {
    const returnTo = safeReturnTo((request.query as { returnTo?: unknown }).returnTo);
    if (ctx.oidc) {
      const checks = newChecks();
      reply.setCookie(OIDC_COOKIE, JSON.stringify({ ...checks, returnTo }), {
        signed: true,
        httpOnly: true,
        // Lax lets the cookie come back on the IdP's top-level redirect to the callback.
        sameSite: 'lax',
        secure: secureCookies(ctx),
        path: '/auth',
        maxAge: 600,
      });
      return reply.redirect((await ctx.oidc.authorizationUrl(callbackUrl, checks)).href);
    }
    if (ctx.config.devLogin) return reply.redirect('/auth/dev');
    return reply
      .code(503)
      .type('text/html')
      .send(messagePage('Sign-in unavailable', 'No sign-in method is configured.'));
  });

  app.get('/auth/callback', async (request, reply) => {
    const raw = request.cookies[OIDC_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    reply.clearCookie(OIDC_COOKIE, { path: '/auth' });
    if (!ctx.oidc || !unsigned?.valid || !unsigned.value) {
      return reply
        .code(400)
        .type('text/html')
        .send(messagePage('Sign-in expired', 'Please sign in again.'));
    }
    const pending = JSON.parse(unsigned.value) as OidcChecks & { returnTo: string };
    let identity;
    try {
      identity = await ctx.oidc.exchange(new URL(request.url, ctx.config.publicUrl), pending);
    } catch (err) {
      ctx.log({ level: 'warn', msg: 'oidc callback rejected', error: String(err) });
      return reply
        .code(400)
        .type('text/html')
        .send(messagePage('Sign-in failed', 'Please try signing in again.'));
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
      return reply
        .code(403)
        .type('text/html')
        .send(
          messagePage(
            'No access',
            `${identity.email ?? 'This account'} is not registered for this documentation. Ask your administrator for access.`,
          ),
        );
    }
    ctx.caches.readers.delete(reader.id);
    setSession(reply, ctx, reader.id);
    return reply.redirect(safeReturnTo(pending.returnTo));
  });

  const logout = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply
      .type('text/html')
      .send(
        simplePage(
          'Signed out',
          '<h1>Signed out</h1><p><a href="/auth/login">Sign in again</a></p>',
        ),
      );
  };
  app.post('/auth/logout', logout);
  app.get('/auth/logout', logout);

  if (ctx.config.devLogin) {
    // Development only: sign in as any registered reader without an IdP.
    app.get('/auth/dev', async (_request, reply) => {
      const readers = await listReaders(ctx.pool);
      const items = readers
        .map(
          (r) =>
            `<li><form method="post" action="/auth/dev" style="margin:0"><input type="hidden" name="readerId" value="${r.id}"><button type="submit">${escapeHtml(r.email)}</button> <small>${escapeHtml(r.orgSlug)}</small></form></li>`,
        )
        .join('');
      return reply
        .type('text/html')
        .send(
          simplePage(
            'Development sign-in',
            `<h1>Development sign-in</h1><p>OPEND_DEV_LOGIN is on. Choose a reader:</p><ul>${items || '<li>No readers yet. Run <code>opend-server seed</code>.</li>'}</ul>`,
          ),
        );
    });
    app.post('/auth/dev', async (request, reply) => {
      const readerId = Number((request.body as { readerId?: string } | undefined)?.readerId);
      const access = Number.isInteger(readerId) ? await getReaderAccess(ctx.pool, readerId) : null;
      if (!access)
        return reply
          .code(400)
          .type('text/html')
          .send(messagePage('Unknown reader', 'Choose a reader from the list.'));
      setSession(reply, ctx, readerId);
      return reply.redirect('/');
    });
  }
}
