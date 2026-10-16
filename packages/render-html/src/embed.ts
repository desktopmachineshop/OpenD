import type { NavEntry } from '@opend/model';
import { resolveContext, searchView, type ReleaseView, type SearchHit } from '@opend/filter';
import { encodePath, escapeHtml } from './escape.js';
import { pageHref, renderTopic, type RenderOptions } from './render.js';
import { DEFAULT_CSS } from './style.js';

/** Panel styles on top of the site styles; brand themes still apply. */
export const EMBED_CSS = `
body { font-size: 15px; }
.embed-bar { position: sticky; top: 0; z-index: 1; display: flex; gap: 8px; align-items: center;
  padding: 8px 12px; background: var(--opend-surface); border-bottom: 1px solid var(--opend-border); }
.embed-bar form { flex: 1; margin: 0; }
.embed-bar input[type=search] { width: 100%; font: inherit; padding: 6px 10px; border-radius: 6px;
  border: 1px solid var(--opend-border); background: var(--opend-surface-alt); color: inherit; }
.embed-close { display: none; font: 20px/1 var(--opend-font); background: none; border: 0; color: inherit; cursor: pointer; padding: 4px 6px; }
html[data-opend-embedded] .embed-close { display: inline-block; }
.embed-main { padding: 12px 16px 32px; }
.embed-main h1 { font-size: 22px; margin-top: 4px; }
.embed-main h2 { font-size: 17px; }
.embed-main .shortdesc { font-size: 16px; }
.embed-links { margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--opend-border); font-size: 14px; }
.embed-links h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--opend-muted); margin: 0 0 6px; }
.embed-links ul { list-style: none; padding: 0; margin: 0 0 12px; }
.embed-links li { margin: 4px 0; }
.embed-hits { list-style: none; padding: 0; }
.embed-hits li { margin: 0 0 14px; }
.embed-hits p { margin: 2px 0 0; color: var(--opend-muted); font-size: 14px; }
.embed-status { color: var(--opend-muted); }
`;

export interface EmbedOptions extends RenderOptions {
  /** Path prefix of embed routes. Default `/embed`. */
  embedBase?: string;
  /** Prefix for "Open in full docs" links, e.g. `https://docs.example.com/`. Default `/`. */
  fullDocsBase?: string;
  /**
   * The embedding page's origin, already checked against the allowed origins.
   * When set, the frame script talks to that page; otherwise the panel runs standalone.
   */
  hostOrigin?: string | null;
  /** Host app name, carried through links so contexts and search keep working. */
  app?: string;
  themeHref?: string;
}

function embedBase(o: EmbedOptions): string {
  return (o.embedBase ?? '/embed').replace(/\/$/, '');
}

