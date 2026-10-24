import { posix } from 'node:path';
import {
  ASSET_ATTR,
  publicationSlug,
  resolvePdfTemplate,
  walk,
  type NavEntry,
  type PdfTemplate,
  type Publication,
} from '@opend/model';
import type { PublicationView, ReleaseView } from '@opend/filter';
import { escapeHtml } from './escape.js';
import { pageHref, renderTopic, type RenderOptions, type TopicLink } from './render.js';
import { DEFAULT_CSS } from './style.js';
import { pdfPrintLayout, pdfTemplateCss, styleText, type PrintLayout } from './theme.js';

/** Layout for paged output. Loads after the site styles and before the brand theme. */
export const PRINT_CSS = `
@page { size: A4; margin: 20mm 18mm 18mm; }
html { color-scheme: light; }
body { font-size: 10.5pt; line-height: 1.5; background: #fff; }
article { max-width: none; }
h1 { font-size: 22pt; }
h2 { font-size: 15pt; }
h3 { font-size: 12.5pt; }
h1, h2, h3, h4, h5, h6, caption, figcaption { break-after: avoid; page-break-after: avoid; }
aside.note, figure, table, tr, pre, .image-break, .pub-toc li { break-inside: avoid; page-break-inside: avoid; }
pre { white-space: pre-wrap; overflow: visible; }
.table-wrap { overflow: visible; }
img { max-width: 100%; }
a { color: var(--opend-accent); text-decoration: none; }
a[href^="http"] { text-decoration: underline; text-decoration-thickness: 0.5pt; }
.pub-cover { display: flex; flex-direction: column; justify-content: center; min-height: 230mm; break-after: page; page-break-after: always; }
.pub-cover h1 { font-size: 30pt; margin: 0 0 12pt; color: var(--opend-accent); }
.pub-cover .pub-site { font-size: 15pt; margin: 0 0 4pt; }
.pub-cover .pub-meta { color: var(--opend-muted); margin: 2pt 0; }
.pub-cover .pub-note { margin-top: 18pt; font-weight: 600; color: var(--opend-heading); }
.pub-cover-banner { justify-content: flex-start; }
.pub-cover-banner .pub-banner { margin: 0 0 18pt; padding: 36pt 24pt 28pt; border-radius: var(--opend-radius); background: var(--opend-accent); color: var(--opend-on-accent); }
.pub-cover-banner .pub-banner h1 { color: inherit; margin: 0 0 6pt; }
.pub-cover-banner .pub-banner .pub-site { margin: 0; }
.pub-cover-minimal { justify-content: flex-start; padding-top: 30mm; }
.pub-cover-minimal h1 { color: var(--opend-heading); border-bottom: 1.5pt solid var(--opend-accent); padding-bottom: 8pt; }
.pub-titleblock { margin: 0 0 18pt; padding-bottom: 10pt; border-bottom: 1.5pt solid var(--opend-accent); }
.pub-titleblock h1 { margin: 0 0 4pt; color: var(--opend-accent); }
.pub-titleblock p { margin: 0; color: var(--opend-muted); }
.pub-toc { break-after: page; page-break-after: always; }
.pub-toc ol { list-style: none; padding-left: 0; margin: 0; }
.pub-toc ol ol { padding-left: 14pt; }
.pub-toc li { margin: 3pt 0; }
.pub-toc > ol > li { margin-top: 8pt; font-weight: 600; }
.pub-toc > ol > li li { font-weight: normal; }
.pub-chapter { break-before: page; page-break-before: always; }
.pub-part > .pub-heading { font-size: 24pt; }
.pub-empty { color: var(--opend-muted); }
`;

