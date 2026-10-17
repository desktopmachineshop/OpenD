import type { Db } from './db.js';

/**
 * Docs analytics: page views, searches and "was this helpful?" feedback.
 *
 * Nothing here identifies a reader. Events carry the org, the release line and
 * what was looked at; never a reader id, email or IP address. Writes are one
 * insert each; the summary aggregates raw rows on demand (bounded by retention).
 */

export type AnalyticsSurface = 'site' | 'embed' | 'api';

export type AnalyticsEvent =
  | {
      kind: 'view';
      surface: AnalyticsSurface;
      /** `null` for anonymous visitors of a public site. */
      orgSlug: string | null;
      releaseLine: string;
      topicId: string;
    }
  | {
      kind: 'search';
      surface: AnalyticsSurface;
      /** `null` for anonymous visitors of a public site. */
      orgSlug: string | null;
      releaseLine: string;
      /** Already normalised; see `normaliseQuery`. */
      query: string;
      resultCount: number;
    };

export interface FeedbackInput {
  surface: 'site' | 'embed';
  orgSlug: string;
  releaseLine: string;
  topicId: string;
  helpful: boolean;
  comment?: string | null;
}

export const MAX_FEEDBACK_COMMENT = 1000;
export const MAX_QUERY_LENGTH = 200;

/**
 * Normalises a search query for aggregation: Unicode-normalised, lower case,
 * single spaces, at most 200 characters. Email addresses and long digit runs
 * (seven or more digits: phone, account or card numbers) are redacted.
 */
export function normaliseQuery(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .replace(/\d(?:[ -]?\d){6,}/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
}

export async function recordAnalyticsEvent(db: Db, e: AnalyticsEvent): Promise<void> {
  if (e.kind === 'view') {
    await db.query(
      `insert into analytics_events (kind, surface, org_slug, release_line, topic_id)
       values ('view', $1, $2, $3, $4)`,
      [e.surface, e.orgSlug, e.releaseLine, e.topicId],
    );
  } else {
    await db.query(
      `insert into analytics_events (kind, surface, org_slug, release_line, query, result_count)
       values ('search', $1, $2, $3, $4, $5)`,
      [e.surface, e.orgSlug, e.releaseLine, e.query, e.resultCount],
    );
  }
}

export async function recordFeedback(db: Db, f: FeedbackInput): Promise<void> {
  const comment = f.comment?.trim() ? f.comment.trim().slice(0, MAX_FEEDBACK_COMMENT) : null;
  await db.query(
    `insert into analytics_feedback (surface, org_slug, release_line, topic_id, helpful, comment)
     values ($1, $2, $3, $4, $5, $6)`,
    [f.surface, f.orgSlug, f.releaseLine, f.topicId, f.helpful, comment],
  );
}

export interface AnalyticsQuery {
  /** Look back this many days. */
  days: number;
  /** Rows per list. */
  limit: number;
  /** Only this org. */
  orgSlug?: string;
}

export interface AnalyticsSummary {
  days: number;
  since: string;
  totals: { views: number; searches: number; feedback: number };
  viewsBySurface: { surface: AnalyticsSurface; views: number }[];
  topPages: { topicId: string; views: number }[];
  topSearches: { query: string; searches: number; avgResults: number }[];
  zeroResultSearches: { query: string; searches: number }[];
  /** Pages with feedback, least helpful first. `ratio` is helpful / total. */
  helpfulness: { topicId: string; helpful: number; unhelpful: number; ratio: number }[];
}

export async function analyticsSummary(db: Db, q: AnalyticsQuery): Promise<AnalyticsSummary> {
  const since = new Date(Date.now() - q.days * 86_400_000);
  const params = [since, q.orgSlug ?? null, q.limit];
  const where = `at >= $1 and ($2::text is null or org_slug = $2)`;
  const [totals, surfaces, pages, searches, zero, helpful] = await Promise.all([
    db.query<{ views: number; searches: number; feedback: number }>(
      `select
         (select count(*)::int from analytics_events where ${where} and kind = 'view') as views,
         (select count(*)::int from analytics_events where ${where} and kind = 'search') as searches,
         (select count(*)::int from analytics_feedback where ${where}) as feedback`,
      params.slice(0, 2),
    ),
    db.query<{ surface: AnalyticsSurface; views: number }>(
      `select surface, count(*)::int as views from analytics_events
       where ${where} and kind = 'view' group by surface order by views desc, surface limit $3`,
      params,
    ),
    db.query<{ topicId: string; views: number }>(
      `select topic_id as "topicId", count(*)::int as views from analytics_events
       where ${where} and kind = 'view' group by topic_id order by views desc, topic_id limit $3`,
      params,
    ),
    db.query<{ query: string; searches: number; avgResults: number }>(
      `select query, count(*)::int as searches,
         round(avg(result_count), 1)::float8 as "avgResults"
       from analytics_events where ${where} and kind = 'search'
       group by query order by searches desc, query limit $3`,
      params,
    ),
    db.query<{ query: string; searches: number }>(
      `select query, count(*)::int as searches from analytics_events
       where ${where} and kind = 'search' and result_count = 0
       group by query order by searches desc, query limit $3`,
      params,
    ),
    db.query<{ topicId: string; helpful: number; unhelpful: number; ratio: number }>(
      `select topic_id as "topicId",
         count(*) filter (where helpful)::int as helpful,
         count(*) filter (where not helpful)::int as unhelpful,
         round(avg(case when helpful then 1 else 0 end), 3)::float8 as ratio
       from analytics_feedback where ${where}
       group by topic_id order by ratio, count(*) desc, topic_id limit $3`,
      params,
    ),
  ]);
  return {
    days: q.days,
    since: since.toISOString(),
    totals: totals.rows[0]!,
    viewsBySurface: surfaces.rows,
    topPages: pages.rows,
    topSearches: searches.rows,
    zeroResultSearches: zero.rows,
    helpfulness: helpful.rows,
  };
}

export interface FeedbackEntry {
  id: number;
  at: Date;
  topicId: string;
  helpful: boolean;
  comment: string | null;
  surface: 'site' | 'embed';
  orgSlug: string;
  releaseLine: string;
}

/** Feedback, newest first. */
export async function listFeedback(
  db: Db,
  q: AnalyticsQuery & { topicId?: string; withComment?: boolean },
): Promise<FeedbackEntry[]> {
  const since = new Date(Date.now() - q.days * 86_400_000);
  const { rows } = await db.query<FeedbackEntry>(
    `select id, at, topic_id as "topicId", helpful, comment, surface, org_slug as "orgSlug",
       release_line as "releaseLine"
     from analytics_feedback
     where at >= $1 and ($2::text is null or org_slug = $2) and ($3::text is null or topic_id = $3)
       and (not $4 or comment is not null)
     order by at desc, id desc limit $5`,
    [since, q.orgSlug ?? null, q.topicId ?? null, q.withComment ?? false, q.limit],
  );
  return rows;
}

/** Deletes analytics rows older than `days`. Returns how many went. */
export async function purgeAnalytics(
  db: Db,
  days: number,
): Promise<{ events: number; feedback: number }> {
  const before = new Date(Date.now() - days * 86_400_000);
  const events = await db.query('delete from analytics_events where at < $1', [before]);
  const feedback = await db.query('delete from analytics_feedback where at < $1', [before]);
  return { events: events.rowCount ?? 0, feedback: feedback.rowCount ?? 0 };
}
