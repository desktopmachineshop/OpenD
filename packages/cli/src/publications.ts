import { resolvePdfTemplate, type CompiledRelease, type Publication } from '@opend/model';
import { viewPublication, viewRelease, type FilterPolicy } from '@opend/filter';
import { readSourceFile } from '@opend/build';
import {
  escapeHtml,
  publicationHasContent,
  publicationHref,
  publicationLayout,
  renderPublication,
  type PrintLayout,
} from '@opend/render-html';
import type { LoadedProject, PreviewAudience } from './project.js';

/** Publications with at least one topic these policies let through. */
export function visiblePublications(
  release: CompiledRelease,
  policies: readonly FilterPolicy[],
): Publication[] {
  return release.publications.filter((p) => {
    const view = viewPublication(release, p.file, policies);
    return view !== null && publicationHasContent(view);
  });
}

/**
 * The print HTML of a publication for the preview reader, with the page
 * set-up of the project's PDF template, or `null` when it
 * does not exist or holds nothing they can see. Previews always resolve
 * conditional keys, so the staff view prints the first alternative.
 */
export async function previewPublicationHtml(
  project: LoadedProject,
  release: CompiledRelease,
  publication: Publication,
  audience: PreviewAudience,
  policies: readonly FilterPolicy[],
  siteBase: string,
): Promise<{ html: string; layout: PrintLayout } | null> {
  const view = viewPublication(release, publication.file, policies);
  if (!view || !publicationHasContent(view)) return null;
  const read = async (path: string) => {
    try {
      return await readSourceFile(project.root, path, project.ref);
    } catch {
      return null;
    }
  };
  const options: Parameters<typeof renderPublication>[1] = {
    // Only files the content references, never sources or config.
    assets: async (path) => (release.assets.includes(path) ? read(path) : null),
    site: viewRelease(release, policies),
    siteBase,
    template: resolvePdfTemplate(release.pdf),
  };
  if (release.theme) {
    const theme = await read(release.theme);
    if (theme) options.themeCss = theme.toString('utf8');
  }
  if (audience.kind !== 'all' && audience.context.org) options.orgName = audience.context.org;
  return { html: await renderPublication(view, options), layout: publicationLayout(view, options) };
}

/** `/_opend/publications`: every publication and whether the preview reader sees it. */
export function publicationsIndex(
  release: CompiledRelease,
  policies: readonly FilterPolicy[],
  audienceLabel: string,
): string {
  const visible = new Set(visiblePublications(release, policies).map((p) => p.file));
  const rows = release.publications
    .map((p) => {
      const href = publicationHref(p);
      const links = visible.has(p.file)
        ? `<a href="${escapeHtml(href)}">PDF</a> · <a href="${escapeHtml(href.replace(/\.pdf$/, '.html'))}">print HTML</a>`
        : '<em>nothing visible to this reader</em>';
      return `<tr><td>${escapeHtml(p.title || p.file)}</td><td><code>${escapeHtml(p.file)}</code></td><td>${links}</td></tr>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Publications</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; margin: 24px; max-width: 900px; }
table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
</style></head>
<body>
<h1>Publications</h1>
<p>As ${escapeHtml(audienceLabel)}. <a href="/">Back to the docs</a></p>
${rows ? `<table><thead><tr><th>Title</th><th>Map</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No publications in opend.config.yaml.</p>'}
</body></html>
`;
}
