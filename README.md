# OpenD

A docs platform where **"which release applies" and "who may see this" are one rule**. Authors write DITA in a Git repository. The build compiles it into a release snapshot that keeps every element's applicability, and each reader is served only what their release and entitlements allow.

This repository holds:

- **Stage 1:** the shared build and filter core, and a local previewer.
- **Stage 2:** the hosted path. A push fires a GitHub webhook, a worker builds and validates the docs, and signed-in readers get pages filtered by their org's entitlements.

It also renders curated publications (bookmaps) to PDF for each reader, through the same filter, and has a web editor that gives authors without Git a safe route into the same repository. Multi-tenancy comes later and reuses the same packages.

## Quick start

Requires Node 22.12+ and pnpm 10.

```sh
pnpm install
pnpm build

# Check the starter docs the same way CI does
pnpm opend validate templates/docs-starter

# Preview on http://127.0.0.1:4000, rebuilding on save
pnpm opend preview templates/docs-starter              # staff view: everything, conditions marked
pnpm opend preview templates/docs-starter --as v1-basic # as a reader from preview-contexts.yaml
pnpm opend preview templates/docs-starter --product widget,gadget --feature sso --version 2.1

# Write the release snapshot the hosted build would store
pnpm opend build templates/docs-starter --out release.json
```

The preview banner switches between reader contexts and lists any problems. The search box in the page header searches the current reader's pages in memory. `--ref v1` previews a release branch or tag without checking it out.

## Documentation

OpenD's own documentation is an OpenD docs project in [`site/`](site), built and served by the platform itself: getting started, the authoring guide, context-sensitive help, PDF publications, hosting, and references for every diagnostic code, environment variable and admin API route. Preview it after `pnpm build`:

```sh
pnpm opend preview site                     # staff view, conditions marked
pnpm opend preview site --as self-hoster    # or admin, author, developer, managed-customer
pnpm opend validate site --strict
```

`/pdf/admin-guide.pdf` and `/pdf/author-guide.pdf` print the two publications for the current reader. To publish it on an OpenD server, register this repository with `"docsPath": "site"`. `packages/cli/test/site.test.ts` builds it, requires zero problems, renders every page and publication for each preview reader, and fails when a reference topic falls behind the code.

## Look and theming

Pages follow the OpenD design system: system fonts, an emerald accent, light and dark schemes, a sticky sidebar on wide screens and a "Menu" button on narrow ones. Navigation groups are collapsible, with the current page's group open. Everything works without JavaScript, under a CSP that allows no scripts.

A project restyles its site, help panel and PDFs with two optional fields in `opend.config.yaml`:

- `theme`: a stylesheet loaded after the built-in styles. It overrides the `--opend-*` custom properties: `--opend-accent`, `--opend-text`, `--opend-muted`, `--opend-surface`, `--opend-surface-alt`, `--opend-border`, `--opend-warn`, `--opend-danger`, `--opend-info`, `--opend-cond`, `--opend-font` and `--opend-mono`. Link, hover, focus and highlight colours are derived from `--opend-accent`, so setting it alone rebrands the site.
- `logo`: an `.svg`, `.png`, `.jpg`, `.gif` or `.webp` image shown before the site title in the header.

- `pdf`: how publications print. A built-in template (`standard`, `report`, `compact` or `handbook`) and any of its settings to change: page size and orientation, margins, text size, font, cover (`classic`, `banner`, `minimal`, `none`) and cover note, contents, chapter breaks, running header and footer (with `{title}`, `{site}`, `{release}` and `{date}` filled in) and page numbers.

See [Theme the site, the panel and PDFs](site/topics/pdf/pdf-theming.dita) for the full list, and [Choose a PDF template](site/topics/pdf/pdf-templates.dita).

Staff of a hosted site can change the look without touching the repository, on the admin console's **Appearance** page: a colour preset (Default, Ocean, Indigo, Violet, Teal, Rose, Amber, Graphite) or their own accent colours, body and heading fonts, corners, reading width, a forced light or dark scheme and custom CSS, served as `/_site-theme.css` after the repository's theme so it wins; and a PDF template with every setting above plus print CSS, which replaces the repository's `pdf` settings until reset. Changes reach every page and PDF at once, with no rebuild. See [Change the site's look from the admin console](site/topics/hosting/appearance.dita).

## How applicability works

Any map entry, topic or element can carry DITA filtering attributes:

| Attribute                                                       | Values                                   | A reader sees the content when               |
| --------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| `product`                                                       | tokens declared in `opend.config.yaml`   | they hold at least one listed product        |
| `feature`                                                       | tokens declared in `opend.config.yaml`   | they hold at least one listed feature        |
| `release`                                                       | `1.4`, `2`, `2.0..`, `..1.9`, `1.2..1.9` | their version matches at least one range     |
| `audience`, `platform`, `otherprops`, `props`, `deliveryTarget` | declared tokens                          | the build-time DITAVAL does not exclude them |

