import { ASSET_ATTR, logoRoute, walk } from '@opend/model';
import type { ReleaseView } from '@opend/filter';
import { encodePath } from './escape.js';
import { renderPage, type PageOptions } from './page.js';

/** A publication printed for the same reader, bundled at `pdf/<slug>.pdf`. */
export interface OfflinePublication {
  title: string;
  /** File name inside `pdf/`, e.g. `admin-guide.pdf`. */
  file: string;
  data: Buffer;
}

export interface OfflineSiteOptions {
  /**
   * Reads a docs-root-relative file: a content asset, the theme or the logo.
   * Return `null` when it cannot be read; the page keeps working without it.
   */
  readFile(path: string): Promise<Buffer | null>;
  /** Staff view: mark conditional content. Never for a reader's package. */
  showConditions?: boolean;
  /** PDFs printed for this reader, linked from the header. */
  publications?: readonly OfflinePublication[];
}

/**
 * One reader's docs as a static site that opens from disk (`file://`) with no
 * server and no scripts: a page per visible topic at `<topic id>.html`, with
 * every link relative, plus `index.html` (the first topic), the files the
 * visible topics reference under `_assets/`, the theme, the logo and any
 * publications. There is no search box, as there is nothing to answer it.
 *
 * Everything comes from `view`, so the package holds exactly what the reader
 * may see: hidden topics, and assets only hidden topics use, are left out.
 * Returns the files by path, `/`-separated.
 */
export async function renderOfflineSite(
  view: ReleaseView,
  options: OfflineSiteOptions,
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const release = view.release;

  const theme = release.theme ? await options.readFile(release.theme) : null;
  if (theme) files.set('_theme.css', theme);
  const logo = release.logo ? await options.readFile(release.logo) : null;
  if (logo && release.logo) files.set(logoRoute(release.logo), logo);
  for (const p of options.publications ?? []) files.set(`pdf/${p.file}`, p.data);

  const assets = new Set<string>();
  const ids = view.topicIds();
  for (const id of ids) {
    walk(view.topic(id)!.body, (el) => {
      const asset = el.attrs[ASSET_ATTR];
      if (asset) assets.add(asset);
    });
  }
  const available = new Set<string>();
  for (const path of [...assets].sort()) {
    const data = await options.readFile(path);
    if (!data) continue;
    files.set(`_assets/${path}`, data);
    available.add(path);
  }

  /** Page options for a page at `path`, whose links climb back to the root. */
  const optionsAt = (path: string): PageOptions => {
    const depth = path.split('/').length - 1;
    const base = depth ? '../'.repeat(depth) : './';
    const pageOptions: PageOptions = {
      base,
      homeHref: `${base}index.html`,
      assetSrc: (asset) => (available.has(asset) ? `${base}_assets/${encodePath(asset)}` : null),
      showConditions: options.showConditions ?? false,
      publications: (options.publications ?? []).map((p) => ({
        title: p.title,
        href: `${base}pdf/${encodeURIComponent(p.file)}`,
      })),
    };
    if (theme) pageOptions.themeHref = `${base}_theme.css`;
    if (logo && release.logo) pageOptions.logoHref = `${base}${logoRoute(release.logo)}`;
    return pageOptions;
  };

  for (const id of ids) {
    const html = renderPage(view, id, optionsAt(id));
    if (html) files.set(`${id}.html`, Buffer.from(html));
  }
  // The landing page is the first topic, unless a topic is itself `index`.
  const first = ids[0];
  if (first !== undefined && !files.has('index.html')) {
    const html = renderPage(view, first, optionsAt('index.html'));
    if (html) files.set('index.html', Buffer.from(html));
  }
  return files;
}
