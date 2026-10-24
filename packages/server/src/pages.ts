import { posix } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { DEFAULT_CSS, escapeHtml, renderVersionControl } from '@opend/render-html';
import type { ReaderAccess, Repo } from '@opend/store';
import { readerCsrfToken, safeReturnTo } from './auth.js';
import type { VersionChoice } from './access.js';
import type { AppContext } from './context.js';
import { SERVER_CSS } from './style.js';

/** A minimal page for sign-in, errors and notices. `body` is trusted HTML. */
export function simplePage(title: string, body: string, extraCss = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${DEFAULT_CSS}${SERVER_CSS}${extraCss}</style>
</head>
<body class="opend-plain"><main class="opend-simple" id="opend-main"><div class="opend-card">${body}</div></main></body>
</html>
`;
}

export function messagePage(title: string, message: string, link?: { href: string; text: string }) {
  const more = link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>` : '';
  return simplePage(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${more}`);
}

/** Markers in cached pages, replaced per request with the viewer's account controls. */
export const ACCOUNT_MARKER = '<!--opend-account-->';
export const MENU_ACCOUNT_MARKER = '<!--opend-menu-account-->';
/** Markers in cached pages, replaced per request with the version picker or the release label. */
export const VERSION_MARKER = '<!--opend-version-->';
export const MENU_VERSION_MARKER = '<!--opend-menu-version-->';
/** Marker on cached topic pages, replaced per request with "Edit this page" and source links. */
export const TOPIC_ACTIONS_MARKER = '<!--opend-topic-actions-->';

/** Whether any sign-in method is configured, so a "Sign in" link leads somewhere. */
export function signInAvailable(ctx: AppContext): boolean {
  return Boolean(ctx.oidc || ctx.githubOAuth || ctx.config.devLogin);
}

export function loginHref(returnTo: string): string {
  return `/auth/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

/**
 * The header's and the menu's account controls: "Sign in" for anonymous
 * visitors (public sites only reach here anonymously), or the reader's name
 * and a "Sign out" form carrying the session's CSRF token.
 */
export function accountControls(
  request: FastifyRequest,
  ctx: AppContext,
  access: ReaderAccess | null,
): { header: string; menu: string } {
  if (!access) {
    if (!signInAvailable(ctx)) return { header: '', menu: '' };
    const href = escapeHtml(loginHref(request.url));
    return {
      header: `<a class="site-account site-signin" href="${href}">Sign in</a>`,
      menu: `<a class="site-menu-signin" href="${href}">Sign in</a>`,
    };
  }
  const { email, name } = access.reader;
  const display = name?.trim() || email;
  const csrf = readerCsrfToken(request, ctx) ?? '';
  const form = `<form method="post" action="/auth/logout"><input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><button type="submit">Sign out</button></form>`;
  const initial = escapeHtml(Array.from(display)[0] ?? '?');
  const staff = access.reader.staff ? ' (staff view)' : '';
  // Staff readers run the site from the admin console.
  const admin = access.reader.staff ? '<a href="/admin">Admin</a>' : '';
  return {
    header: `<div class="site-account">${admin}<span class="site-account-who" title="${escapeHtml(email + staff)}"><span class="site-avatar" aria-hidden="true">${initial}</span><span class="site-account-name"><span class="opend-visually-hidden">Signed in as </span>${escapeHtml(display)}</span></span>${form}</div>`,
    menu: `<p class="site-menu-heading">Account</p><p class="site-menu-who">Signed in as <strong>${escapeHtml(display)}</strong>${display === email ? '' : ` (${escapeHtml(email)})`}${staff}</p>${admin ? `<p class="site-menu-who"><a href="/admin">Admin console</a></p>` : ''}${form}`,
  };
}

/** `/_version?v=&returnTo=`: switches the reader to `version` and returns them to the page. */
export function versionHref(version: string, returnTo: string): string {
  return `/_version?v=${encodeURIComponent(version)}&returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

/**
 * The header's and the menu's version controls: the version picker when the
 * site has one, otherwise the release label the page would have had. Each
 * link returns to the page the reader is on.
 */
export function versionControls(
  request: FastifyRequest,
  choice: VersionChoice | null,
  release: string,
): { header: string; menu: string } {
  if (!choice)
    return { header: `<span class="site-release">Release ${escapeHtml(release)}</span>`, menu: '' };
  return renderVersionControl(choice, (v) => versionHref(v, request.url));
}

const PENCIL_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg>';
const CODE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>';

/** `https://github.com/owner/name/blob/<sha>/<path>` for a repo cloned from GitHub, else null. */
export function sourceHref(
  repo: Pick<Repo, 'fullName' | 'sourceUrl' | 'docsPath'>,
  sha: string,
  file: string,
): string | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repo.sourceUrl);
  if (!match) return null;
  const path = posix.join(repo.docsPath || '.', file);
  if (path.startsWith('..')) return null;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${match[1]}/blob/${sha}/${encoded}`;
}

/**
 * "Edit this page" (staff readers, when the web editor is configured) and
 * "View source on GitHub" (when enabled). Only ever built for a topic the
 * viewer is being shown, so it names no path they could not already see.
 */
export function topicActions(
  ctx: AppContext,
  viewer: { access: ReaderAccess | null; repo: Repo; release: { stored: { sha: string } } },
  file: string,
): string {
  const links: string[] = [];
  if (viewer.access?.reader.staff && ctx.config.editorUrl && ctx.config.editLinks !== false) {
    const href = `${ctx.config.editorUrl}/edit?path=${encodeURIComponent(file)}`;
    links.push(`<a href="${escapeHtml(href)}">${PENCIL_ICON}Edit this page</a>`);
  }
  const source = ctx.config.sourceLinks
    ? sourceHref(viewer.repo, viewer.release.stored.sha, file)
    : null;
  if (source) links.push(`<a href="${escapeHtml(source)}">${CODE_ICON}View source on GitHub</a>`);
  return links.length
    ? `<nav class="opend-topic-actions" aria-label="Page source">${links.join('')}</nav>`
    : '';
}

export interface SignInOptions {
  returnTo: string;
  /** The site's title, shown on public sites only. */
  siteTitle?: string;
  github: boolean;
  /** "Sign in with <name>" for the OIDC provider. */
  oidcName?: string;
  /** The OIDC button's icon: GitHub's mark when the provider is GitHub (managed hosting). */
  oidcIcon?: 'github' | 'key';
  /** Development login (`OPEND_DEV_LOGIN`): sign in as any registered reader. */
  demoReaders?: { id: number; email: string; orgSlug: string; staff: boolean }[];
  /** Link back to the docs for public sites. */
  backToDocs?: boolean;
}

export const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
export const KEY_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M14 3a7 7 0 00-6.7 9.1L2 17.4V22h4.6l1-1v-2h2v-2h2l1.9-1.9A7 7 0 1014 3zm2.5 6A1.5 1.5 0 1116.5 6a1.5 1.5 0 010 3z"/></svg>';

/** The branded sign-in page: every configured provider, and demo readers in development. */
export function signInPage(o: SignInOptions): string {
  const q = `?returnTo=${encodeURIComponent(safeReturnTo(o.returnTo))}`;
  const providers: string[] = [];
  if (o.github)
    providers.push(
      `<li><a class="opend-auth-provider${providers.length ? '' : ' is-primary'}" href="/auth/github${escapeHtml(q)}">${GITHUB_ICON}Sign in with GitHub</a></li>`,
    );
  if (o.oidcName)
    providers.push(
      `<li><a class="opend-auth-provider${providers.length ? '' : ' is-primary'}" href="/auth/oidc${escapeHtml(q)}">${o.oidcIcon === 'github' ? GITHUB_ICON : KEY_ICON}Sign in with ${escapeHtml(o.oidcName)}</a></li>`,
    );
  const list = providers.length
    ? `<ul class="opend-auth-providers">${providers.join('')}</ul>`
    : '';
  let demo = '';
  if (o.demoReaders) {
    const items = o.demoReaders
      .map(
        (r) =>
          `<li><form method="post" action="/auth/dev"><input type="hidden" name="readerId" value="${r.id}"><input type="hidden" name="returnTo" value="${escapeHtml(safeReturnTo(o.returnTo))}"><button type="submit"><span>${escapeHtml(r.email)}</span><small>${escapeHtml(r.staff ? `${r.orgSlug} · staff` : r.orgSlug)}</small></button></form></li>`,
      )
      .join('');
    demo = `<section class="opend-auth-demo" aria-labelledby="opend-demo-h"><h2 id="opend-demo-h">Demo readers <span class="opend-auth-badge">Development</span></h2>
<p>OPEND_DEV_LOGIN is on: anyone can sign in as any registered reader. Never use it with real content.</p>
<ul>${items || '<li>No readers yet. Run <code>opend-server seed</code>.</li>'}</ul></section>`;
  }
  const none =
    !list && !o.demoReaders
      ? '<p>No sign-in method is configured. Ask your administrator.</p>'
      : '';
  const site = o.siteTitle ? `<p class="opend-auth-site">${escapeHtml(o.siteTitle)}</p>` : '';
  const back = o.backToDocs
    ? '<p class="opend-auth-foot"><a href="/">Continue without signing in</a></p>'
    : '';
  return simplePage(
    'Sign in',
    `${site}<h1>Sign in</h1>
<p>Sign in to see the documentation for your organization.</p>
${list}${none}${demo}${back}`,
  );
}