- Values within one attribute are OR'd. Separate attributes are AND'd. A rule on an ancestor (an element, topic, `topicref` or `topichead`) applies to everything inside it. These are DITAVAL semantics.
- Readers are **fail-closed**: a value they don't hold, an undeclared value or an unparseable range hides the content. `opend validate` reports undeclared values and bad ranges.
- Conditional key definitions work per reader. The first definition the reader's filter keeps wins, as DITA specifies.
- Links to a topic the reader can't see render as plain text and never reveal the target's title. Hidden pages return the same 404 as missing ones.

See [docs/adr/0003-applicability.md](docs/adr/0003-applicability.md) for the details.

## Packages

| Package                                      | What it does                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`@opend/model`](packages/model)             | Shared types and schemas: node tree, project config, reader context, the `CompiledRelease` snapshot |
| [`@opend/filter`](packages/filter)           | **Pure** applicability filter: release ranges, reader and DITAVAL policies, filtered views          |
| [`@opend/dita`](packages/dita)               | DITA subset parser: topics, maps, keyspace, `conref` / `conkeyref` / `keyref`                       |
| [`@opend/build`](packages/build)             | Source tree (working tree or git ref) to `CompiledRelease`, with chunk-usage index                  |
| [`@opend/validate`](packages/validate)       | Every check, shared by CI, the CLI and the previewer                                                |
| [`@opend/render-html`](packages/render-html) | Filtered view to HTML pages and navigation, and a publication to one print HTML document            |
| [`@opend/pdf`](packages/pdf)                 | Prints self-contained HTML to PDF with one reused headless Chromium (`playwright-core`)             |
| [`@opend/cli`](packages/cli)                 | `opend validate`, `opend build`, `opend preview`                                                    |
| [`@opend/store`](packages/store)             | Postgres schema and migrations, build queue, releases, orgs, readers and entitlements; blob store   |
| [`@opend/worker`](packages/worker)           | Fetches a pushed commit, builds, validates, then publishes or reports the failure                   |
| [`@opend/embed`](packages/embed)             | Help widget (`OpenDHelp`, `<opend-help-button>`) and in-frame script for host apps                  |
| [`@opend/server`](packages/server)           | `opend-server`: GitHub webhook, OIDC reader sign-in, filtered delivery, admin API                   |
| [`@opend/editor`](packages/editor)           | Web editor: DITA source editing, live preview, save to a branch and publish through the GitHub App  |

`templates/docs-starter` is the template repository teams start from. It contains sample topics, a map and a bookmap, reusable chunks, a brand theme, preview contexts and a validation workflow.

## Hosting

