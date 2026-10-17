import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createEditorSession,
  createEditorUserFromGitHub,
  findEditorUserForGitHub,
  findEditorUserForOidc,
  getEditorSession,
  recordEditorAudit,
  revokeEditorSession,
  type EditorUser,
} from '@opend/store';
import type { EditorContext } from './context.js';
import { newPkce } from './github/oauth.js';
import { newChecks, type OidcChecks } from './oidc.js';
import { h, layout, messagePage, PAGE_HEADERS } from './pages.js';
import type { Actor } from './service.js';

/**
 * The editor's session cookie. Deliberately not the docs site's
 * `opend_session`: different name, different signing secret, and host-only on
 * the editor's own host, so a reader session can never open the editor.
 */
export const EDITOR_COOKIE = 'opend_editor_session';
const LOGIN_COOKIE = 'opend_editor_login';
const SESSION_HOURS = 12;

export interface SignedIn extends Actor {
  csrf: string;
}

function secure(ctx: EditorContext): boolean {
  return ctx.config.publicUrl.startsWith('https://');
}

export function csrfToken(ctx: EditorContext, sessionId: string): string {
  return createHmac('sha256', ctx.config.sessionSecret)
    .update(`csrf:${sessionId}`)
    .digest('base64url');
}

/** The signed-in editor, from a valid, unrevoked session cookie. */
export async function currentEditor(
  request: FastifyRequest,
  ctx: EditorContext,
): Promise<SignedIn | null> {
  const raw = request.cookies[EDITOR_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const found = await getEditorSession(ctx.pool, unsigned.value);
  if (!found) return null;
  return { user: found.user, sessionId: found.session.id, csrf: csrfToken(ctx, found.session.id) };
}

/**
 * State-changing requests must come from the editor's own pages: the Origin
 * (when sent) must be the editor's, and the CSRF token must match the session.
 */
export function checkCsrf(request: FastifyRequest, ctx: EditorContext, editor: SignedIn): boolean {
  const origin = request.headers.origin;
  if (origin && origin !== ctx.config.publicUrl) return false;
  const header = request.headers['x-csrf-token'];
  const body = request.body as Record<string, unknown> | undefined;
  const sent =
    typeof header === 'string' ? header : typeof body?._csrf === 'string' ? body._csrf : '';
  const a = Buffer.from(sent);
  const b = Buffer.from(editor.csrf);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function wantsJson(request: FastifyRequest): boolean {
  return (
    String(request.headers.accept ?? '').includes('application/json') ||
    String(request.headers['content-type'] ?? '').includes('application/json')
  );
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

/**
 * Requires a signed-in editor (and, for POSTs, a valid CSRF token). Sends the
 * refusal itself and returns null when there is none.
 */
export async function requireEditor(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: EditorContext,
): Promise<SignedIn | null> {
  const editor = await currentEditor(request, ctx);
  if (!editor) {
    if (request.method === 'GET' && !wantsJson(request)) {
      await reply.redirect(`/auth/login?returnTo=${encodeURIComponent(safeReturnTo(request.url))}`);
    } else {
      await reply.code(401).send({ error: 'Sign in to the editor first.' });
    }
    return null;
  }
  if (request.method !== 'GET' && !checkCsrf(request, ctx, editor)) {
    await reply
      .code(403)
      .send({ error: 'This request did not come from the editor. Reload the page and try again.' });
    return null;
  }
  return editor;
}

async function startSession(
  reply: FastifyReply,
  ctx: EditorContext,
  user: EditorUser,
  provider: 'github' | 'oidc',
): Promise<void> {
  const session = await createEditorSession(ctx.pool, user.id, provider, SESSION_HOURS);
  await recordEditorAudit(ctx.pool, {
    sessionId: session.id,
    userId: user.id,
    action: 'sign_in',
    detail: { provider },
  });
  reply.setCookie(EDITOR_COOKIE, session.id, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: secure(ctx),
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  });
}

function setLoginCookie(reply: FastifyReply, ctx: EditorContext, value: object): void {
  reply.setCookie(LOGIN_COOKIE, JSON.stringify(value), {
    signed: true,
    httpOnly: true,
    // Lax lets the cookie come back on the provider's top-level redirect.
    sameSite: 'lax',
    secure: secure(ctx),
    path: '/auth',
    maxAge: 600,
  });
}

function readLoginCookie<T>(request: FastifyRequest, reply: FastifyReply): T | null {
  const raw = request.cookies[LOGIN_COOKIE];
  reply.clearCookie(LOGIN_COOKIE, { path: '/auth' });
  const unsigned = raw ? request.unsignCookie(raw) : null;
  if (!unsigned?.valid || !unsigned.value) return null;
  try {
    return JSON.parse(unsigned.value) as T;
  } catch {
    return null;
  }
}

function refuse(reply: FastifyReply, status: number, title: string, message: string) {
  return reply
    .code(status)
    .headers(PAGE_HEADERS)
    .type('text/html')
    .send(messagePage(title, message));
}

export function registerAuth(app: FastifyInstance, ctx: EditorContext): void {
  const githubCallback = `${ctx.config.publicUrl}/auth/github/callback`;
  const oidcCallback = `${ctx.config.publicUrl}/auth/oidc/callback`;

  app.get('/auth/login', async (request, reply) => {
    const returnTo = safeReturnTo((request.query as { returnTo?: unknown }).returnTo);
    const q = `?returnTo=${encodeURIComponent(returnTo)}`;
    const options = [
      ctx.githubOAuth
        ? `<li><a class="ed-button" href="/auth/github${h(q)}">Sign in with GitHub</a> <span class="ed-hint">for developers</span></li>`
        : '',
      ctx.oidc
        ? `<li><a class="ed-button" href="/auth/oidc${h(q)}">Sign in with your company account</a></li>`
        : '',
    ].join('');
    return reply
      .headers(PAGE_HEADERS)
      .type('text/html')
      .send(
        layout(
          { title: 'Sign in' },
          `<h1>Sign in to the editor</h1>
<p>The editor is for people who write the docs. Readers sign in on the docs site instead.</p>
<ul class="ed-signin">${options || '<li>No sign-in method is configured.</li>'}</ul>`,
        ),
      );
  });

  app.get('/auth/github', async (request, reply) => {
    if (!ctx.githubOAuth)
      return refuse(reply, 404, 'Not available', 'GitHub sign-in is not configured.');
    const state = randomBytes(16).toString('base64url');
    const pkce = newPkce();
    setLoginCookie(reply, ctx, {
      state,
      verifier: pkce.verifier,
      returnTo: safeReturnTo((request.query as { returnTo?: unknown }).returnTo),
    });
    return reply.redirect(ctx.githubOAuth.authorizationUrl(githubCallback, state, pkce.challenge));
  });

  app.get('/auth/github/callback', async (request, reply) => {
    const pending = readLoginCookie<{ state: string; verifier?: string; returnTo: string }>(
      request,
      reply,
    );
    const query = request.query as { code?: string; state?: string };
    if (!ctx.githubOAuth || !pending || !query.code || query.state !== pending.state)
      return refuse(reply, 400, 'Sign-in expired', 'Please sign in again.');
    let login;
    try {
      login = await ctx.githubOAuth.exchange(query.code, githubCallback, pending.verifier);
    } catch (err) {
      ctx.log({ level: 'warn', msg: 'github sign-in rejected', error: String(err) });
      return refuse(reply, 400, 'Sign-in failed', 'Please try signing in again.');
    }
    let user = await findEditorUserForGitHub(ctx.pool, login);
    if (!user) {
      // Developers who can already push to the docs repository need no invitation.
      const rc = await ctx.repoContext();
      const permission = await rc.gh.collaboratorPermission(login.login);
      if (permission === 'admin' || permission === 'maintain' || permission === 'write') {
        const email = login.verifiedEmail ?? `${login.id}+${login.login}@users.noreply.github.com`;
        user = await createEditorUserFromGitHub(ctx.pool, login, email).catch(() => null);
      }
    }
    if (!user || user.disabled) {
      ctx.log({ level: 'info', msg: 'editor sign-in without access', github: login.login });
      return refuse(
        reply,
        403,
        'No access',
        `@${login.login} cannot edit these docs. Ask an administrator to add you as an editor.`,
      );
    }
    await startSession(reply, ctx, user, 'github');
    return reply.redirect(safeReturnTo(pending.returnTo));
  });

  app.get('/auth/oidc', async (request, reply) => {
    if (!ctx.oidc) return refuse(reply, 404, 'Not available', 'Company sign-in is not configured.');
    const checks = newChecks();
    setLoginCookie(reply, ctx, {
      ...checks,
      returnTo: safeReturnTo((request.query as { returnTo?: unknown }).returnTo),
    });
    return reply.redirect((await ctx.oidc.authorizationUrl(oidcCallback, checks)).href);
  });

  app.get('/auth/oidc/callback', async (request, reply) => {
    const pending = readLoginCookie<OidcChecks & { returnTo: string }>(request, reply);
    if (!ctx.oidc || !pending)
      return refuse(reply, 400, 'Sign-in expired', 'Please sign in again.');
    let identity;
    try {
      identity = await ctx.oidc.exchange(new URL(request.url, ctx.config.publicUrl), pending);
    } catch (err) {
      ctx.log({ level: 'warn', msg: 'editor oidc callback rejected', error: String(err) });
      return refuse(reply, 400, 'Sign-in failed', 'Please try signing in again.');
    }
    const user = await findEditorUserForOidc(ctx.pool, identity);
    if (!user || user.disabled) {
      ctx.log({ level: 'info', msg: 'editor sign-in without access', subject: identity.subject });
      return refuse(
        reply,
        403,
        'No access',
        `${identity.email ?? 'This account'} is not registered as an editor. Ask an administrator for access.`,
      );
    }
    await startSession(reply, ctx, user, 'oidc');
    return reply.redirect(safeReturnTo(pending.returnTo));
  });

  app.post('/auth/logout', async (request, reply) => {
    const editor = await currentEditor(request, ctx);
    if (editor && checkCsrf(request, ctx, editor)) {
      await revokeEditorSession(ctx.pool, editor.sessionId);
      await recordEditorAudit(ctx.pool, {
        sessionId: editor.sessionId,
        userId: editor.user.id,
        action: 'sign_out',
      });
    }
    reply.clearCookie(EDITOR_COOKIE, { path: '/' });
    return reply.redirect('/auth/login');
  });
}
