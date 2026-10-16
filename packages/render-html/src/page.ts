import type { NavEntry } from '@opend/model';
import type { ReleaseView } from '@opend/filter';
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
        // Groups, submaps and untitled entries whose topic is hidden: lift the children.
        if (!e.title && !visible) return inner;
        const children = inner ? `<ul>${inner}</ul>` : '';
        // A heading (or a hidden topic's navtitle) with nothing visible under it is omitted.
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
<header class="site-header"><a class="site-title" href="${escapeHtml(base)}">${escapeHtml(release.title)}</a><span class="site-release">Release ${escapeHtml(release.release)}</span>${publicationLinks(options)}</header>
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
