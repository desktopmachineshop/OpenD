import { posix } from 'node:path';
import { logoRoute, type ReaderContext } from '@opend/model';
import { readerPolicy, viewRelease } from '@opend/filter';
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
  /** Trusted HTML shown at the top of every page. */
  banner: string;
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
  const policies = [
    ...draft.result.buildPolicies,
    ...(audience.reader ? [readerPolicy(audience.reader)] : []),
  ];
  const view = viewRelease(release, policies, { resolveChoices: audience.reader !== null });
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
