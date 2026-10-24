import { visibleNav, type ReleaseView, type SearchHit, type VisibleNavEntry } from '@opend/filter';
import { DEFAULT_CSS } from './style.js';
import { conditionLabel, pageHref, renderTopic, type RenderOptions } from './render.js';
import { escapeHtml } from './escape.js';

export interface PageOptions extends RenderOptions {
  /** URL of the theme stylesheet, if the project has one. */
  themeHref?: string;
  /** URL of the site theme set in the admin console. It loads after `themeHref`, so it wins. */
  siteThemeHref?: string;
  /** URL of the project logo, shown before the site title in the header. */
  logoHref?: string;
  /** Trusted HTML inserted at the top of the page body, e.g. the previewer banner. */
  banner?: string;
  /** Trusted HTML inserted at the end of the body, e.g. the live-reload script. */
  bodyEnd?: string;
  /** Trusted HTML after the article on topic pages only, e.g. the feedback form. */
  topicEnd?: string;
  /** "Download PDF" links in the header, for publications the reader can see. */
  publications?: { title: string; href: string }[];
  /**
   * Adds the search box to the header, submitting `GET <action>?q=`. Only for
   * servers that answer it (hosted delivery and the previewer).
   */
  search?: { action: string; query?: string };
  /**
   * Trusted HTML for the reader's account controls ("Sign in", or their name
   * and "Sign out"): `header` at the end of the wide-screen header, `menu` at
   * the end of the narrow-screen menu panel. The hosted server passes markers
   * here and fills them per request, as pages are cached per entitlement set.
   */
  account?: { header: string; menu: string };
  /**
   * Trusted HTML for the version control (see `renderVersionControl`): `header`
   * in place of the "Release" label after the site title, `menu` near the top
   * of the narrow-screen menu panel. Markers too on the hosted server.
   */
  version?: { header: string; menu: string };
}

/** What `renderVersionControl` shows: the version served and what the reader may switch to. */
export interface VersionControl {
  current: string;
  /** Newest first. With more than one, the reader may switch; otherwise it is a label. */
  options: string[];
}

/**
 * The version control: a label with the version served, or, when there is
 * more than one option, a `<details>` list of links (`href(version)`) to
 * switch, so it works without scripts. `header` goes in the wide-screen
 * header, `menu` in the narrow-screen menu panel.
 */
export function renderVersionControl(
  control: VersionControl,
  href: (version: string) => string,
): { header: string; menu: string } {
  const current = escapeHtml(control.current);
  if (control.options.length < 2)
    return {
      header: `<span class="site-release">Version ${current}</span>`,
      menu: `<div class="site-menu-versions"><p class="site-menu-heading">Version</p><p class="site-menu-version">${current}</p></div>`,
    };
  const links = control.options
    .map(
      (v) =>
        `<li><a href="${escapeHtml(href(v))}"${v === control.current ? ' aria-current="true"' : ''}>${escapeHtml(v)}</a></li>`,
    )
    .join('');
  return {
    header: `<details class="site-version"><summary>Version ${current}</summary><ul class="site-version-list" aria-label="Versions">${links}</ul></details>`,
    menu: `<nav class="site-menu-versions" aria-label="Version"><p class="site-menu-heading">Version</p><ul>${links}</ul></nav>`,
  };
}

/** Longest search query the site accepts; longer ones are cut, as analytics does. */
export const MAX_SEARCH_QUERY = 200;

/**
 * The `q` parameter of a site search request: the first value if it was given
 * more than once, trimmed, and cut to `MAX_SEARCH_QUERY` characters.
 */
export function siteSearchQuery(raw: unknown): string {
  const value = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, MAX_SEARCH_QUERY).join('').trim();
}

/**
 * Renders the navigation tree for a view. Entries with children are collapsible
 * `<details>` groups (no script needed): the groups on the path to the current
 * page start open, the others closed. A heading group's `<summary>` is its
 * label; a topic with children keeps its link and gets a separate toggle.
 */
