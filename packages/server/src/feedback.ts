import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { MAX_FEEDBACK_COMMENT, recordFeedback } from '@opend/store';
import { FEEDBACK_PATH } from './analytics.js';
import { checkReaderCsrf, currentAccess, safeReturnTo } from './auth.js';
import type { AppContext } from './context.js';
import { PAGE_HEADERS, readerRelease } from './delivery.js';
import { embedFrameHeaders } from './embed.js';
import { messagePage } from './pages.js';

const feedbackSchema = z.object({
  topic: z.string().min(1).max(500),
  helpful: z.enum(['yes', 'no']),
  comment: z
    .string()
    .max(MAX_FEEDBACK_COMMENT)
    // Postgres text cannot hold NUL; nothing else needs stripping, output escapes it.
    .transform((c) => c.replaceAll('\0', ''))
    .optional(),
  surface: z.enum(['site', 'embed']).default('site'),
  return: z.string().max(2000).optional(),
});

/** Where the reader goes after sending feedback: back to the page, with a thank-you. */
function thanksLocation(returnTo: unknown): string {
  const url = new URL(safeReturnTo(returnTo), 'http://x');
  url.searchParams.set('feedback', 'thanks');
  url.hash = 'opend-feedback';
  return url.pathname + url.search + url.hash;
}

/**
 * "Was this page helpful?" answers from topic pages and help panels. Only a
 * signed-in reader, from our own form, about a topic in their own view: a
 * hidden topic gets the very same 404 as one that does not exist.
 */
export function registerFeedback(app: FastifyInstance, ctx: AppContext): void {
  const panelHeaders = ctx.config.embed ? embedFrameHeaders(ctx.config.embed.origins) : null;

  app.post(FEEDBACK_PATH, async (request, reply) => {
    // From the help panel, answers must stay frameable by the host app (an expired
    // embed session would otherwise show a blocked frame). Same answers either way.
    const fromPanel = (request.body as { surface?: unknown } | undefined)?.surface === 'embed';
    const headers = fromPanel && panelHeaders ? panelHeaders : PAGE_HEADERS;
    const page = (reply: FastifyReply, status: number, title: string, message: string) =>
      reply
        .code(status)
        .headers(headers)
        .type('text/html; charset=utf-8')
        .send(messagePage(title, message));
    const notFound = (reply: FastifyReply) =>
      page(reply, 404, 'Page not found', 'This page does not exist or is not available to you.');

    const access = await currentAccess(request, ctx);
    if (!access)
      return page(reply, 401, 'Signed out', 'Sign in again to send feedback about this page.');
    if (!checkReaderCsrf(request, ctx))
      return page(reply, 403, 'Form expired', 'Reload the page and send your feedback again.');
    if (!ctx.analytics.enabled || !access.context) return notFound(reply);
    const parsed = feedbackSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return page(
        reply,
        400,
        'Feedback not sent',
        `Choose Yes or No, and keep comments under ${MAX_FEEDBACK_COMMENT} characters.`,
      );
    const input = parsed.data;
    const release = await readerRelease(ctx, access.context);
    // Same answer for "no such topic" and "not in your view".
    if (typeof release === 'string' || !release.view.topic(input.topic)) return notFound(reply);
    try {
      await recordFeedback(ctx.pool, {
        surface: input.surface,
        orgSlug: access.orgSlug,
        releaseLine: release.line,
        topicId: input.topic,
        helpful: input.helpful === 'yes',
        comment: input.comment ?? null,
      });
    } catch (err) {
      ctx.log({ level: 'warn', msg: 'feedback insert failed', error: String(err) });
      return page(reply, 503, 'Feedback not sent', 'Something went wrong. Please try again later.');
    }
    return reply.headers(headers).redirect(thanksLocation(input.return), 303);
  });
}
