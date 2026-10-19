# 0015 Multi-site fleet mode

- Status: accepted
- Date: 2026-10-18

## Context

Managed hosting gives every customer their own deployment: web, worker, editor and Postgres. That isolation is worth paying for, but it sets a cost floor per customer that rules out free, trial and open-source plans. Those plans need many small sites on one deployment, without weakening OpenD's rule that a reader never sees what their entitlements do not allow, and without rewriting the single-site code paths that the leak tests cover.

Two shapes were considered:

1. **Shared tables with a site id and row-level security.** Every table gains `site_id`, every unique constraint and query changes, and one missed condition leaks across customers.
2. **A schema per site.** Each site's tables live in their own Postgres schema, selected per connection with `search_path`. No query names a schema, so the single-site code runs unchanged inside it.

## Decision

**Fleet mode, schema per site** (`opend-server fleet serve` and `opend-server fleet worker`, code in `packages/server/src/fleet/`).

- **Registry.** The `opend_fleet` schema holds `sites`: the slug, its schema (`site_<slug>`), the hosts it answers on (docs and editor), active or suspended, and its settings. The settings are the environment a single-site deployment would get (`PUBLIC_URL`, `SESSION_SECRET`, `OPEND_ADMIN_TOKEN`, OIDC, broker and so on), sealed as one value with `OPEND_FLEET_KEY`. The fleet owns the variables for its database, storage, address and GitHub hosts, and replaces them per site:
  - `DATABASE_URL` gains `options=-c search_path=site_<slug>`;
  - blobs go under `sites/site_<slug>/` (an S3 prefix, or a directory of `BLOB_DIR`).
- **One app per site, in one process.** The front end routes each request by its `Host`. On first use, it builds the site's web app (or editor app) with today's `createApp`, from the site's own configuration, then hands the request to it. Each site therefore has its own cookie secret, CSRF key, caches, admin token and public URL; nothing global changes. Running apps sit in a least-recently-used set (`OPEND_FLEET_MAX_SITES`, default 200). A site whose settings change, or that is suspended, is closed and rebuilt on its next request. Pools are small (three connections, closed after ten idle seconds), and one PDF renderer is shared.
- **Notifications stay within a site.** NOTIFY is database-wide, so `notify()` adds the schema to the channel name for schemas other than `public`, and `listen()` listens on the matching names. Listeners on one database share one connection per process. The `public` schema, which is every single-site deployment, keeps the plain names.
- **Worker.** One fleet worker runs every site's build jobs:
  - it wakes on a site's job notification, and also sweeps all sites (one query per hundred schemas) for queued, retried or stale jobs;
  - at most one job per site runs at a time, and `OPEND_FLEET_WORKER_CONCURRENCY` overall, so one busy site cannot hold up the rest;
  - analytics retention runs per site;
  - polling for pushes is off. Hosted sites get pushes through the provider's broker.
- **Admin API** on the fleet's own host (`OPEND_FLEET_HOST`, bearer `OPEND_FLEET_TOKEN`), for the control plane:
  - `POST /fleet/api/sites` checks that the settings make a valid configuration, creates and migrates the schema, and rolls back on failure;
  - `GET`, `PATCH` and `DELETE /fleet/api/sites/:slug`;
  - `POST /fleet/api/sites/:slug/suspend` and `/resume`;
  - delete removes the schema and the site's blobs;
  - settings values are never returned;
  - `PUT`, `GET` and `DELETE /fleet/api/forwards/:host` manage **forwards**: hosts the fleet answers for by proxying to another server (a dedicated deployment's own address). A provider's wildcard domain belongs to the fleet, so this is how a dedicated deployment gets a name under it until it has a domain of its own. Requests pass unchanged apart from `Host` and the `X-Forwarded-*` headers, and redirects to the upstream are rewritten to the public host.
- **Moving a site out.** `GET /admin/api/export` and `POST /admin/api/import`, on the site itself with its admin token, carry everything not rebuilt from Git to a dedicated deployment. Sealed secrets move as they are, so the target keeps the site's `SESSION_SECRET` / `OPEND_SECRET_KEY`.

## Consequences

Good:

- **Isolation by structure, not by query discipline.** A site's connections can only see its schema, and its apps are separate objects with separate secrets. The leak markers run through the fleet router in its tests, alongside sessions, admin tokens and API keys from one site being refused on another.
- **No changes to the single-site code paths** beyond the channel suffix and a per-schema migration lock. Upgrades migrate each schema the same way a single deployment migrates its database: `opend-server fleet migrate`, run before each deploy, migrates the registry and every site.
- **A site moves to dedicated hosting** with an export, an import and a rebuild.

Bad:

- **One process serves many sites,** so a crash or a memory-hungry site affects its neighbours. The fleet is for small plans; larger customers get dedicated deployments.
- **Connections grow with active sites.** Pools are small and close when idle, but a busy fleet needs Postgres `max_connections` sized for it, or a pooler.
- **Per-plan limits** (topics, builds per day, storage) are not enforced yet. They belong in the fleet worker and the site settings.
- **The first request after a site starts or restarts is slower,** because the app is built then.
