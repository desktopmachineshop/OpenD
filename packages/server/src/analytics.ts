import type { FastifyRequest } from 'fastify';
import { escapeHtml } from '@opend/render-html';
import {
  MAX_FEEDBACK_COMMENT,
  normaliseQuery,
  recordAnalyticsEvent,
  type AnalyticsEvent,
  type AnalyticsSurface,
  type Pool,
} from '@opend/store';
import type { Log } from '@opend/worker';
import { readerCsrfToken } from './auth.js';
import { DEFAULT_ANALYTICS, type AnalyticsConfig } from './config.js';
import type { AppContext } from './context.js';

/** Marker on cached topic pages, replaced per request with the feedback form (or nothing). */
export const FEEDBACK_MARKER = '<!--opend-feedback-->';
export const FEEDBACK_PATH = '/_opend/feedback';

/** Inserts still in flight beyond this are dropped rather than queued on the pool. */
const MAX_PENDING = 200;

/** `DNT: 1` or `Sec-GPC: 1`: the reader asked not to be tracked. */
export function optedOut(request: FastifyRequest): boolean {
  return request.headers.dnt === '1' || request.headers['sec-gpc'] === '1';
}

/**
 * Records page views and searches without ever delaying or failing the
 * response: each event is one insert, started after the page is ready and not
 * awaited. A failed insert is logged and forgotten.
 */
export class Analytics {
  readonly config: AnalyticsConfig;
  private readonly pending = new Set<Promise<void>>();
  /** Events not recorded because too many inserts were in flight. */
  dropped = 0;

  constructor(
    private readonly pool: Pool,
    private readonly log: Log,
    config: AnalyticsConfig = DEFAULT_ANALYTICS,
  ) {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  view(
    request: FastifyRequest,
    e: { surface: AnalyticsSurface; orgSlug: string; releaseLine: string; topicId: string },
  ): void {
    this.record(request, { kind: 'view', ...e });
  }

  search(
    request: FastifyRequest,
    e: {
      surface: AnalyticsSurface;
      orgSlug: string;
      releaseLine: string;
      query: string;
      resultCount: number;
    },
  ): void {
    const query = normaliseQuery(e.query);
    if (query) this.record(request, { kind: 'search', ...e, query });
  }

  /** Waits for in-flight inserts (shutdown and tests). */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private record(request: FastifyRequest, event: AnalyticsEvent): void {
    if (!this.enabled || optedOut(request)) return;
    if (this.pending.size >= MAX_PENDING) {
      this.dropped++;
      return;
    }
    const p: Promise<void> = Promise.resolve()
      .then(() => recordAnalyticsEvent(this.pool, event))
      .catch((err: unknown) =>
        this.log({ level: 'warn', msg: 'analytics insert failed', error: String(err) }),
      )
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
}

/** `path?query` of the request without our own `feedback` parameter. */
function returnPath(request: FastifyRequest): string {
  const url = new URL(request.url, 'http://x');
  url.searchParams.delete('feedback');
  return url.pathname + url.search;
}

/**
 * "Was this page helpful?" for a topic page or panel. Works without
 * JavaScript: a plain POST form with the reader's CSRF token, and the comment
 * box inside a native `<details>`. Empty when analytics are off or there is no
 * signed-in session.
 */
export function feedbackHtml(
  request: FastifyRequest,
  ctx: AppContext,
  topicId: string,
  surface: 'site' | 'embed',
): string {
  if (!ctx.analytics.enabled) return '';
  const csrf = readerCsrfToken(request, ctx);
  if (!csrf) return '';
  const thanks = (request.query as { feedback?: unknown } | undefined)?.feedback === 'thanks';
  if (thanks)
    return `<section class="opend-feedback" id="opend-feedback" aria-label="Page feedback"><p class="opend-feedback-thanks" role="status">Thanks for your feedback.</p></section>`;
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<section class="opend-feedback" id="opend-feedback" aria-label="Page feedback">
<form method="post" action="${FEEDBACK_PATH}">${hidden('_csrf', csrf)}${hidden('topic', topicId)}${hidden('surface', surface)}${hidden('return', returnPath(request))}
<span>Was this page helpful?</span>
<button type="submit" name="helpful" value="yes">Yes</button>
<button type="submit" name="helpful" value="no">No</button>
<details><summary>No? Tell us what was missing</summary>
<label for="opend-feedback-comment">What were you looking for? (optional)</label>
<textarea id="opend-feedback-comment" name="comment" maxlength="${MAX_FEEDBACK_COMMENT}"></textarea>
<button type="submit" name="helpful" value="no">Send</button>
</details>
</form>
</section>`;
}