One image runs every role (`serve`, `worker`, `migrate`, `seed`, `reconcile`, `reindex`, and the optional `editor`), configured only by environment variables. The smallest install is the app, the worker and Postgres. `node deploy/setup.mjs` does all of this for you (see [Self-hosting setup](#self-hosting-setup)). To do it by hand:

```sh
cp deploy/.env.example deploy/.env                 # set SESSION_SECRET, webhook secret, OIDC, admin token
cp deploy/seed/seed.example.yaml deploy/seed/seed.yaml
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml run --rm migrate seed /seed/seed.yaml
```

Then:

1. Point a GitHub webhook (push events, JSON, your secret) at `${PUBLIC_URL}/webhooks/github`.
2. Register `${PUBLIC_URL}/auth/callback` as the redirect URI with your OIDC provider, and/or `${PUBLIC_URL}/auth/github/callback` on your GitHub App for GitHub sign-in.
3. Readers sign in, and each is served the live release for their version's line (1.x or 2.x) through the same filter as the previewer.
4. A push that fails validation never goes live. It shows as a failed `opend/build` status on the commit, and its diagnostics are available from `GET /admin/api/builds/:id`.

Built images and theme files go to a blob store. By default that is a local folder (`BLOB_DIR`), so the app and the worker must share a volume, as they do in the Compose file. Where they cannot, as on Railway, where web and worker are separate services, set `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (plus optional `S3_REGION`, default `auto`, `S3_FORCE_PATH_STYLE=1` for MinIO-style endpoints, and `S3_PREFIX`) on both services to use any S3-compatible bucket. On Railway, add a Bucket and map its variables with reference variables, for example `S3_BUCKET=${{Bucket.BUCKET}}` and `S3_ENDPOINT=${{Bucket.ENDPOINT}}`; see [`deploy/.env.example`](deploy/.env.example).

To try it without an identity provider, set `NODE_ENV=development` and `OPEND_DEV_LOGIN=1` and pick any seeded reader under **Demo readers** on the sign-in page. The server refuses the development login in production.

**Admin console.** Staff readers run the site in the browser at `/admin`: live releases and builds (with **Rebuild now**), site access and public entitlements, the docs repository, orgs and readers, sign-in (OIDC, GitHub, demo readers), **Connect GitHub** and the web editor. It needs no JavaScript, answers 404 to anyone but staff, checks a CSRF token and the Origin on every change, and audits each one as `staff:<email>`. The first staff reader comes from a one-time link: `opend-server admin-link` (or `POST /admin/api/setup-links` with the admin token), valid 30 minutes and only while no staff reader exists. Settings changed there are stored in Postgres (secrets sealed with AES-256-GCM under `OPEND_SECRET_KEY`, or a key derived from `SESSION_SECRET`) and reach web, worker and editor through `NOTIFY` without a restart; any environment variable that is set wins. **Connect GitHub** creates the site's GitHub App through GitHub's manifest flow, installs it and stores it, so builds, private repos, GitHub sign-in and the editor need no GitHub variables. Managed hosting instead gets tokens from the provider's broker (`OPEND_GITHUB_BROKER_URL`, see [docs/managed-github.md](docs/managed-github.md)). See [ADR 0011](docs/adr/0011-admin-console-and-github-connection.md).

| Admin console (staff readers)                                                         |                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/admin`, `/admin/site`, `/admin/source`, `/admin/people`                             | Overview; access; docs repository and builds; orgs and readers                                          |
| `/admin/appearance`                                                                   | Site theme (presets, accent, fonts, corners, width, scheme, custom CSS) and the PDF template            |
| `/admin/sign-in`, `/admin/github` (also `/admin/integrations`), `/admin/editor`       | Sign-in providers; GitHub connection; editor links and authors                                          |
| `/admin/api-keys`                                                                     | Public API keys (create, revoke) and the AI assistant address                                           |
| `/admin/github/connect`, `/admin/github/manifest-callback`, `/admin/github/installed` | Connect GitHub: manifest form, code exchange, installation                                              |
| `/admin/setup?token=`                                                                 | One-time link that makes the first staff reader                                                         |
| `/admin/handoff?token=`                                                               | Sign-in from the managed service's account panel (staff, or the owner made staff); each link works once |

**Public API and AI assistants.** `/api/v1` serves the docs to your own tools: `me`, `versions`, `nav`, `topics` (each as Markdown, HTML or text), `search`, and with the right scopes the docs source, `validate`, `changes` (save to the key's own working branch, publish as one pull request, merge only with `publish`) and `builds`. `GET /api/v1/openapi.json` describes it. Staff create keys (`opd_<prefix>_<secret>`, stored hashed, shown once) on the console's **API & AI** page or with `POST /admin/api/api-keys`; each has scopes (`read`, `write`, `publish`, `builds`), an audience (staff, one org, or public) that filters every answer exactly as the site does, an expiry, and a limit of 300 requests a minute. Changes go through the web editor's service, credited to the key. `OPEND_MCP_URL` (set by managed hosting) shows the managed MCP connector's address on that page: people sign in there and it mints `MCP: <email>` keys for their access. See [ADR 0014](docs/adr/0014-public-api.md) and `site/topics/hosting/api.dita`.

**Public or private sites.** A registered repo is private by default: every page needs a signed-in, registered reader. `PUT /admin/api/repos/:id/access` with `{"access":"public","publicEntitlements":{"products":[...],"features":[],"version":"2.1"}}` also serves anonymous visitors, filtered for that public set (without one they see only unconditioned content). Signed-in readers get their own entitlements together with the public set when both are for the same release line. Anonymous views have their own cache key, search, images, PDFs and the logo follow the same filter, and switching modes clears every replica's caches through `NOTIFY`. See [ADR 0010](docs/adr/0010-public-access-and-sign-in.md).

**Version picker.** `PUT /admin/api/repos/:id/versions` (or **Version picker** on the console's Site & access page, or `versionPicker` in a seed) decides which version readers are served and what the header shows beside the site title: `{"mode":"off"}` (the default: each reader's own version, the release label), `{"mode":"reader"}` (their own version, shown), `{"mode":"fixed","version":"2.1"}` (everyone gets 2.1) or `{"mode":"list","versions":["2.1","2.0"]}` (readers pick one, or their own, from a no-script `<details>` menu). Only the version changes: products and features still come from the reader's entitlements. The choice is an `opend_version` cookie set by `/_version?v=&returnTo=`, checked against the picker on every request; pages, search and PDFs follow it, and the help panel and public API keep the reader's own version. See `site/topics/hosting/version-picker.dita`.

**Sign-in.** `/auth/login` is a branded page listing every configured provider: **Sign in with GitHub** (`GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`, the same values as the editor's; state + PKCE; readers matched by a verified email), **Sign in with** your OIDC provider (`OIDC_DISPLAY_NAME`), and demo readers in development. With one provider it goes straight there. Pages show **Sign in** for anonymous visitors of public sites, and the reader's name and **Sign out** (a CSRF-checked form) otherwise, in the header and the mobile menu. `OPEND_GITHUB_COLLABORATOR_ORG` (with `OPEND_GITHUB_COLLABORATOR_STAFF=1`) adds people who can push to the docs repo as readers on first GitHub sign-in.

**Staff and edit links.** A staff reader (`PUT /admin/api/readers/:id/staff`, or `staff: true` in a seed) sees the unfiltered staff view with conditions marked; entitlement sync never sets it. With `EDITOR_PUBLIC_URL` set on the docs site, signed-in readers get **Edit this page** under each topic, opening it in the web editor; `OPEND_SOURCE_LINKS=1` adds **View source on GitHub**. One GitHub App serves the docs site, the editor and the build webhook: see [docs/github-app.md](docs/github-app.md) and `node scripts/github-app-url.mjs <docsUrl> <editorUrl>` for a pre-filled registration link.

| Admin API (`Authorization: Bearer $OPEND_ADMIN_TOKEN`)                                               |                                                                       |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET/POST /admin/api/repos`, `POST /admin/api/repos/:id/builds`                                      | Register docs repos; rebuild a commit                                 |
| `PUT /admin/api/repos/:id/access`                                                                    | Make a site public (with public entitlements) or private              |
| `PUT /admin/api/repos/:id/versions`                                                                  | Set the version picker: off, the reader's own, fixed, or a list       |
| `GET /admin/api/repos/:id/releases`, `GET /admin/api/builds[/:id]`                                   | Live releases; builds and their diagnostics                           |
| `DELETE /admin/api/repos/:id/releases/:line`                                                         | Take a release line off the site (the next build for it puts it back) |
| `GET/POST /admin/api/orgs`, `PUT /admin/api/orgs/:slug/entitlements`, `DELETE /admin/api/orgs/:slug` | Orgs and entitlements                                                 |
| `GET/POST /admin/api/readers`, `DELETE /admin/api/readers/:id`                                       | Readers, matched to OIDC sign-ins by verified email                   |
| `PUT /admin/api/readers/:id/staff`                                                                   | Grant or revoke the unfiltered staff view                             |
| `GET /admin/api/audit`                                                                               | Audit log                                                             |
| `GET /admin/api/settings`, `POST /admin/api/setup-links`                                             | Console settings (never secrets); first-staff setup link              |
| `GET/PUT /admin/api/appearance`                                                                      | Site theme and PDF template (`null` resets either)                    |
| `GET /admin/api/analytics/summary`, `GET /admin/api/analytics/feedback[.csv]`                        | Docs analytics and reader feedback                                    |

See [ADR 0004](docs/adr/0004-hosted-architecture.md) for how it fits together.

**Fleet mode.** `opend-server fleet serve` and `opend-server fleet worker` (with `opend-server fleet migrate` before each deploy) run many small sites from one deployment, for providers' free and trial plans. Each site lives in its own Postgres schema (`search_path` per connection) and runs as its own app, built from its own settings and routed by host name, so sessions, admin tokens, caches and notifications never cross between sites. Sites are created, changed, paused and deleted through the fleet admin API (`/fleet/api/sites` on `OPEND_FLEET_HOST`, bearer `OPEND_FLEET_TOKEN`; settings sealed with `OPEND_FLEET_KEY`), and `/fleet/api/forwards` passes other hosts under the fleet's domain on to dedicated deployments. `GET /admin/api/export` and `POST /admin/api/import` move a site to its own deployment. See [ADR 0015](docs/adr/0015-multi-site-fleet.md) and `site/topics/hosting/fleet.dita`.

**Search.** The worker indexes each release for Postgres full-text search when it publishes it. The docs site's search page (the header search box on every page, `GET /search?q=`), the help panel and `GET /api/v1/help/search` match, rank and quote only what the signed-in reader can see, with stemming, `"quoted phrases"`, `or`, `-word` and prefix matching on the last word. Releases published before the upgrade that added search are searched in memory until you run `opend-server reindex` (all releases) or `opend-server reindex --release <id>`. See [ADR 0008](docs/adr/0008-search.md).

To run on Railway (web, worker, Postgres and a bucket), see [docs/railway.md](docs/railway.md).

## Self-hosting setup

On a machine with Docker and Node 22, run this from a checkout of this repository:

```sh
node deploy/setup.mjs
```

It needs no `pnpm install`. It:

1. Checks for Node 22.12+, Docker, Docker Compose and a running Docker daemon.
2. Writes `deploy/.env` (mode 600) with generated secrets: `SESSION_SECRET`, `OPEND_ADMIN_TOKEN`, `POSTGRES_PASSWORD` and `GITHUB_WEBHOOK_SECRET`, plus `OPEND_EMBED_SECRET` when you give embed origins. It never changes a value that is already set, so running it again is safe.
3. Creates a private GitHub App through GitHub's [App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). The app gets push events, read access to contents and write access to commit statuses, and its webhook points at `${PUBLIC_URL}/webhooks/github`. You confirm the app on GitHub, which redirects back to a local callback. The callback checks a one-time `state`, then stores the app id, private key and webhook secret in `deploy/.env`. Setup then prints the app's installation link. For GitHub Enterprise Server, pass `--github-url https://github.example.com`.
4. Writes `deploy/seed/seed.yaml` with your first org, reader and docs repo.
5. Starts Compose, which runs migrations on start. It waits for `/healthz`, then loads the seed. With `--no-start`, it prints the commands instead.

For scripted installs, run `node deploy/setup.mjs --non-interactive --public-url https://docs.example.com --github-app --github-org acme --org-slug acme --reader-email ann@acme.example --repo acme/docs`. Run `--help` to list every flag. Even in this mode, a person must click **Create** in a browser to make the GitHub App. If setup runs on a remote host, forward the callback port first with `ssh -L 8765:localhost:8765 host`, then pass `--callback-port 8765`.

[docs/self-hosting.md](docs/self-hosting.md) covers SSO, a reverse proxy with TLS, backups, upgrades, hardening and troubleshooting.

## Polling mode

GitHub cannot reach a server behind a firewall or on `localhost`. For those installs, set `POLL_INTERVAL_SECONDS` to 10 or more. Unset or 0 turns polling off.

With polling on, the `opend-server worker` process runs `git ls-remote` against each registered repo's `sourceUrl` on that interval. For private repos it sends the GitHub App installation token as a header, never in the URL, and only to an `https` source on `github.com` (or the Enterprise host named by `GITHUB_API_URL`). For each branch or tag that matches the repo's `releaseRefs`, it queues a build if no job exists yet for the head sha.

- The `polled_refs` table remembers the last sha seen for each repo and ref. Several worker replicas can poll at once, and each new sha is still queued only once.
- The poller skips any sha that a webhook already queued, so webhooks and polling can run side by side.
- On the first poll, tags are queued before branches. A moving branch such as `main` then gets the newest job, so it wins its release line over an older tag.

When `PUBLIC_URL` is a private address, setup turns polling on (every 60 seconds) and creates the GitHub App with its webhook inactive.

## Docs analytics and feedback

The server counts page views and searches (docs site, help panel and JSON API), and every topic page ends with a "Was this page helpful? Yes / No" form with an optional comment. Rows record the org slug, release line, topic or normalised query, and time: never a reader's email, id or IP address. Recording is one unawaited insert per request, so it never slows or breaks a page.

- `DNT: 1` or `Sec-GPC: 1` skips views and searches. `OPEND_ANALYTICS=0` turns everything off and hides the form.
- The form works without JavaScript, needs a signed-in reader and a CSRF token bound to their session, and only accepts topics the reader can see (anything else is the same 404).
- `GET /admin/api/analytics/summary?days=30` gives top pages, top and zero-result searches and helpfulness per page; `GET /admin/api/analytics/feedback?topic=&days=` lists answers and comments, newest first (`.csv` for a spreadsheet).
- The worker deletes rows older than `OPEND_ANALYTICS_RETENTION_DAYS` (default 180); `opend-server purge-analytics` does it on demand.

See [ADR 0009](docs/adr/0009-analytics.md).

## Entitlement sync

Customer and licence data can come from billing or a CRM, instead of per-org admin API calls. There are three paths, and they share one engine. The engine:

- compares the desired state with the database and applies the difference in one transaction;
- writes one `entitlements.sync` audit entry with created, updated and removed counts;
- sends a `NOTIFY`, so every replica drops its reader cache and a removed reader loses access at once.

| Path                                                                        | Use                                                                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PUT /admin/api/entitlements/sync` (admin token)                            | A full snapshot: `{ orgs: [{ slug, name, entitlements?, readers: [emails] }], mode?, dryRun?, confirmReplace? }` |
| `POST /webhooks/entitlements` (signed with `ENTITLEMENT_WEBHOOK_SECRET`)    | Pushes from a CRM: `{ type: "events", events: [...] }` or `{ type: "snapshot", mode?, orgs }`                    |
| `opend-server reconcile [--from <url>] [--mode merge\|replace] [--dry-run]` | Nightly pull of `ENTITLEMENT_SOURCE_URL` (bearer `ENTITLEMENT_SOURCE_TOKEN`), in `ENTITLEMENT_SYNC_MODE`         |

**Modes:**

- `merge`, the default, only creates and updates.
- `replace` also removes the orgs and readers that the snapshot leaves out. The admin API requires `confirmReplace: true` for it. `reconcile` refuses to replace from an export with no orgs unless you pass `--allow-empty`.
- `dryRun: true`, or `--dry-run`, returns the changes and writes nothing.

**Snapshot fields:**

- Leave out `entitlements` to keep an org's current entitlements. Set it to `null` to revoke them.
- Readers are matched by email, ignoring case. A reader listed under a different org is moved to that org.

**Webhook requests:**

- `X-OpenD-Timestamp` carries the time in Unix seconds. It must be within 5 minutes of the server's clock.
- `X-OpenD-Signature` is `sha256=` followed by the hex HMAC-SHA256 of `<timestamp>.<raw body>`.
- `Idempotency-Key` is required. A repeated key returns `{"status":"duplicate"}` and changes nothing. A delivery that fails validation (422) does not record its key, so the CRM can fix the data and retry with the same key.
- The key is not signed, so each signed request is also applied only once: resending the same timestamp, body and signature returns `{"status":"duplicate"}` whatever its key. To send an identical change again (for example, re-adding a reader you just removed), sign it with a new timestamp.

**Webhook events:**

- `org.upsert` takes `{ org: { slug, name, entitlements?, readers? } }`. With `exactReaders: true`, it also removes the org's readers that it does not list.
- `org.delete` takes `{ slug }`.
- `reader.add` takes `{ org, email, name? }`.
- `reader.remove` takes `{ email }`.

A signed request from a shell:

```sh
body='{"type":"events","events":[{"type":"reader.add","org":"acme","email":"new@acme.example"}]}'
ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$ENTITLEMENT_WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST "$PUBLIC_URL/webhooks/entitlements" -H 'content-type: application/json' \
  -H "X-OpenD-Timestamp: $ts" -H "X-OpenD-Signature: sha256=$sig" -H "Idempotency-Key: crm-123" -d "$body"
```

**Running `reconcile` nightly:**

- **Railway:** add a service from the same image. Set its start command to `node dist/bin.js reconcile` and its cron schedule to, for example, `0 3 * * *` (UTC). Give it the same database and `ENTITLEMENT_*` variables as the other services. Railway cron services must exit when done, and the command does.
- **Compose:** the `reconcile` service is in the `reconcile` profile, so `up` does not start it. Run it from the host's crontab: `0 3 * * * docker compose -f /srv/opend/deploy/docker-compose.yml --profile reconcile run --rm reconcile`.

The web editor is an optional fourth service on its own host: `docker compose -f deploy/docker-compose.yml --profile editor up -d` runs `opend-server editor serve` on port 3001. See [Web editor](#web-editor).

## Embedding help in your app

Host apps can show OpenD help in an in-app panel that opens on the help for the current screen (like OpenV's help sidebar), filtered for the signed-in user.

**1. Tag topics with context keys.** Keys are dot-separated so they fall back to their parents:

```xml
<prolog><resourceid appname="console" appid="settings.sso"/></prolog>
```

**2. Map routes to keys (optional).** Add `help-contexts.yaml` to the docs repo:

```yaml
apps:
  console:
    default: overview
    routes:
      /settings/sso: settings.sso
      /devices/:id/pair: devices.gadget
      /setup/**: setup.install
```

**3. Enable embedding on the server:** `OPEND_EMBED_SECRET` (32+ characters) and `OPEND_EMBED_ORIGINS` (the host apps' origins).

**4. Mint tokens in your backend** for your signed-in user. Use HS256 with the shared secret, a 10-minute maximum lifetime, and the docs URL as audience:

```js
import { SignJWT } from 'jose';
const token = await new SignJWT({ email: user.email, org: user.openDOrg })
  .setProtectedHeader({ alg: 'HS256' })
  .setAudience('https://docs.example.com')
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(new TextEncoder().encode(process.env.OPEND_EMBED_SECRET));
```

**5. Add the widget** to your app:

```html
<script src="https://docs.example.com/embed/opend-help.js"></script>
<opend-help-button></opend-help-button>
<script>
  OpenDHelp.init({
    docsUrl: 'https://docs.example.com',
    app: 'console',
    getToken: () => fetch('/api/opend-token').then((r) => r.text()),
  });
  // On every route change:
  OpenDHelp.setContext({ path: location.pathname }); // or { key: 'settings.sso' }
</script>
```

`OpenDHelp.open()`, `close()` and `toggle()` drive the panel, and `<opend-help-button key="...">` opens a specific context.

**Rendering help yourself.** Apps that render help natively can call `GET /api/v1/help/context?app=console&path=/settings/sso` (also `/topics/<id>` and `/search?q=`) with `Authorization: Bearer <token>`.

**Checking locally.** `opend preview` serves the same panel. Open `/_opend/help-lab` to see what every key and route resolves to for each preview reader, and click through it in the real widget.

See [examples/embed-host](examples/embed-host) for a runnable host app and [ADR 0005](docs/adr/0005-embedded-help.md) for the design.

## PDF publications

A publication is a bookmap listed under `publications` in `opend.config.yaml`. Each reader gets it as a PDF holding only what their release and entitlements allow, through the same filter as the website. For example, a 1.x customer with two products gets only the chapters and paragraphs for those products and that release.

```xml
<bookmap>
  <booktitle><mainbooktitle>Widget Platform Administrator Guide</mainbooktitle></booktitle>
  <chapter href="../topics/install.dita"/>
  <chapter href="../topics/configure-sso.dita" feature="sso"/>
  <chapter href="../topics/audit-log.dita" feature="audit-log" release="2.0.."/>
</bookmap>
```

- **URL:** `/pdf/<map file name>.pdf`, for example `/pdf/admin-guide.pdf`. File names must be unique across publications; `opend validate` reports clashes.
- **Contents:** a cover (title, site, release, date), a linked contents list, then every chapter and topic the reader can see, in map order. Each chapter starts on a new page, and the project theme is applied.
- **Conditions:** chapter conditions apply to everything under the chapter, and topic and element conditions apply as on the site. Topics only the bookmap references are included too. A reader who can see nothing in a publication gets a 404 and no download link.
- **Links:** links between topics in the publication jump within the PDF. Links to other topics go to the docs site when the reader can see them there; otherwise they are plain text. Images are embedded.
- **Previewing:** `opend preview` serves `/pdf/<name>.pdf` for the current "Preview as" reader. `/pdf/<name>.html` serves the print HTML, for checking the layout without a browser. `/_opend/publications` lists each publication and whether the reader sees anything in it.
- **Hosted:** readers see a link for each publication they can see in the page header. A PDF is rendered once per release and entitlement set, then cached in the blob store, so readers with the same entitlements share it. The cover never names an organization.
- **Chromium:** the image includes Debian's Chromium and sets `OPEND_CHROMIUM_PATH`. Outside Docker, install a browser with `pnpm exec playwright-core install chromium` or point `OPEND_CHROMIUM_PATH` at one. Chromium's own sandbox is off by default; `OPEND_CHROMIUM_SANDBOX=1` turns it on where the runtime allows it.

See [ADR 0006](docs/adr/0006-pdf-rendering.md) for why the renderer is Chromium and how it is contained.

## Web editor

The editor gives authors who do not use Git a safe route into the docs repository. Saving and publishing are separate: authors save to their own working branch as often as they like, and publish when ready through one pull request. The repository stays the single source of truth, and push-to-publish stays the only way content goes live.

**What authors do:**

- **Edit** the DITA source of a topic or map in the browser. Each save is checked for well-formed XML first, and OpenD's validation problems are listed next to the source.
- **Preview** while typing: the branch is rebuilt in memory with the unsaved text and shown in the staff view, with conditions marked. **Preview as an org** opens the same page with an org's entitlements through a 30-minute, logged link.
- **Create a topic** from a template (concept, task, reference) and optionally add it to a map.
- **Save:** every save is a commit to the author's branch `editor/<user-id>/<slug>`, with no pull request. Authors who signed in with GitHub (through a GitHub App's credentials) commit as themselves: the editor uses their own GitHub user token and GraphQL `createCommitOnBranch`, so GitHub signs the commit and shows it **Verified**. Other authors' commits are made by the app, with the signed-in person as author and a `Co-authored-by` trailer.
- **Visual editing:** topics open on a **Visual** tab, a ProseMirror editor that edits the page as it reads, with a toolbar for formatting, links, lists, steps, notes, code blocks, images and sections, and block settings for conditions beside the text. The draft preview is a **Preview** tab, so the editor has the page's width; it can be narrowed to one combination of the conditions the content uses (a version, product, feature, audience). Markup it does not edit directly (tables, reused content) is kept verbatim as a locked block. A topic opens visually only when it round-trips exactly, and saving rewrites only the changed blocks. Maps and other files stay on the **Source** tab. See [ADR 0013](docs/adr/0013-visual-editor.md).
- **Signed commits:** when branch protection or a ruleset requires signed commits on the base branch or on `editor/…` branches, only GitHub-signed-in authors can save and publish; others see "This repository requires signed commits. Sign in with GitHub to save and publish." On such repositories `main` is merged into a branch only by GitHub (`update-branch` on its pull request) and conflict resolutions are signed commits on top. User tokens are sealed per session in `editor_github_tokens`, refreshed before they expire and deleted on sign-out. See [ADR 0012](docs/adr/0012-signed-commits-from-the-editor.md).
- **Publish:** opens or updates the branch's pull request. The page shows what the base branch's protection rules or rulesets require (reviews, checks) and what still blocks the merge. When nothing does, the editor squash-merges straight away. If changes are requested, the author keeps editing the same branch.
- **Resolve conflicts:** on every page open and save, `main` is merged into the branch (never rebased). When the same lines changed on both sides, the author sees "your version" and "current version" side by side and keeps one or edits by hand. Deleted files and deleted sections are handed to a developer in the pull request.

**Running it.** The editor is its own service on its own host (`EDITOR_PUBLIC_URL`, never the docs site's host). Editor accounts, sessions and cookies are separate from readers', so a reader session never opens the editor.

```sh
opend-server editor serve                 # or the standalone `opend-editor serve`
opend-server editor add-user writer@example.com --name "Wendy Writer"   # company (OIDC) authors
opend-server editor add-user dev@example.com --github dev-login         # optional for GitHub users
opend-server editor list-users
opend-server editor disable-user writer@example.com
```

| Setting                                                                    |                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EDITOR_PUBLIC_URL`                                                        | The editor's own origin. Register `/auth/github/callback` and `/auth/oidc/callback` under it                                                                                                                                                                      |
| `SESSION_SECRET` or `EDITOR_SESSION_SECRET`                                | The docs site's `SESSION_SECRET` (the editor derives its own cookie key and opens the console's stored secrets with it), or a separate 32+ character key                                                                                                          |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`                                  | Optional when GitHub is connected in the admin console (or `OPEND_GITHUB_BROKER_URL`/`_SECRET` in managed hosting). The App commits and opens pull requests: Contents and Pull requests read and write; Administration, Commit statuses, Checks and Metadata read |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`                     | GitHub sign-in for developers. Anyone with write access to the repository gets in. With a GitHub App's client id (`Iv…`) authors commit as themselves (Verified); an OAuth App's only signs them in                                                               |
| `EDITOR_OIDC_ISSUER`, `EDITOR_OIDC_CLIENT_ID`, `EDITOR_OIDC_CLIENT_SECRET` | Company sign-in for other authors, who must be added with `add-user` (matched by verified email)                                                                                                                                                                  |
| `EDITOR_REPO`, `EDITOR_BASE_BRANCH`                                        | The registered repo to edit (default `OPEND_SITE_REPO`, or the only one) and its base branch (default `main`)                                                                                                                                                     |
| `DATABASE_URL`, `PORT` (default 3001), `GITHUB_API_URL`, `GITHUB_WEB_URL`  | Shared database; GitHub Enterprise Server URLs                                                                                                                                                                                                                    |

With GitHub connected in the admin console, the editor needs only `DATABASE_URL`, `SESSION_SECRET`, `EDITOR_PUBLIC_URL` and `PUBLIC_URL`; authors sign in with the connected app, and company-sign-in authors can be added on the console's **Editor** page. To run it on Railway, add an `editor` service from the same image with the start command `node dist/bin.js editor serve` ([docs/railway.md](docs/railway.md)); one GitHub App provides its sign-in, commits and the build webhook ([docs/github-app.md](docs/github-app.md)). The repository must be registered (seed file or admin API) with its GitHub App `installationId`. See [ADR 0007](docs/adr/0007-web-editor.md) for the design and the open decision on a visual editor.

## Development

```sh
pnpm typecheck   # tsc -b across packages
pnpm lint
pnpm format:check
pnpm test        # vitest, including the end-to-end leak test over the starter template
```

Tests run against TypeScript sources through the `source` export condition, so they need no build step.

The store, worker, server and editor integration tests need Postgres. Set `TEST_DATABASE_URL` (for example `postgres://opend@localhost:5432/opend_test`); each test file creates and drops its own database. Without the variable those tests are skipped locally. In CI a missing variable is an error. The CLI (`pnpm opend`) runs the compiled output, so run `pnpm build` first.

## Decisions

- [0001 TypeScript on Node](docs/adr/0001-typescript.md)
- [0002 A DITA subset, parsed in TypeScript](docs/adr/0002-dita-subset.md)
- [0003 Applicability and fail-closed filtering](docs/adr/0003-applicability.md)
- [0004 Hosted architecture: push to publish](docs/adr/0004-hosted-architecture.md)
- [0005 Embedded, context-aware help](docs/adr/0005-embedded-help.md)
- [0006 PDF publications printed by headless Chromium](docs/adr/0006-pdf-rendering.md)
- [0007 Web editor: save to a branch, publish through a pull request](docs/adr/0007-web-editor.md)
- [0008 Search: Postgres full-text search that cannot leak](docs/adr/0008-search.md)
- [0009 Docs analytics and reader feedback, without tracking readers](docs/adr/0009-analytics.md)
- [0010 Public sites, sign-in providers and staff readers](docs/adr/0010-public-access-and-sign-in.md)
- [0011 Admin console, stored settings and the GitHub connection](docs/adr/0011-admin-console-and-github-connection.md)
- [0012 Signed commits from the web editor](docs/adr/0012-signed-commits-from-the-editor.md)
- [0013 Visual editing in the web editor](docs/adr/0013-visual-editor.md)
- [0014 Public API and API keys](docs/adr/0014-public-api.md)

## Licence

MIT. See [LICENSE](LICENSE).
