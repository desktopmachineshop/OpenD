# OpenD

A docs platform where **"which release applies" and "who may see this" are one rule**. Authors write DITA in a Git repository. The build compiles it into a release snapshot that keeps every element's applicability, and each reader is served only what their release and entitlements allow.

This repository holds:

- **Stage 1:** the shared build and filter core, and a local previewer.
- **Stage 2:** the hosted path. A push fires a GitHub webhook, a worker builds and validates the docs, and signed-in readers get pages filtered by their org's entitlements.

The web editor, PDF, search and multi-tenancy come later and reuse the same packages.

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
| [`@opend/render-html`](packages/render-html) | Filtered view to HTML pages and navigation                                                          |
| [`@opend/cli`](packages/cli)                 | `opend validate`, `opend build`, `opend preview`                                                    |
| [`@opend/store`](packages/store)             | Postgres schema and migrations, build queue, releases, orgs, readers and entitlements; blob store   |
| [`@opend/worker`](packages/worker)           | Fetches a pushed commit, builds, validates, then publishes or reports the failure                   |
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

## Licence

MIT. See [LICENSE](LICENSE).
