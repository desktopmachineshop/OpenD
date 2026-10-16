import type { NavEntry } from '@opend/model';
import type { ReleaseView, SearchHit } from '@opend/filter';
import { DEFAULT_CSS } from './style.js';
import { conditionLabel, pageHref, renderTopic, type RenderOptions } from './render.js';
import { escapeHtml } from './escape.js';

export interface PageOptions extends RenderOptions {
  /** URL of the theme stylesheet, if the project has one. */
  themeHref?: string;
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

/** Renders the navigation tree for a view. */
export function renderNav(
  view: ReleaseView,
  currentId: string | null,
  options: RenderOptions = {},
): string {
  const base = options.base ?? '/';
  // Returns the `<li>` items for a list of entries.
  const items = (entries: readonly NavEntry[]): string =>
    entries
      .map((e) => {
        if (e.hidden) return '';
        const visible = e.topicId !== undefined && view.isVisible(e.topicId);
        const inner = items(e.children);
        // Groups, submaps and entries whose topic is hidden: lift the children.
        // A hidden topic's navtitle is never shown, as it would reveal the topic.
        if (!visible && (!e.title || e.topicId !== undefined)) return inner;
        const children = inner ? `<ul>${inner}</ul>` : '';
        // A heading with nothing visible under it is omitted.
        if (!visible && !children) return '';
        const label = escapeHtml(e.title);
        const link =
          visible && e.topicId
            ? `<a href="${escapeHtml(pageHref(e.topicId, base))}"${e.topicId === currentId ? ' aria-current="page"' : ''}>${label}</a>`
            : `<span class="nav-heading">${label}</span>`;
        const condition = options.showConditions ? conditionLabel(e.condition) : '';
        const badge = condition ? ` <span class="opend-badge">${escapeHtml(condition)}</span>` : '';
        return `<li>${link}${badge}${children}</li>`;
      })
      .join('');
  const inner = items(view.nav);
  return inner ? `<ul>${inner}</ul>` : '';
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

function searchBox(options: PageOptions): string {
  if (!options.search) return '';
  const { action, query = '' } = options.search;
  return `<form class="site-search" role="search" method="get" action="${escapeHtml(action)}"><label class="opend-visually-hidden" for="opend-search-q">Search the documentation</label><input type="search" id="opend-search-q" name="q" value="${escapeHtml(query)}" maxlength="${MAX_SEARCH_QUERY}" placeholder="Search the docs"><button type="submit">Search</button></form>`;
}

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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title ? `${title} · ${release.title}` : release.title)}</title>
<style>${DEFAULT_CSS}</style>
${theme}
</head>
<body>
${options.banner ?? ''}
<header class="site-header"><a class="site-title" href="${escapeHtml(base)}">${escapeHtml(release.title)}</a><span class="site-release">Release ${escapeHtml(release.release)}</span>${publicationLinks(options)}${searchBox(options)}</header>
<div class="layout">
<nav class="toc" aria-label="Contents">${renderNav(view, currentId, options)}</nav>
<main>${main}</main>
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