export function renderNav(
  view: ReleaseView,
  currentId: string | null,
  options: RenderOptions = {},
): string {
  const base = options.base ?? '/';
  // The `<li>` items for a list of entries, and whether the current page is among them.
  const items = (entries: readonly VisibleNavEntry[]): { html: string; current: boolean } => {
    let html = '';
    let current = false;
    for (const e of entries) {
      const inner = items(e.children);
      const isCurrent = e.topicId !== undefined && e.topicId === currentId;
      current ||= isCurrent || inner.current;
      const label = escapeHtml(e.title);
      const condition = options.showConditions ? conditionLabel(e.condition) : '';
      const badge = condition ? ` <span class="opend-badge">${escapeHtml(condition)}</span>` : '';
      const link = e.topicId
        ? `<a href="${escapeHtml(pageHref(e.topicId, base))}"${isCurrent ? ' aria-current="page"' : ''}>${label}</a>`
        : '';
      if (!inner.html) {
        html += `<li>${link}${badge}</li>`;
        continue;
      }
      const open = isCurrent || inner.current ? ' open' : '';
      const list = `<ul>${inner.html}</ul>`;
      html += link
        ? `<li class="nav-group nav-group-link">${link}${badge}<details${open}><summary class="nav-toggle"><span class="opend-visually-hidden">Subtopics of ${label}</span></summary>${list}</details></li>`
        : `<li class="nav-group"><details${open}><summary class="nav-heading">${label}${badge}</summary>${list}</details></li>`;
    }
    return { html, current };
  };
  const { html } = items(visibleNav(view));
  return html ? `<ul>${html}</ul>` : '';
}

function publicationLinks(options: PageOptions): string {
  const links = (options.publications ?? [])
    .map(
      (p) =>
        `<a class="site-pdf" href="${escapeHtml(p.href)}" title="Download PDF">${escapeHtml(p.title)} (PDF)</a>`,
    )
    .join('');
  return links ? `<nav class="site-pdfs" aria-label="Download PDF">${links}</nav>` : '';
}

/** The search form; `id` must be unique in the page, as the header and the menu each have one. */
function searchBox(options: PageOptions, className = 'site-search', id = 'opend-search-q'): string {
  if (!options.search) return '';
  const { action, query = '' } = options.search;
  return `<form class="${className}" role="search" method="get" action="${escapeHtml(action)}"><label class="opend-visually-hidden" for="${id}">Search the documentation</label><input type="search" id="${id}" name="q" value="${escapeHtml(query)}" maxlength="${MAX_SEARCH_QUERY}" placeholder="Search the docs"><button type="submit">Search</button></form>`;
}

/**
 * The narrow-screen menu: a `<details>` in the sticky header whose panel holds
 * search, the contents, the PDF links and the account controls. These duplicate the header's search
 * and PDF links and the sidebar, which the stylesheet hides (`display: none`)
 * on narrow screens, while the menu is hidden on wide ones; so each is in the
 * accessibility tree only once.
 */
function menu(nav: string, options: PageOptions): string {
  const search = searchBox(options, 'site-menu-search', 'opend-menu-search-q');
  const pdfs = (options.publications ?? [])
    .map((p) => `<li><a href="${escapeHtml(p.href)}">${escapeHtml(p.title)} (PDF)</a></li>`)
    .join('');
  const account = options.account?.menu
    ? `<div class="site-menu-account">${options.account.menu}</div>`
    : '';
  const versions = options.version?.menu ?? '';
  if (!nav && !search && !pdfs && !account && !versions) return '';
  const contents = nav
    ? `<nav class="opend-nav site-menu-nav" aria-label="Contents">${nav}</nav>`
    : '';
  const publications = pdfs
    ? `<nav class="site-menu-pdfs" aria-label="Download PDF"><p class="site-menu-heading">Publications</p><ul>${pdfs}</ul></nav>`
    : '';
  return `<details class="site-menu"><summary aria-controls="opend-menu-panel"><span class="site-menu-button">${MENU_ICON}<span>Menu</span></span></summary><div class="site-menu-panel" id="opend-menu-panel">${search}${versions}${contents}${publications}${account}</div></details>`;
}

/** Three bars, and a cross shown instead while the menu is open. */
const MENU_ICON =
  '<svg class="site-menu-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path class="site-menu-bars" d="M4 7h16M4 12h16M4 17h16"/><path class="site-menu-close" d="M6 6l12 12M18 6L6 18"/></svg>';

/**
 * The page frame. Wide screens show the contents as a sidebar and search and
 * PDF links in the header. Narrow screens have a compact sticky header whose
 * "Menu" `<details>` opens a panel with all three, so it works without scripts.
 */
