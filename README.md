# OpenD

A docs platform where **"which release applies" and "who may see this" are one rule**. Authors write DITA in a Git repository. The build compiles it into a release snapshot that keeps every element's applicability, and each reader is served only what their release and entitlements allow.

This repository holds:

- **Stage 1:** the shared build and filter core, and a local previewer.
- **Stage 2:** the hosted path. A push fires a GitHub webhook, a worker builds and validates the docs, and signed-in readers get pages filtered by their org's entitlements.

It also renders curated publications (bookmaps) to PDF for each reader, through the same filter. The web editor, site-wide search and multi-tenancy come later and reuse the same packages.

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

The preview banner switches between reader contexts and lists any problems. `--ref v1` previews a release branch or tag without checking it out.

## Documentation

OpenD's own documentation is an OpenD docs project in [`site/`](site), built and served by the platform itself: getting started, the authoring guide, context-sensitive help, PDF publications, hosting, and references for every diagnostic code, environment variable and admin API route. Preview it after `pnpm build`:

```sh
pnpm opend preview site                     # staff view, conditions marked
pnpm opend preview site --as self-hoster    # or admin, author, developer, managed-customer
pnpm opend validate site --strict
```

`/pdf/admin-guide.pdf` and `/pdf/author-guide.pdf` print the two publications for the current reader. To publish it on an OpenD server, register this repository with `"docsPath": "site"`. `packages/cli/test/site.test.ts` builds it, requires zero problems, renders every page and publication for each preview reader, and fails when a reference topic falls behind the code.

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

`templates/docs-starter` is the template repository teams start from. It contains sample topics, a map and a bookmap, reusable chunks, a brand theme, preview contexts and a validation workflow.

## Hosting

One image runs every role (`serve`, `worker`, `migrate`, `seed`), configured only by environment variables. The smallest install is the app, the worker and Postgres:

```sh
cp deploy/.env.example deploy/.env                 # set SESSION_SECRET, webhook secret, OIDC, admin token
cp deploy/seed/seed.example.yaml deploy/seed/seed.yaml
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml run --rm migrate seed /seed/seed.yaml
```

Then:

1. Point a GitHub webhook (push events, JSON, your secret) at `${PUBLIC_URL}/webhooks/github`.
2. Register `${PUBLIC_URL}/auth/callback` as the redirect URI with your OIDC provider.
3. Readers sign in, and each is served the live release for their version's line (1.x or 2.x) through the same filter as the previewer.
4. A push that fails validation never goes live. It shows as a failed `opend/build` status on the commit, and its diagnostics are available from `GET /admin/api/builds/:id`.

Built images and theme files go to a blob store. By default that is a local folder (`BLOB_DIR`), so the app and the worker must share a volume, as they do in the Compose file. Where they cannot, as on Railway, where web and worker are separate services, set `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (plus optional `S3_REGION`, default `auto`, `S3_FORCE_PATH_STYLE=1` for MinIO-style endpoints, and `S3_PREFIX`) on both services to use any S3-compatible bucket. On Railway, add a Bucket and map its variables with reference variables, for example `S3_BUCKET=${{Bucket.BUCKET}}` and `S3_ENDPOINT=${{Bucket.ENDPOINT}}`; see [`deploy/.env.example`](deploy/.env.example).

To try it without an identity provider, set `NODE_ENV=development` and `OPEND_DEV_LOGIN=1` and sign in at `/auth/dev` as any seeded reader. The server refuses the development login in production.

| Admin API (`Authorization: Bearer $OPEND_ADMIN_TOKEN`)                                               |                                                     |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `GET/POST /admin/api/repos`, `POST /admin/api/repos/:id/builds`                                      | Register docs repos; rebuild a commit               |
| `GET /admin/api/repos/:id/releases`, `GET /admin/api/builds[/:id]`                                   | Live releases; builds and their diagnostics         |
| `GET/POST /admin/api/orgs`, `PUT /admin/api/orgs/:slug/entitlements`, `DELETE /admin/api/orgs/:slug` | Orgs and entitlements                               |
| `GET/POST /admin/api/readers`, `DELETE /admin/api/readers/:id`                                       | Readers, matched to OIDC sign-ins by verified email |
| `GET /admin/api/audit`                                                                               | Audit log                                           |

See [ADR 0004](docs/adr/0004-hosted-architecture.md) for how it fits together.

To run on Railway (web, worker, Postgres and a bucket), see [docs/railway.md](docs/railway.md).

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

## Development

```sh
pnpm typecheck   # tsc -b across packages
pnpm lint
pnpm format:check
pnpm test        # vitest, including the end-to-end leak test over the starter template
```

Tests run against TypeScript sources through the `source` export condition, so they need no build step.

The store, worker and server integration tests need Postgres. Set `TEST_DATABASE_URL` (for example `postgres://opend@localhost:5432/opend_test`); each test file creates and drops its own database. Without the variable those tests are skipped locally. In CI a missing variable is an error. The CLI (`pnpm opend`) runs the compiled output, so run `pnpm build` first.

## Decisions

- [0001 TypeScript on Node](docs/adr/0001-typescript.md)
- [0002 A DITA subset, parsed in TypeScript](docs/adr/0002-dita-subset.md)
- [0003 Applicability and fail-closed filtering](docs/adr/0003-applicability.md)
- [0004 Hosted architecture: push to publish](docs/adr/0004-hosted-architecture.md)
- [0005 Embedded, context-aware help](docs/adr/0005-embedded-help.md)
- [0006 PDF publications printed by headless Chromium](docs/adr/0006-pdf-rendering.md)

## Licence

MIT. See [LICENSE](LICENSE).
