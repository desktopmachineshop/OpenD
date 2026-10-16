# Self-hosting OpenD

This guide runs OpenD on your own server with Docker Compose. It covers installing, connecting GitHub and single sign-on, putting OpenD behind TLS, backups, upgrades, hardening and troubleshooting. For how the parts fit together, see [ADR 0004](adr/0004-hosted-architecture.md).

## What you need

- A Linux host with Docker Engine 24 or newer and the Docker Compose v2 plugin. 2 vCPUs and 4 GB of memory are enough for most docs sites. Builds are the heaviest work.
- Node.js 22.12 or newer, to run the setup script. The services themselves run in Docker.
- A DNS name for readers, such as `docs.example.com`, unless you are only evaluating on `localhost`.
- Outbound HTTPS to GitHub (or your GitHub Enterprise Server) and to your identity provider.
- Inbound HTTPS from GitHub for push webhooks. If GitHub cannot reach your server, use [polling mode](#behind-a-firewall-polling-mode).

The stack is three services and Postgres:

| Service   | Role                                                                                     |
| --------- | ---------------------------------------------------------------------------------------- |
| `app`     | Serves readers, the GitHub and entitlement webhooks, and the admin API, on port 3000     |
| `worker`  | Builds pushed commits, and polls repos when `POLL_INTERVAL_SECONDS` is set               |
| `migrate` | Applies database migrations, then exits. `app` and `worker` start only after it succeeds |
| `db`      | Postgres 16, in the `pgdata` volume. Images and themes live in the `blobs` volume        |

## Install

```sh
git clone https://github.com/desktopmachineshop/OpenD.git /srv/opend
cd /srv/opend
node deploy/setup.mjs
```

The script asks a few questions, then:

1. Checks for Node, Docker, Docker Compose and a running Docker daemon.
2. Writes `deploy/.env` with mode 600. It generates `SESSION_SECRET`, `OPEND_ADMIN_TOKEN`, `POSTGRES_PASSWORD` and `GITHUB_WEBHOOK_SECRET`, and `OPEND_EMBED_SECRET` if you give origins for embedded help. It never changes a value that is already set, so you can run it again at any time to fill in what is missing.
3. Creates a GitHub App, if you agree (see [Connect GitHub](#connect-github)).
4. Writes `deploy/seed/seed.yaml` with your first customer org, a reader and your docs repo.
5. Runs `docker compose up -d --build`. Migrations run as part of `up`. The script then waits for `/healthz` and loads the seed.

Pass `--no-start` to write the files only. The script then prints the two commands to run. Run `node deploy/setup.mjs --help` to list the flags for unattended installs, such as `--non-interactive`, `--public-url`, `--github-org` and `--org-slug`.

To install by hand instead, copy `deploy/.env.example` to `deploy/.env`, fill it in, and follow the commands in the [README](../README.md#hosting).

**Check that it works.** The admin API uses the token from `deploy/.env`. The script never prints it.

```sh
set -a; . deploy/.env; set +a
curl -s http://localhost:3000/healthz                       # {"status":"ok"}
curl -s -H "Authorization: Bearer $OPEND_ADMIN_TOKEN" http://localhost:3000/admin/api/orgs
```

Push a commit to a release branch of your docs repo. It shows up in `GET /admin/api/builds`. When the build passes, the commit gets a green `opend/build` status.

## Connect GitHub

The setup script creates the GitHub App through GitHub's App Manifest flow:

1. The script starts a small web server on `localhost` and opens a page. The page posts the app's manifest to GitHub. The manifest sets:
   - a private app;
   - push events, sent to `${PUBLIC_URL}/webhooks/github`;
   - read access to contents and metadata;
   - write access to commit statuses and pull requests.
2. On GitHub, you choose the name and click **Create GitHub App**. GitHub redirects back to the local server with a one-time code.
3. The local server accepts the redirect only if its `state` matches the one it sent. This stops another page from feeding it a code. It then exchanges the code for the app id, private key and webhook secret, and writes them to `deploy/.env`. The private key is stored on one line, with its newlines escaped as `\n`.
4. Install the app on the organization or repositories that hold your docs. The script prints the link. If you entered a docs repo, it also looks up the installation and writes the `installationId` into the seed file.

Some setups need extra flags:

- **An organization's app:** pass `--github-org <org>`. You must be an owner of the organization.
- **GitHub Enterprise Server:** pass `--github-url https://github.example.com`. The API URL defaults to `/api/v3` on the same host; set `--github-api-url` if yours differs. The script also writes `GITHUB_API_URL` for the worker.
- **Setup on a remote host:** the browser must reach the script's callback. Forward a port with `ssh -L 8765:localhost:8765 you@host`, then run the script with `--callback-port 8765`.
- **An existing app:** set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` in `deploy/.env` yourself. The script skips app creation when `GITHUB_APP_ID` is set.

Public repositories need no app. A plain repository webhook with `GITHUB_WEBHOOK_SECRET` works for those, but builds then report no commit status.

### Behind a firewall: polling mode

If GitHub cannot reach your server, set `POLL_INTERVAL_SECONDS=60` in `deploy/.env` and restart the worker with `docker compose -f deploy/docker-compose.yml up -d worker`. The worker then lists each repo's branches and tags with `git ls-remote`, using the installation token for private repos. It queues a build for each release ref whose head commit has not been built yet. The setup script turns this on when `PUBLIC_URL` is a private address, and creates the app with its webhook inactive.

## Connect single sign-on

Readers sign in with OpenID Connect (authorization code with PKCE). In your identity provider:

1. Create a web application, also called a confidential client.
2. Set the sign-in redirect URI to `${PUBLIC_URL}/auth/callback`, for example `https://docs.example.com/auth/callback`.
3. Allow the scopes `openid email profile`.
4. Put its issuer URL, client id and client secret in `deploy/.env`:

```sh
OIDC_ISSUER=https://login.example.com
OIDC_CLIENT_ID=opend-docs
OIDC_CLIENT_SECRET=...
```

5. Restart the app with `docker compose -f deploy/docker-compose.yml up -d app`.

The issuer is the URL that serves `/.well-known/openid-configuration`:

| Provider         | Issuer                                                  |
| ---------------- | ------------------------------------------------------- |
| Okta             | `https://<your-org>.okta.com` (or a custom auth server) |
| Microsoft Entra  | `https://login.microsoftonline.com/<tenant-id>/v2.0`    |
| Google Workspace | `https://accounts.google.com`                           |
| Keycloak         | `https://<host>/realms/<realm>`                         |
| Auth0            | `https://<tenant>.auth0.com/`                           |

A reader is matched to a sign-in by the email you registered for them. Add readers through the seed file, the admin API or [entitlement sync](../README.md#entitlement-sync). The match needs the provider's ID token to say `email_verified: true`, because an unverified email could belong to anyone. Unknown users are refused. Check your provider's ID token if registered readers are turned away (see [Troubleshooting](#troubleshooting)).

For an evaluation without a provider, set `NODE_ENV=development` and `OPEND_DEV_LOGIN=1`. Then sign in at `/auth/dev` as any seeded reader. The server refuses to start with this in production.

## Reverse proxy and TLS

Run OpenD behind a reverse proxy that terminates TLS. The app trusts `X-Forwarded-*` headers, so it must be reachable only through the proxy.

First, publish the app's port on loopback only. Create `deploy/docker-compose.override.yml`, which Compose reads automatically:

```yaml
services:
  app:
    ports: !override
      - '127.0.0.1:3000:3000'
```

Set `PUBLIC_URL=https://docs.example.com` in `deploy/.env`.

[Caddy](https://caddyserver.com) gets and renews a Let's Encrypt certificate by itself. In `/etc/caddy/Caddyfile`:

```caddyfile
docs.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
```

To run Caddy in Compose instead, add it to the same override file and drop the `ports` entry from `app`:

```yaml
services:
  app:
    ports: !reset []
  caddy:
    image: caddy:2
    ports: ['80:80', '443:443']
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    depends_on: [app]
    restart: unless-stopped
volumes:
  caddy-data:
```

With this layout, the Caddyfile uses `reverse_proxy app:3000`. Any proxy works the same way: nginx, Traefik or a cloud load balancer. Pass the `Host` and `X-Forwarded-Proto` headers through, and allow request bodies up to 25 MB.

## Backup and restore

Back up three things:

- **The database.** It holds repos, builds, releases, orgs, readers and the audit log.
- **The blob store.** It holds images and themes of published releases.
  - With Compose, this is the `blobs` volume.
  - With an S3-compatible bucket, turn on bucket versioning, or copy the bucket with your provider's tools, for example `aws s3 sync s3://<bucket> <backup-dir>`.
- **`deploy/.env`.** It holds secrets: the session secret, the app's private key and the admin token. Keep this backup separate and encrypted.

Nightly backup:

```sh
cd /srv/opend
docker compose -f deploy/docker-compose.yml exec -T db pg_dump -U opend -Fc opend > backup/opend-$(date +%F).dump
docker run --rm -v opend_blobs:/data:ro -v "$PWD/backup":/backup alpine \
  tar czf /backup/blobs-$(date +%F).tgz -C /data .
```

To restore, stop the services that write, restore both parts, then start everything again:

```sh
docker compose -f deploy/docker-compose.yml stop app worker
docker compose -f deploy/docker-compose.yml exec -T db pg_restore -U opend -d opend --clean --if-exists < backup/opend-2026-10-16.dump
docker run --rm -v opend_blobs:/data -v "$PWD/backup":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/blobs-2026-10-16.tgz -C /data'
docker compose -f deploy/docker-compose.yml up -d
```

Blobs are keyed by commit. If they are lost, rebuild each live release with `POST /admin/api/repos/:id/builds` to upload them again.

## Upgrades and rollback

`migrate` runs on every `up`, before `app` and `worker` start. Migrations are additive and recorded in `schema_migrations`, so starting a new version upgrades the schema.

1. Back up first (see [Backup and restore](#backup-and-restore)).
2. Tag the running image so you can return to it, then upgrade:

```sh
docker tag opend:local opend:rollback
git -C /srv/opend pull --ff-only          # or check out a release tag
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs migrate   # lists the migrations applied
```

3. If something is wrong, start the previous image again:

```sh
docker tag opend:rollback opend:local
docker compose -f deploy/docker-compose.yml up -d --no-build
```

Older versions skip migrations they do not know about, and they ignore tables added later. A rollback across additive migrations therefore needs no database change. If release notes mark a migration as not backward-compatible, restore the database backup taken before the upgrade.

To run a published image instead of building, set `image: ghcr.io/<org>/opend:<version>` in the override file. Remove `build`, and pin an exact version tag rather than `latest`, so a restart never upgrades by surprise.

## Hardening checklist

- [ ] TLS everywhere: `PUBLIC_URL` starts with `https://`, a proxy terminates TLS, and the app's port is bound to `127.0.0.1` (see [Reverse proxy and TLS](#reverse-proxy-and-tls)).
- [ ] `NODE_ENV=production`, the image's default, and `OPEND_DEV_LOGIN` unset.
- [ ] Secrets were generated by the setup script, or with `openssl rand -hex 32`. None is left at a placeholder or default. `POSTGRES_PASSWORD` is set.
- [ ] `deploy/.env` is mode 600, owned by the deploy user, and kept out of Git (it is ignored) and out of shared backups.
- [ ] Postgres is not published on a host port. The Compose file does not publish it.
- [ ] The GitHub App is private and installed only on the docs repositories it needs.
- [ ] `OPEND_ADMIN_TOKEN` is only on the hosts that need the admin API. Rotate it by changing it and restarting `app`. Leave it unset to turn the admin API off.
- [ ] `ENTITLEMENT_WEBHOOK_SECRET` is set only if a CRM sends webhooks. The endpoint is off without it. Rotate the secret together with the CRM.
- [ ] `OPEND_EMBED_ORIGINS` lists only your own apps' origins.
- [ ] Backups run nightly, are encrypted, and have been restored at least once.
- [ ] Host security updates are automatic. `docker compose pull db` picks up Postgres 16 patch releases.
- [ ] Logs are collected. Every service writes JSON lines to stdout, and admin changes are kept in `GET /admin/api/audit`.

## Entitlement sync

Customer and licence data can come from billing or a CRM:

- a full snapshot through `PUT /admin/api/entitlements/sync`;
- signed webhooks to `POST /webhooks/entitlements`;
- a nightly pull with `opend-server reconcile`, which reads `ENTITLEMENT_SOURCE_URL`.

The [README](../README.md#entitlement-sync) has the formats and signing scheme. With Compose, schedule the pull from the host's crontab:

```cron
15 3 * * * docker compose -f /srv/opend/deploy/docker-compose.yml --profile reconcile run --rm reconcile >> /var/log/opend-reconcile.log 2>&1
```

Start with `ENTITLEMENT_SYNC_MODE=merge`. Switch to `replace` only once a dry run shows the changes you expect: `docker compose ... run --rm reconcile reconcile --mode replace --dry-run`. In replace mode, readers missing from the export lose access at the next run.

## Troubleshooting

| Symptom                                                       | Check                                                                                                                                                                                                           |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid configuration:` when a service starts                | The message names each variable that is wrong. Fix it in `deploy/.env`, then run `up -d` again.                                                                                                                 |
| `migrate` exits with `password authentication failed`         | The `pgdata` volume keeps the password it was created with. Put the original `POSTGRES_PASSWORD` back. To start over and lose all data, run `docker compose down -v`.                                           |
| Pushes do nothing                                             | In the GitHub App's **Advanced** tab, recent deliveries should be 202. A 401 means `GITHUB_WEBHOOK_SECRET` does not match the app's secret. If GitHub cannot reach you, use polling mode.                       |
| `ignored: ref … does not publish`                             | The branch or tag does not match the repo's `releaseRefs`. Update the repo with `POST /admin/api/repos`.                                                                                                        |
| A build is stuck on `queued`                                  | Check `docker compose logs worker`. `fetching … failed` means the source is wrong or the app is not installed on the repository, or `installationId` is missing or wrong.                                       |
| A build failed                                                | `GET /admin/api/builds/:id` lists the diagnostics. Fix the docs and push again; the previous release stays live meanwhile.                                                                                      |
| Readers get "not registered" after signing in                 | Their email must be registered (`GET /admin/api/readers`), and the ID token must have `email_verified: true`. Some providers, such as Microsoft Entra ID by default, do not send it; check your token's claims. |
| Readers see "no access"                                       | Their org has no entitlements, or `version` points to a release line with nothing published yet (`GET /admin/api/repos/:id/releases`).                                                                          |
| Redirect loop or `redirect_uri mismatch` after sign-in        | `PUBLIC_URL` must match the public scheme and host exactly. The proxy must send `X-Forwarded-Proto: https`.                                                                                                     |
| Setup: `Docker is installed but the daemon is not running`    | Start Docker. Or add your user to the `docker` group and log in again. Or run with `--no-start` and start Compose yourself.                                                                                     |
| Setup: GitHub never redirects back                            | The browser must reach `http://localhost:<port>/callback` on the machine running setup. On a remote host, forward the port (see [Connect GitHub](#connect-github)).                                             |
| Entitlement webhook returns 401 `timestamp outside tolerance` | The CRM's clock is more than five minutes off, or it is replaying an old request. Sign each request when you send it.                                                                                           |
