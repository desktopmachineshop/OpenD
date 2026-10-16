# 0009 Docs analytics and reader feedback, without tracking readers

## Status

Accepted.

## Context

Docs owners want to know which pages readers open, what they search for and fail to find, and which pages do not help. The hosted server already knows all of that at request time. It also knows who the reader is, their organization and their IP address, which we do not want in an analytics table: docs analytics should not double as an activity log of named people, and a privacy review should be able to read the schema and stop there.

The server's existing constraints apply: pages are server-rendered under a strict CSP (the docs site runs no scripts at all), hidden topics must be indistinguishable from missing ones, and a render must never depend on anything optional.

## Decision

**What is stored.** Two tables, added by migration `005_analytics` (numbered past `004` so it applies in either order with the concurrent `004_search`; it uses `if not exists` like `003_polling`):

- `analytics_events`: `kind` (`view` or `search`), `surface` (`site`, `embed` or `api`), `org_slug`, `release_line`, then `topic_id` for views or `query` and `result_count` for searches, and `at`.
- `analytics_feedback`: `surface` (`site` or `embed`), `org_slug`, `release_line`, `topic_id`, `helpful`, an optional `comment` (at most 1000 characters, also enforced by a check constraint), and `at`.

No reader id, email, name, IP address, user agent or session id. The org slug is kept because "which customers read what" is the useful aggregate and an org is not a person. Columns are plain text rather than foreign keys, so deleting an org or a release does not rewrite history and the tables stay append-only.

Search queries are normalised before storage (NFKC, lower case, collapsed whitespace, at most 200 characters) so they aggregate, and email addresses and runs of seven or more digits are replaced with `[email]` and `[number]`: people paste account numbers and addresses into search boxes.

**What counts.** A view is a topic page actually rendered for the reader: site topic pages, help-panel topics (including a context that resolves to a topic), and JSON API topic or context lookups. Not-found and hidden pages are not views. A search is a non-empty help-panel or API search, with its hit count, so zero-result searches show what readers look for and cannot find. The docs site has no search of its own yet; `site` is already a valid surface for when it does.

**Cheap, non-blocking writes.** Each event is a single insert, started once the response is ready and never awaited by the request. Failures are logged (`analytics insert failed`) and dropped. At most 200 inserts may be in flight per process; beyond that events are dropped rather than queued on the shared pool, so an analytics backlog cannot starve page queries. `flush()` waits for in-flight inserts on shutdown and in tests. Feedback, by contrast, is the reader's explicit action and is awaited; if its insert fails the reader gets a 503 page instead of a false thank-you.

**Aggregates on demand, no rollup.** The admin summary runs `group by` queries over raw rows within the requested window, using indexes on `at` and `(kind, at)`. Retention (default 180 days) bounds the table, which keeps this fast enough for the sizes we expect and avoids a rollup job and its consistency problems. If volume grows, a daily rollup table can be added later without changing the event schema.

**Opt-outs.** `DNT: 1` or `Sec-GPC: 1` skips views and searches for that request. Feedback is still accepted, because the reader sends it deliberately and it carries nothing that identifies them. `OPEND_ANALYTICS=0` (also `false`, `off`, `no`) disables recording entirely and removes the feedback form; the feedback endpoint then answers 404. The admin read routes stay available so data recorded earlier can still be read until retention removes it.

**Retention.** The worker purges events and feedback older than `OPEND_ANALYTICS_RETENTION_DAYS` on start and every six hours, even with analytics off. `opend-server purge-analytics [--days N]` runs it on demand.

**Feedback form.** Topic pages and help-panel topics end with "Was this page helpful? Yes / No". The comment box sits in a native `<details>` element, so the whole form works without JavaScript: it posts to `POST /_opend/feedback` and redirects (303) back to the page with `?feedback=thanks#opend-feedback`, which renders a thank-you instead of the form. We did not add a progressive-enhancement script: the site's CSP has no `script-src` at all, and loosening it for a nicety that saves one page load is not worth it. The form reaches cached pages through a marker replaced per request, like the user bar, so pages stay cacheable per entitlement set.

**Feedback security.** The endpoint requires, in order:

1. A signed-in reader (site or embed session), else 401.
2. Same-origin and a CSRF token, else 403. The server had no CSRF tokens for reader forms (its only reader POST was sign-out, protected by `SameSite=Lax`), but the embed session cookie is `SameSite=None`, so SameSite cannot be relied on. We follow the editor's pattern: the Origin header, when present, must be `PUBLIC_URL`'s origin, and `_csrf` must equal an HMAC of the exact session cookie value under `SESSION_SECRET`. The token therefore changes with every sign-in and dies with the session, needs no server-side state, and one reader's token is useless with another's cookie.
3. Analytics enabled and the topic in the reader's own filtered view, else 404. Hidden and nonexistent topics return byte-identical 404 pages, and these checks run only after authentication and CSRF, so the endpoint reveals nothing to anyone who could not already open the page.

Comments are stored as text (NUL bytes removed, trimmed, length-checked in the request and in the database) and never rendered by OpenD itself. The admin API returns them in JSON; the CSV export quotes every field and prefixes values starting with `=`, `+`, `-`, `@`, tab or carriage return with an apostrophe to defuse spreadsheet formula injection. The docs tell admins to escape comments wherever they display them.

**Admin API.** `GET /admin/api/analytics/summary` (`days`, `limit`, `org`), `GET /admin/api/analytics/feedback` (`days`, `limit`, `org`, `topic`, `comments=1`) and `GET /admin/api/analytics/feedback.csv`, behind the existing admin bearer token. No server-rendered admin page.

## Consequences

- Owners get top pages, top and zero-result searches, and per-page helpfulness without the server keeping a record of individual readers' behaviour.
- Because nothing identifies a reader, there is no per-reader deduplication: one reader can answer the same page more than once, and reloads count as views. The numbers are indicative, not audited. A determined signed-in reader could also inflate feedback; rate limiting is left for later.
- Small orgs on niche topics may still be inferable from org slug plus timing. Admins who need stronger guarantees can filter less, shorten retention, or turn analytics off.
- Events are best-effort: a database outage or an overloaded process loses some, by design.
- Summary queries scan raw rows in the window. Fine within retention for expected volumes; a rollup can be added later.
