# Running OpenD on Railway

One Railway project runs one OpenD instance:

- **web:** readers, the GitHub webhook and the admin API.
- **worker:** builds.
- **Postgres.**
- **A bucket** for images, themes and cached PDFs.

Both app services build from this repository's `deploy/Dockerfile`. Railway has deprecated `railway.json`, so the settings below are applied per service, in the dashboard or through the Railway API.

## Services

| Setting         | web                                                                  | worker                    |
| --------------- | -------------------------------------------------------------------- | ------------------------- |
| Source          | this repository, branch `main`                                       | same                      |
| Dockerfile path | `deploy/Dockerfile`                                                  | same                      |
| Start command   | `node dist/bin.js serve`                                             | `node dist/bin.js worker` |
| Pre-deploy      | `node dist/bin.js migrate`                                           | none                      |
| Healthcheck     | `/healthz` (timeout 120 s)                                           | none                      |
| Restart policy  | on failure, 5 retries                                                | always                    |
| Watch paths     | `packages/**`, `deploy/Dockerfile`, `package.json`, `pnpm-lock.yaml` | same                      |
| Public domain   | yes, port 3000                                                       | no                        |

A start command replaces the image's `ENTRYPOINT`, so always give the full `node dist/bin.js <command>`.

Watch paths keep docs-only commits from redeploying the app. Docs content reaches readers through the build worker, not through a redeploy.

## Variables (both services)

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
S3_BUCKET=${{<bucket>.BUCKET}}
S3_ENDPOINT=${{<bucket>.ENDPOINT}}
S3_ACCESS_KEY_ID=${{<bucket>.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{<bucket>.SECRET_ACCESS_KEY}}
S3_REGION=${{<bucket>.REGION}}
PUBLIC_URL=https://<web domain>
SESSION_SECRET=<openssl rand -hex 32>
OPEND_ADMIN_TOKEN=<openssl rand -hex 32>
GITHUB_WEBHOOK_SECRET=<openssl rand -hex 32>
NODE_ENV=production
```

Add OIDC (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`) and/or GitHub (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, plus `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; see [github-app.md](github-app.md)) for reader sign-in. Add `OPEND_EMBED_SECRET` and `OPEND_EMBED_ORIGINS` to embed help in your apps.

A public demo can instead set `NODE_ENV=development` and `OPEND_DEV_LOGIN=1`, so that visitors pick a sample reader. Never do this with real content.

## Editor service (optional)

The web editor is a third service from the same image, on its own domain:

| Setting        | editor                                               |
| -------------- | ---------------------------------------------------- |
| Source         | this repository, branch `main`, `deploy/Dockerfile`  |
| Start command  | `node dist/bin.js editor serve`                      |
| Pre-deploy     | none (web runs the migrations)                       |
| Healthcheck    | `/healthz`                                           |
| Restart policy | on failure, 5 retries                                |
| Watch paths    | same as web                                          |
| Public domain  | yes, port 3000 (its own Railway domain, never web's) |

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
EDITOR_PUBLIC_URL=https://<editor domain>
EDITOR_SESSION_SECRET=<openssl rand -hex 32, not SESSION_SECRET>
PUBLIC_URL=https://<web domain>
GITHUB_APP_ID=<the App's id>
GITHUB_APP_PRIVATE_KEY=<the App's private key, \n for line breaks>
GITHUB_OAUTH_CLIENT_ID=<the App's client id>
GITHUB_OAUTH_CLIENT_SECRET=<the App's client secret>
NODE_ENV=production
```

Set `EDITOR_PUBLIC_URL` on web too, so signed-in readers get **Edit this page** links. One GitHub App provides reader and author sign-in, the editor's commits and pull requests, and the push webhook: see [github-app.md](github-app.md).

## Public or private

New sites are private. To let anonymous visitors read, with what they may see:

```sh
curl -X PUT "$PUBLIC_URL/admin/api/repos/<id>/access" -H "authorization: Bearer $OPEND_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"access":"public","publicEntitlements":{"products":["core"],"features":[],"version":"0.1"}}'
```

`{"access":"private"}` switches back. Both take effect at once on every replica.

## First run

1. **Wait for web to report healthy.** Its pre-deploy step creates the schema. The worker retries until the schema exists.
2. **Register the docs repository and seed orgs and readers** through the admin API:
   ```sh
   curl -X POST "$PUBLIC_URL/admin/api/repos" -H "authorization: Bearer $OPEND_ADMIN_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"fullName":"acme/docs","sourceUrl":"https://github.com/acme/docs.git","releaseRefs":["main","v*"]}'
   ```
3. **Publish.** Point a GitHub webhook (push events, JSON, `GITHUB_WEBHOOK_SECRET`) at `$PUBLIC_URL/webhooks/github`, or trigger a build directly with `POST /admin/api/repos/<id>/builds {"ref":"main","sha":"<commit>"}`.

## Operations

- **Backups.** Railway backs up the Postgres volume. Also schedule a `pg_dump` to the bucket so a copy lives off the volume.
- **Redeploys.** Postgres has a volume, so changing it causes a short outage; schedule those changes. Web and worker are stateless and can scale out with replicas.
- **Images instead of builds.** Tagged releases are published to `ghcr.io/desktopmachineshop/opend`. A service can deploy an image tag instead of building from the repository.