/** Query string carried on every embed link: the host origin and app. */
function carry(o: EmbedOptions, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (o.hostOrigin) params.set('host', o.hostOrigin);
  if (o.app) params.set('app', o.app);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function embedTopicHref(topicId: string, o: EmbedOptions): string {
  return `${embedBase(o)}/topics/${encodePath(topicId)}.html${carry(o)}`;
}

function frameScriptTag(o: EmbedOptions, data: Record<string, string | undefined>): string {
  const attrs = Object.entries({ 'host-origin': o.hostOrigin ?? undefined, ...data })
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`)
    .join('');
  return `<script src="${embedBase(o)}/frame.js"${attrs}></script>`;
}

function shell(
  title: string,
  body: string,
  o: EmbedOptions,
  frameData: Record<string, string | undefined>,
  query = '',
): string {
  const theme = o.themeHref ? `<link rel="stylesheet" href="${escapeHtml(o.themeHref)}">` : '';
  const search = `<form method="get" action="${escapeHtml(embedBase(o))}/search" role="search">
${o.hostOrigin ? `<input type="hidden" name="host" value="${escapeHtml(o.hostOrigin)}">` : ''}${o.app ? `<input type="hidden" name="app" value="${escapeHtml(o.app)}">` : ''}
<input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search help" aria-label="Search help"></form>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${DEFAULT_CSS}${EMBED_CSS}</style>
${theme}
</head>
<body>
<header class="embed-bar">${search}<button type="button" class="embed-close" data-opend-close aria-label="Close help">×</button></header>
<main class="embed-main">${body}</main>
${frameScriptTag(o, frameData)}
</body>
</html>
`;
}

/** Visible siblings and children of a topic in the reader's navigation, for "In this section". */
export function navNeighbours(view: ReleaseView, topicId: string): NavEntry[] {
  const visible = (e: NavEntry) =>
    !e.hidden && e.topicId !== undefined && view.isVisible(e.topicId);
  // Groups and submaps without a title are transparent: lift their children.
  const flatten = (entries: readonly NavEntry[]): NavEntry[] =>
    entries.flatMap((e) => (!e.title && !e.topicId ? flatten(e.children) : [e]));
  const find = (entries: readonly NavEntry[]): { siblings: NavEntry[]; self: NavEntry } | null => {
    const flat = flatten(entries);
    const self = flat.find((e) => e.topicId === topicId);
    if (self) return { siblings: flat, self };
    for (const e of flat) {
      const found = find(e.children);
      if (found) return found;
    }
    return null;
  };
  const found = find(view.nav);
  if (!found) return [];
  const out = [
    ...flatten(found.self.children),
    ...found.siblings.filter((e) => e !== found.self),
  ].filter(visible);
  return out.slice(0, 8);
}

/** The help panel for one topic, or `null` when the reader cannot see it. */
export function renderEmbed(
  view: ReleaseView,
  topicId: string,
  o: EmbedOptions = {},
): string | null {
  const topic = view.topic(topicId);
  if (!topic) return null;
  const options: EmbedOptions = { ...o, topicHref: (id) => embedTopicHref(id, o) };
  const article = renderTopic(view, topic, options);
  const neighbours = navNeighbours(view, topicId)
    .map(
      (e) =>
        `<li><a href="${escapeHtml(embedTopicHref(e.topicId!, o))}">${escapeHtml(e.title)}</a></li>`,
    )
    .join('');
  const full = `${o.fullDocsBase ?? '/'}${pageHref(topicId, '')}`;
  const links = `<nav class="embed-links" aria-label="More help">
${neighbours ? `<h2>In this section</h2><ul>${neighbours}</ul>` : ''}
<a href="${escapeHtml(full)}" target="_blank" rel="noopener">Open in full docs ↗</a>
</nav>`;
  return shell(topic.title, article + links, o, {
    'topic-id': topicId,
    'topic-title': topic.title,
  });
}

export function renderEmbedSearch(
  _view: ReleaseView,
  query: string,
  hits: SearchHit[],
  o: EmbedOptions = {},
): string {
  const list = hits.length
    ? `<ul class="embed-hits">${hits
        .map(
          (h) =>
            `<li><a href="${escapeHtml(embedTopicHref(h.topicId, o))}">${escapeHtml(h.title)}</a><p>${escapeHtml(h.snippet)}</p></li>`,
        )
        .join('')}</ul>`
    : `<p class="embed-status">${query.trim() ? 'No help topics match your search.' : 'Type to search the help.'}</p>`;
  return shell(`Search: ${query}`, `<h1>Search help</h1>${list}`, o, {}, query);
}

/** A notice in the panel, e.g. no help for this screen yet. */
export function renderEmbedMessage(title: string, message: string, o: EmbedOptions = {}): string {
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1><p class="embed-status" data-opend-status>${escapeHtml(message)}</p>`,
    o,
    {},
  );
}

/** Shown while the frame obtains a session from the host's token. */
export function renderEmbedSignIn(next: string, o: EmbedOptions = {}): string {
  return shell('Help', `<p class="embed-status" data-opend-status>Loading help…</p>`, o, {
    'need-token': '1',
    next,
  });
}

export function embedContextHref(
  o: EmbedOptions,
  request: { key?: string; path?: string },
): string {
  const extra: Record<string, string> = {};
  if (request.key) extra.key = request.key;
  if (request.path) extra.path = request.path;
  return `${embedBase(o)}/context${carry(o, extra)}`;
}

export interface EmbedResult {
  status: number;
  html: string;
}

/**
 * Answers an embed request for one reader's view. Shared by the previewer and
 * hosted delivery so both resolve contexts, topics and search the same way:
 *
 *   /embed/context?app=&key=|path=   the help for a host-app context
 *   /embed/topics/<id>.html          a topic in the panel
 *   /embed/search?q=                 search the reader's visible topics
 */
export function handleEmbedRequest(
  view: ReleaseView,
  path: string,
  params: URLSearchParams,
  o: EmbedOptions,
): EmbedResult {
  const base = embedBase(o);
  if (path === `${base}/context`) {
    const app = params.get('app') ?? '';
    const request: { app: string; key?: string; path?: string } = { app };
    const key = params.get('key');
    const hostPath = params.get('path');
    if (key) request.key = key;
    else if (hostPath) request.path = hostPath;
    const resolved = resolveContext(view, request);
    if (resolved) {
      const html = renderEmbed(view, resolved.topicId, o);
      if (html) return { status: 200, html };
    }
    return {
      status: 404,
      html: renderEmbedMessage(
        'No help here yet',
        'There is no help for this screen yet. Try searching.',
        o,
      ),
    };
  }
  if (path === `${base}/search`) {
    const q = params.get('q') ?? '';
    return { status: 200, html: renderEmbedSearch(view, q, searchView(view, q), o) };
  }
  const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/topics/(.+)\\.html$`).exec(
    path,
  );
  if (m) {
    const html = renderEmbed(view, m[1]!, o);
    if (html) return { status: 200, html };
  }
  // Missing and hidden topics look the same.
  return {
    status: 404,
    html: renderEmbedMessage('Not found', 'This help topic is not available.', o),
  };
}
