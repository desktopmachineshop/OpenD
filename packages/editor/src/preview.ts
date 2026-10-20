import { posix } from 'node:path';
import {
  FILTER_ATTRIBUTES,
  RELEASE_ATTRIBUTE,
  isFilterAttribute,
  logoRoute,
  type CompiledRelease,
  type DocNode,
  type NavEntry,
  type ReaderContext,
} from '@opend/model';
import {
  compareVersions,
  parseReleaseRange,
  parseVersion,
  readerPolicy,
  tokens,
  versionInRange,
  viewRelease,
  type FilterPolicy,
} from '@opend/filter';
import {
  escapeHtml,
  renderIndex,
  renderNotFound,
  renderPage,
  type PageOptions,
} from '@opend/render-html';
import type { DraftBuild, EditorService, RepoContext } from './service.js';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export interface PreviewResponse {
  status: number;
  type: string;
  body: string | Buffer;
  /** Author-supplied file: served sandboxed. */
  asset?: boolean;
}

export interface PreviewAudience {
  /** `null`: the staff view, everything visible and conditions marked. */
  reader: ReaderContext | null;
  /** Staff view narrowed to one value per condition, e.g. `{ product: 'gadget' }`. */
  view?: PreviewView;
  /** Trusted HTML shown at the top of every page. */
  banner: string;
}

/** One chosen value per filtering attribute; `release` holds a version, e.g. `2.0`. */
export type PreviewView = Record<string, string>;

const VIEW_VALUE = /^[A-Za-z0-9._-]{1,64}$/;

/** The filtering attributes and values in `input` (a query or a path segment), ignoring the rest. */
export function previewView(input: Record<string, unknown>): PreviewView {
  const view: PreviewView = {};
  for (const attribute of FILTER_ATTRIBUTES) {
    const value = input[attribute];
    if (typeof value === 'string' && VIEW_VALUE.test(value)) view[attribute] = value;
  }
  return view;
}

/** Whether a query carries a view choice (any filtering attribute, even empty). */
export function choosesView(query: Record<string, unknown>): boolean {
  return Object.keys(query).some(isFilterAttribute);
}

/**
 * A view lives in the preview's path, `_view/product=gadget;release=2.0/`, so links
 * between preview pages keep it.
 */
export function viewSegment(view: PreviewView): string {
  const pairs = Object.entries(view).map(([a, v]) => `${a}=${v}`);
  return pairs.length ? `_view/${pairs.join(';')}/` : '';
}