export interface PublicationRenderOptions {
  /** CSS text of the project theme. It is inlined after the print styles, so brand rules win. */
  themeCss?: string;
  /**
   * CSS of the site theme set in the admin console (`siteThemeCss(theme, { print: true })`).
   * It loads after the project theme, as it does on the site.
   */
  siteThemeCss?: string;
  /** Page set-up, cover, contents and running text. Default the `standard` template. */
  template?: PdfTemplate;
  /**
   * Loads a file the visible content references, by docs-root-relative path.
   * Images are inlined as data URIs: the PDF renderer has no reader session to
   * fetch them with. `null` leaves the image out and shows its alt text.
   */
  assets?: (path: string) => Promise<Buffer | null>;
  /**
   * The same reader's view of the docs site. Links to topics outside the
   * publication point at the site when this reader can see them there.
   */
  site?: ReleaseView;
  /** Absolute URL of the docs site, e.g. `https://docs.example.com/`. Needed for site links. */
  siteBase?: string;
  /**
   * Organization shown on the cover. Leave it out when one render is shared by
   * readers of several organizations.
   */
  orgName?: string;
  /** Generation time on the cover. Default now. */
  now?: Date;
}

const IMAGE_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** URL of a publication's PDF, e.g. `/pdf/admin-guide.pdf`. */
export function publicationHref(publication: Publication, base = '/'): string {
  return `${base}pdf/${encodeURIComponent(publicationSlug(publication.file))}.pdf`;
}

/** Whether the reader can see anything in the publication. */
export function publicationHasContent(view: PublicationView): boolean {
  return view.topicIds().length > 0;
}

/** Docs-root-relative paths of images in topics this view can see. */
export function publicationImages(view: ReleaseView): string[] {
  const images = new Set<string>();
  for (const id of view.topicIds()) {
    walk(view.topic(id)!.body, (el) => {
      const asset = el.attrs[ASSET_ATTR];
      if (asset && el.name === 'image') images.add(asset);
    });
  }
  return [...images].sort();
}

/** The values the running header and footer placeholders are filled with. */
function placeholderValues(view: PublicationView, now: Date | undefined) {
  return {
    title: view.publication.title || view.release.title,
    site: view.release.title,
    release: view.release.release,
    date: (now ?? new Date()).toISOString().slice(0, 10),
  };
}

/**
 * The printer's page set-up for a publication: page size, margins, running
 * header and footer. Pass it to the PDF renderer with `renderPublication`'s
 * document, with the same template.
 */
export function publicationLayout(
  view: PublicationView,
  options: Pick<PublicationRenderOptions, 'template' | 'now'> = {},
): PrintLayout {
  return pdfPrintLayout(
    options.template ?? resolvePdfTemplate(null),
    placeholderValues(view, options.now),
  );
}

/**
 * One reader's view of a publication as a single self-contained HTML document
 * for print: cover, linked contents, then every visible topic in map order.
 * Everything comes from the filtered view, so the document holds nothing the
 * reader may not see, and no filtering attributes.
 */
