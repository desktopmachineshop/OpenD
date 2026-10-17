import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { findPublication } from '@opend/model';
import type { PublicationView } from '@opend/filter';
import { publicationHasContent, renderPublication } from '@opend/render-html';
import { assetKey } from '@opend/store';
import type { AppContext } from './context.js';
import { PAGE_HEADERS, publicationView, resolveViewer, type ReaderRelease } from './delivery.js';
import { messagePage } from './pages.js';

/**
 * Blob key of a generated PDF, by audience key (see `Audience`): readers with
 * the same entitlement set share one render, anonymous visitors and staff
 * each have their own, and a new release gets new keys, so nothing needs
 * invalidating. A change of public entitlements changes the anonymous key.
 */
export function pdfKey(releaseId: number, entitlements: string, slug: string): string {
  const hash = createHash('sha256').update(entitlements).digest('hex');
  return `pdf/${releaseId}/${hash}/${encodeURIComponent(slug)}.pdf`;
}

/** `GET /pdf/<slug>.pdf`: a publication printed for the viewer (reader, anonymous or staff). */
export function registerPdf(app: FastifyInstance, ctx: AppContext): void {
  /** Renders in progress in this process, by blob key. */
  const inflight = new Map<string, Promise<Buffer>>();

  const generate = async (release: ReaderRelease, view: PublicationView, key: string) => {
    const { stored } = release;
    const blob = async (path: string) => {
      try {
        return await ctx.blobs.get(assetKey(stored.repoId, stored.sha, path));
      } catch {
        return null; // an unsafe or unreadable path is just a missing image
      }
    };
    const options: Parameters<typeof renderPublication>[1] = {
      assets: blob,
      site: release.view,
      siteBase: `${ctx.config.publicUrl}/`,
      // No organization on the cover: the render is shared by every reader with
      // the same entitlements, whichever organization they belong to.
    };
    if (stored.snapshot.theme) {
      const theme = await blob(stored.snapshot.theme);
      if (theme) options.themeCss = theme.toString('utf8');
    }
    const started = Date.now();
    const pdf = await ctx.pdf.render(await renderPublication(view, options));
    await ctx.blobs.put(key, pdf);
    ctx.log({
      level: 'info',
      msg: 'pdf generated',
      key,
      bytes: pdf.length,
      ms: Date.now() - started,
    });
    return pdf;
  };

  app.get('/pdf/:file', async (request, reply) => {
    const r = await resolveViewer(ctx, request, reply);
    if (!r) return reply;
    const notFound = () =>
      reply
        .code(404)
        .headers(PAGE_HEADERS)
        .type('text/html; charset=utf-8')
        .send(
          messagePage('Not found', 'This publication does not exist or is not available to you.'),
        );
    const match = /^(.+)\.pdf$/.exec((request.params as { file: string }).file);
    const slug = match?.[1] ?? '';
    const publication = findPublication(r.release.stored.snapshot.publications, slug);
    const view = publication ? publicationView(ctx, r.release, publication.file) : null;
    // Missing publications and ones with nothing visible look the same.
    if (!view || !publicationHasContent(view)) return notFound();

    const key = pdfKey(r.release.stored.id, r.release.audience.key, slug);
    // Registered before the first await, so concurrent requests share one lookup and render.
    let pending = inflight.get(key);
    if (!pending) {
      const release = r.release;
      pending = (async () => (await ctx.blobs.get(key)) ?? generate(release, view, key))().finally(
        () => inflight.delete(key),
      );
      inflight.set(key, pending);
    }
    const pdf = await pending;
    const filename = `${slug.replace(/[^\w.-]/g, '_')}.pdf`;
    return reply
      .headers({
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename="${filename}"`,
      })
      .type('application/pdf')
      .send(pdf);
  });
}