function shell(
  view: ReleaseView,
  title: string,
  main: string,
  currentId: string | null,
  options: PageOptions,
): string {
  const base = options.base ?? '/';
  const release = view.release;
  const theme = options.themeHref
    ? `<link rel="stylesheet" href="${escapeHtml(options.themeHref)}">`
    : '';
  const siteTheme = options.siteThemeHref
    ? `<link rel="stylesheet" href="${escapeHtml(options.siteThemeHref)}">`
    : '';
  const logo = options.logoHref
    ? `<img class="site-logo" src="${escapeHtml(options.logoHref)}" alt="">`
    : '';
  const nav = renderNav(view, currentId, options);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title ? `${title} · ${release.title}` : release.title)}</title>
<style>${DEFAULT_CSS}</style>
${theme}${siteTheme}
</head>
<body class="opend-site">
<a class="opend-skip" href="#opend-main">Skip to content</a>
${options.banner ?? ''}
<header class="site-header">${menu(nav, options)}<a class="site-title" href="${escapeHtml(base)}">${logo}<span>${escapeHtml(release.title)}</span></a>${options.version?.header ?? `<span class="site-release">Release ${escapeHtml(release.release)}</span>`}${publicationLinks(options)}${searchBox(options)}${options.account?.header ?? ''}</header>
<div class="layout">
<nav class="toc opend-nav" id="opend-toc" aria-label="Contents">${nav}</nav>
<main id="opend-main">${main}</main>
</div>
${options.bodyEnd ?? ''}
</body>
</html>
`;
}

/** A full HTML page for one topic, or `null` when the reader cannot see it. */
export function renderPage(
  view: ReleaseView,
  topicId: string,
  options: PageOptions = {},
): string | null {
  const topic = view.topic(topicId);
  if (!topic) return null;
  const main = renderTopic(view, topic, options) + (options.topicEnd ?? '');
  return shell(view, topic.title, main, topicId, options);
}

/** Landing page listing the reader's topics. */
export function renderIndex(view: ReleaseView, options: PageOptions = {}): string {
  const ids = view.topicIds();
  const main = ids.length
    ? `<article class="topic"><h1>${escapeHtml(view.release.title)}</h1><p>Choose a topic from the contents.</p></article>`
    : '<article class="topic"><h1>No content</h1><p>No topics are available for this reader.</p></article>';
  return shell(view, '', main, null, options);
}

/** Not-found page. Identical whether the topic is missing or hidden from this reader. */
export function renderNotFound(view: ReleaseView, options: PageOptions = {}): string {
  return shell(
    view,
    'Not found',
    '<article class="topic"><h1>Page not found</h1><p>This page does not exist or is not available to you.</p></article>',
    null,
    options,
  );
}

/**
 * Site search results. `hits` must come from searching this same view, so
 * they only name topics the reader can see; titles, snippets and the query
 * are plain text and escaped here. `limit` is the most hits the search returned.
 */
export function renderSearch(
  view: ReleaseView,
  query: string,
  hits: readonly SearchHit[],
  options: PageOptions & { limit?: number } = {},
): string {
  const base = options.base ?? '/';
  const q = escapeHtml(query);
  let body: string;
  if (!query) {
    body =
      '<p class="search-summary">Enter one or more words in the search box to search the documentation.</p>';
  } else if (!hits.length) {
    body = `<p class="search-summary" role="status">No topics match <q>${q}</q>.</p>
<p>Check the spelling, try fewer or more general words, or browse the contents.</p>`;
  } else {
    const count = hits.length === 1 ? '1 result' : `${hits.length} results`;
    const top = options.limit !== undefined && hits.length >= options.limit ? 'Top ' : '';
    const items = hits
      .map(
        (h) =>
          `<li><a href="${escapeHtml(pageHref(h.topicId, base))}">${escapeHtml(h.title)}</a>${h.snippet ? `<p class="search-snippet">${escapeHtml(h.snippet)}</p>` : ''}</li>`,
      )
      .join('');
    body = `<p class="search-summary" role="status">${top}${count} for <q>${q}</q></p>
<ol class="search-hits">${items}</ol>`;
  }
  const main = `<article class="topic search-results"><h1>Search</h1>${body}</article>`;
  const pageOptions: PageOptions = { ...options };
  if (options.search) pageOptions.search = { ...options.search, query };
  return shell(view, query ? `Search: ${query}` : 'Search', main, null, pageOptions);
}
