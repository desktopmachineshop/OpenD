import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { publicationSlug } from '@opend/model';
import { viewRelease } from '@opend/filter';
import { readSourceFile } from '@opend/build';
import type { PdfRenderer } from '@opend/pdf';
import { renderOfflineSite, type OfflinePublication } from '@opend/render-html';
import { policiesFor, type LoadedProject, type PreviewAudience } from './project.js';
import { previewPublicationHtml, visiblePublications } from './publications.js';
import { zipFiles } from './zip.js';

export interface PackageOptions {
  /** Who the package is for. Only what they may see goes in. */
  audience: PreviewAudience;
  /** Prints each visible publication into `pdf/`. Without it, no PDFs are bundled. */
  pdf?: PdfRenderer;
}

/**
 * The offline package of a built project for one audience: the files of a
 * static site (see `renderOfflineSite`), by `/`-separated path, sorted.
 */
export async function packageOffline(
  project: LoadedProject,
  options: PackageOptions,
): Promise<Map<string, Buffer>> {
  const release = project.build.release;
  if (!release) throw new Error('the docs did not build');
  const { audience } = options;
  const policies = [...project.build.buildPolicies, ...policiesFor(audience)];
  const view = viewRelease(release, policies, { resolveChoices: audience.kind !== 'all' });

  const publications: OfflinePublication[] = [];
  if (options.pdf) {
    for (const publication of visiblePublications(release, policies)) {
      // No site to link to: links to topics outside the publication print as text.
      const printed = await previewPublicationHtml(
        project,
        release,
        publication,
        audience,
        policies,
        '',
      );
      if (!printed) continue;
      publications.push({
        title: publication.title || publicationSlug(publication.file),
        file: `${publicationSlug(publication.file).replace(/[^\w.-]/g, '_')}.pdf`,
        data: await options.pdf.render(printed.html, printed.layout),
      });
    }
  }

  const files = await renderOfflineSite(view, {
    readFile: async (path) => {
      try {
        return await readSourceFile(project.root, path, project.ref);
      } catch {
        return null;
      }
    },
    showConditions: audience.kind === 'all',
    publications,
  });
  for (const path of files.keys()) {
    // Topic ids are paths inside the docs root; nothing may land outside the package.
    if (path.startsWith('/') || path.split('/').some((part) => part === '..' || part === ''))
      throw new Error(`refusing to package ${path}`);
  }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Writes the package as a `.zip` file, whose files sit in one folder named
 * after it, or into an empty (or new) folder.
 */
export async function writePackage(files: Map<string, Buffer>, out: string): Promise<void> {
  if (out.toLowerCase().endsWith('.zip')) {
    const folder = basename(out).slice(0, -'.zip'.length) || 'docs';
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(out, zipFiles([...files].map(([path, data]) => [`${folder}/${path}`, data])));
    return;
  }
  const root = resolve(out);
  const existing = await readdir(root).catch(() => []);
  if (existing.length) throw new Error(`${out} is not empty; choose a new folder or a .zip file`);
  for (const [path, data] of files) {
    const target = resolve(root, ...path.split('/'));
    if (!target.startsWith(root + sep)) throw new Error(`refusing to write ${path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

/** File name for the default package: the site title and release, and the reader. */
export function packageName(project: LoadedProject, audience: PreviewAudience): string {
  const release = project.build.release!;
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const who =
    audience.kind === 'named' ? audience.name : audience.kind === 'all' ? 'staff' : 'reader';
  return [slug(release.title) || 'docs', slug(release.release), slug(who)]
    .filter(Boolean)
    .join('-');
}