/** Splits a preview path into its view and the page path after it. */
export function splitView(rest: string): { view: PreviewView; page: string } {
  const match = /^_view\/([^/]*)\/(.*)$/s.exec(rest);
  if (!match) return { view: {}, page: rest };
  const pairs = Object.fromEntries(
    match[1]!.split(';').map((pair) => {
      const at = pair.indexOf('=');
      return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
  return { view: previewView(pairs), page: match[2]! };
}

/**
 * Shows the chosen value of each attribute and hides its other values, like a
 * reader holding just those. A release version keeps the ranges that contain it.
 * Attributes without a choice are not decided, so they stay as the staff view shows them.
 */
export function viewPolicy(view: PreviewView): FilterPolicy {
  const version = view[RELEASE_ATTRIBUTE] ? parseVersion(view[RELEASE_ATTRIBUTE]) : null;
  return {
    name: 'preview-view',
    decide(attribute, value) {
      const chosen = view[attribute];
      if (chosen === undefined) return undefined;
      if (attribute === RELEASE_ATTRIBUTE) {
        const range = parseReleaseRange(value);
        return version && range && versionInRange(version, range) ? 'include' : 'exclude';
      }
      return value === chosen ? 'include' : 'exclude';
    },
  };
}

/**
 * The values the content uses per filtering attribute, sorted, for choosing a
 * preview view. For `release`, the versions its ranges start or end at and the
 * release itself, newest first.
 */
export function usedConditions(release: CompiledRelease): Record<string, string[]> {
  const used = new Map<string, Set<string>>();
  const add = (attrs: Record<string, string>) => {
    for (const [attribute, value] of Object.entries(attrs)) {
      if (!isFilterAttribute(attribute)) continue;
      let values = used.get(attribute);
      if (!values) used.set(attribute, (values = new Set()));
      for (const token of tokens(value)) values.add(token);
    }
  };
  const walk = (node: DocNode) => {
    if (node.type === 'text') return;
    add(node.attrs);
    node.children.forEach(walk);
  };
  const walkNav = (entry: NavEntry) => {
    add(entry.condition);
    entry.children.forEach(walkNav);
  };
  Object.values(release.topics).forEach((t) => walk(t.body));
  release.nav.forEach(walkNav);
  const out: Record<string, string[]> = {};
  for (const attribute of FILTER_ATTRIBUTES) {
    const values = used.get(attribute);
    if (!values?.size) continue;
    if (attribute !== RELEASE_ATTRIBUTE) {
      out[attribute] = [...values].filter((v) => VIEW_VALUE.test(v)).sort();
      continue;
    }
    const versions = new Map<string, number[]>();
    // `2` and `2.0` are one version; show it as `2.0`.
    const keep = (v: number[] | undefined) => {
      if (!v) return;
      const full = v.length < 2 ? [...v, 0] : v;
      versions.set(full.join('.'), full);
    };
    keep(parseVersion(release.release) ?? undefined);
    for (const value of values) {
      const range = parseReleaseRange(value);
      keep(range?.exact);
      keep(range?.from);
      keep(range?.to);
    }
    out[attribute] = [...versions]
      .sort(([, a], [, b]) => compareVersions(b, a))
      .map(([text]) => text);
  }
  return out;
}

export function banner(text: string, tone: 'draft' | 'org' = 'draft'): string {
  const color = tone === 'org' ? '#1d4ed8' : '#92400e';
  const bg = tone === 'org' ? '#dbeafe' : '#fef3c7';
  return `<div role="note" style="padding:6px 16px;font:14px system-ui,sans-serif;background:${bg};color:${color};border-bottom:1px solid ${color}">${escapeHtml(text)}</div>`;
}

/**
 * Serves one preview path (`index.html`, `<topic>.html`, `_theme.css`,
 * `_logo.<ext>`, `_assets/<file>`) from a draft build, under `base`.
 */
export async function renderPreview(
  service: EditorService,
  rc: RepoContext,
  draft: DraftBuild,
  rest: string,
  base: string,
  audience: PreviewAudience,
): Promise<PreviewResponse> {
  const release = draft.result.release;
  if (!release) {
    const problems = draft.diagnostics
      .filter((d) => d.severity === 'error')
      .slice(0, 20)
      .map(
        (d) =>
          `<li>${escapeHtml(`${d.file ?? ''}${d.line ? `:${d.line}` : ''} ${d.message}`)}</li>`,
      )
      .join('');
    return {
      status: 200,
      type: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview unavailable</title></head><body>${audience.banner}<main style="font:16px system-ui,sans-serif;padding:16px"><h1>Preview unavailable</h1><p>The docs could not be built:</p><ul>${problems}</ul></main></body></html>`,
    };
  }
  const fileResponse = async (path: string): Promise<PreviewResponse> => {
    const sha = draft.blobs.get(path);
    if (!sha) return { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found' };
    return {
      status: 200,
      type: CONTENT_TYPES[posix.extname(path).toLowerCase()] ?? 'application/octet-stream',
      body: await service.blob(rc, sha),
      asset: true,
    };
  };
  if (rest === '_theme.css') {
    if (!release.theme)
      return { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found' };
    const edited = draft.tree.texts.get(release.theme);
    if (draft.edited.includes(release.theme) && edited !== undefined)
      return { status: 200, type: 'text/css; charset=utf-8', body: edited };
    return fileResponse(release.theme);
  }
  if (release.logo && rest === logoRoute(release.logo)) return fileResponse(release.logo);
  if (rest.startsWith('_assets/')) {
    const path = rest.slice('_assets/'.length);
    // Only files the content references, never sources or config.
    if (!release.assets.includes(path))
      return { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found' };
    return fileResponse(path);
  }
  const narrowed = Object.keys(audience.view ?? {}).length > 0;
  const policies = [
    ...draft.result.buildPolicies,
    ...(audience.reader ? [readerPolicy(audience.reader)] : []),
    ...(narrowed ? [viewPolicy(audience.view!)] : []),
  ];
  const view = viewRelease(release, policies, {
    resolveChoices: audience.reader !== null || narrowed,
  });
  const options: PageOptions = {
    base,
    showConditions: audience.reader === null,
    banner: audience.banner,
  };
  if (release.theme) options.themeHref = `${base}_theme.css`;
  if (release.logo) options.logoHref = `${base}${logoRoute(release.logo)}`;
  if (rest === '' || rest === 'index.html')
    return { status: 200, type: 'text/html; charset=utf-8', body: renderIndex(view, options) };
  if (rest.endsWith('.html')) {
    const page = renderPage(view, rest.slice(0, -'.html'.length), options);
    if (page) return { status: 200, type: 'text/html; charset=utf-8', body: page };
  }
  return { status: 404, type: 'text/html; charset=utf-8', body: renderNotFound(view, options) };
}