export async function renderPublication(
  view: PublicationView,
  options: PublicationRenderOptions = {},
): Promise<string> {
  const release = view.release;
  const title = view.publication.title || release.title;
  const template = options.template ?? resolvePdfTemplate(null);

  // Inline every image the visible topics use.
  const dataUris = new Map<string, string>();
  if (options.assets) {
    const load = options.assets;
    await Promise.all(
      publicationImages(view).map(async (path) => {
        const type = IMAGE_TYPES[posix.extname(path).toLowerCase()];
        if (!type) return;
        const data = await load(path);
        if (data) dataUris.set(path, `data:${type};base64,${data.toString('base64')}`);
      }),
    );
  }

  const anchors = new Map(view.topicIds().map((id, i) => [id, `pub-${i + 1}`]));
  const siteBase = options.siteBase;
  const topicLink = (id: string, fragment: string | undefined): TopicLink | null => {
    const anchor = anchors.get(id);
    if (anchor) {
      return {
        href: `#${anchor}${fragment ? `-${encodeURIComponent(fragment)}` : ''}`,
        title: view.topic(id)!.title,
      };
    }
    const onSite = siteBase ? options.site?.topic(id) : null;
    if (!onSite || !siteBase) return null;
    return {
      href: pageHref(id, siteBase) + (fragment ? `#${encodeURIComponent(fragment)}` : ''),
      title: onSite.title,
    };
  };
  const assetSrc = (path: string, use: 'image' | 'link'): string | null => {
    if (use === 'image') return dataUris.get(path) ?? null;
    return siteBase
      ? `${siteBase}_assets/${path.split('/').map(encodeURIComponent).join('/')}`
      : null;
  };

  // Body and contents walk the filtered nav together, rendering each topic once.
  const rendered = new Set<string>();
  let headings = 0;
  const walkNav = (entries: readonly NavEntry[], depth: number): { body: string; toc: string } => {
    let body = '';
    let toc = '';
    for (const e of entries) {
      const id = e.topicId;
      const topic = id && !rendered.has(id) ? view.topic(id) : null;
      if (topic && id) {
        rendered.add(id);
        const anchor = anchors.get(id)!;
        const renderOptions: RenderOptions = {
          topicLink,
          assetSrc,
          idPrefix: `${anchor}-`,
          depth: Math.min(depth, 5),
        };
        const children = walkNav(e.children, depth + 1);
        const classes = depth === 0 ? 'pub-entry pub-chapter' : 'pub-entry';
        body += `<div class="${classes}" id="${anchor}">${renderTopic(view, topic, renderOptions)}</div>${children.body}`;
        const label = escapeHtml(e.title || topic.title);
        if (!e.hidden) {
          toc += `<li><a href="#${anchor}">${label}</a>${children.toc ? `<ol>${children.toc}</ol>` : ''}</li>`;
        } else toc += children.toc;
        continue;
      }
      // A heading, a group, or an entry whose topic this reader cannot see.
      const isHeading = !id && Boolean(e.title);
      const children = walkNav(e.children, isHeading ? depth + 1 : depth);
      if (!children.body) continue; // nothing visible underneath: omit it entirely
      if (!isHeading) {
        // Never show a hidden topic's navtitle: lift its visible children instead.
        body += children.body;
        toc += children.toc;
        continue;
      }
      const anchor = `pub-h${++headings}`;
      const level = Math.min(depth + 1, 6);
      const classes = depth === 0 ? 'pub-part pub-chapter' : 'pub-part';
      body += `<section class="${classes}" id="${anchor}"><h${level} class="pub-heading">${escapeHtml(e.title)}</h${level}></section>${children.body}`;
      toc += e.hidden
        ? children.toc
        : `<li><a href="#${anchor}">${escapeHtml(e.title)}</a>${children.toc ? `<ol>${children.toc}</ol>` : ''}</li>`;
    }
    return { body, toc };
  };
  const { body, toc } = walkNav(view.nav, 0);

  const generated = placeholderValues(view, options.now).date;
  const org = options.orgName
    ? `<p class="pub-meta">Prepared for ${escapeHtml(options.orgName)}</p>`
    : '';
  const note = template.coverNote.trim()
    ? `<p class="pub-note">${escapeHtml(template.coverNote.trim())}</p>`
    : '';
  const meta = `<p class="pub-meta">Release ${escapeHtml(release.release)}</p>
<p class="pub-meta">Generated ${escapeHtml(generated)}</p>
${org}`;
  let cover: string;
  if (template.cover === 'none') {
    cover = `<header class="pub-titleblock">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(release.title)} · Release ${escapeHtml(release.release)} · Generated ${escapeHtml(generated)}</p>
${note}
</header>`;
  } else if (template.cover === 'banner') {
    cover = `<section class="pub-cover pub-cover-banner">
<div class="pub-banner">
<h1>${escapeHtml(title)}</h1>
<p class="pub-site">${escapeHtml(release.title)}</p>
</div>
${meta}${note}
</section>`;
  } else {
    cover = `<section class="pub-cover pub-cover-${template.cover}">
<h1>${escapeHtml(title)}</h1>
<p class="pub-site">${escapeHtml(release.title)}</p>
${meta}${note}
</section>`;
  }
  const contents =
    toc && template.toc
      ? `<nav class="pub-toc" aria-label="Contents"><h1>Contents</h1><ol>${toc}</ol></nav>`
      : '';
  const main =
    body || '<p class="pub-empty">No content in this publication is available to you.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${DEFAULT_CSS}</style>
<style>${PRINT_CSS}</style>
<style>${pdfTemplateCss(template)}</style>
${options.themeCss ? `<style>${styleText(options.themeCss)}</style>` : ''}
${options.siteThemeCss ? `<style>${styleText(options.siteThemeCss)}</style>` : ''}
${template.customCss.trim() ? `<style>${styleText(template.customCss)}</style>` : ''}
</head>
<body class="publication">
${cover}
${contents}
<main>${main}</main>
</body>
</html>
`;
}
