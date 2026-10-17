# 0011 Admin console, stored settings and the GitHub connection

## Status

Accepted.

## Context

Running an OpenD site meant editing environment variables on the host (Railway, Compose) and calling the bearer-token admin API with `curl`. Site owners, who are staff readers, want to run their site from the browser: make it public, pick the docs repository, add readers, set up sign-in, connect GitHub and turn on the editor. Managed hosting adds a second shape: the provider owns one GitHub App for every tenant and hands out tokens, so an instance must work without a GitHub App of its own.

Constraints from earlier decisions stand: pages work without JavaScript under a strict CSP (ADR 0004), per-reader filtering never leaks (ADR 0003, 0010), and secrets never appear in responses or logs.

## Decision

**An admin console at `/admin`, for staff readers only.** Server-rendered pages (Overview, Site & access, Docs source, People, Sign-in, GitHub, Editor) built on the docs stylesheet's header, sidebar and menu and its `--opend-*` tokens. Access needs the docs site's own session cookie (never the embed session, a third-party cookie inside host apps) for a reader with `staff = true`, read fresh from the database on each request so revoking staff takes effect at once. Non-staff get 404; anonymous visitors are sent to sign in. Every change is a POST that checks the Origin and a CSRF token (HMAC of the session cookie under its own label), and is audited as `staff:<email>`. Staff cannot remove their own role, themselves or their organization.

**The first staff reader from a one-time link.** `opend-server admin-link` (or `POST /admin/api/setup-links` with the admin token) mints a random token, stores only its SHA-256, valid 30 minutes by default, and only while no staff reader exists (`--force` overrides on the CLI, for an operator with database access anyway). The visitor enters an email; the token is consumed in the same transaction that creates the reader (in a `staff` org) or promotes an existing one, and they are signed in. The link is the credential, so the email is not verified at that moment; later sign-ins match it as usual.

**Settings in the database, environment variables win.** Migration `007_settings` adds `settings` (key → JSON) and `secrets`. Each group (OIDC, the GitHub App, GitHub sign-in, webhook secret, editor URL, source links) comes from its variables when set, as a whole, else from the console; the console shows env-set groups read-only. Demo readers stay gated by `OPEND_DEV_LOGIN` (never in production); the console can only turn them off. `ctx.config` becomes the effective config, recomputed on change; `ctx.env` keeps the environment alone.

**Secrets sealed at rest.** AES-256-GCM with a random IV and the secret's name as associated data. The key is `OPEND_SECRET_KEY` when set, else HKDF-SHA256 of `SESSION_SECRET` under a distinct label. We chose the derived default so a fresh install needs no new variable; the cost is that rotating `SESSION_SECRET` without `OPEND_SECRET_KEY` makes stored secrets unreadable. That fails visibly: unreadable secrets are listed in a console warning and behave as unset until re-entered. Secrets are never rendered (forms say "set — leave empty to keep it"), never returned (`GET /admin/api/settings` reports only `"set"`), never logged and never in audit details.

**Reload without restart.** Every write sends `opend_settings_changed`. The web service (all replicas), the worker and the editor keep a `SettingsCache`, reload on the notification, and re-read stale snapshots after a minute in case one was missed. OIDC and GitHub OAuth clients are rebuilt only when their own settings change. Settings affect no cached page: the parts they touch (sign-in links, edit links) are per-request markers.

**Connect GitHub with the manifest flow.** The console renders a page whose visible "Continue to GitHub" button posts a manifest (webhook, both sign-in callbacks, the setup URL `/admin/github/installed`, the editor's permissions, private, no OAuth on install) to `…/settings/apps/new` (or an organization's), with the CSP's `form-action` widened to the GitHub host for that page only. The `state` is an HMAC-signed, one-hour token bound to a hash of the staff session cookie. The callback exchanges the code (`POST /app-manifests/{code}/conversions`) and stores app id, slug, client id, client secret, private key and webhook secret. The installation id that GitHub sends to the setup URL could be forged, so it is checked as the app (`GET /app/installations/{id}`) before it is stored. The docs-source picker lists the installation's repositories and re-reads that list on POST rather than trusting the form.

**One access abstraction.** `GitHubAccess` (repository token + REST call + commit status) has three implementations: `GitHubApp` (installation tokens), `GitHubBroker` (managed hosting) and `GitHubConnection`, which picks env app → broker → stored app at call time. The worker and poller ask for `read` tokens, the editor for `write`. Host pinning in `gitAuthArgs` is unchanged.

**Token-broker mode.** The contract is in [managed-github.md](../managed-github.md): `POST {broker}/token` and `GET {broker}/repos` with a per-instance bearer secret, tokens cached until 60 seconds before expiry, 404 for repositories outside the tenant's installation. Broker tokens carry no statuses permission, so builds post no commit status in broker mode. Forwarded webhooks are re-signed with the instance's `GITHUB_WEBHOOK_SECRET`; the handler is unchanged and never uses the payload's installation id. Sign-in uses the existing OIDC support with the control plane as issuer; `OIDC_ICON` (or the display name "GitHub") shows GitHub's mark.

**The editor shares it all.** It reads the same settings and secrets, so one Connect GitHub configures author sign-in and commits. With only `SESSION_SECRET` it derives its cookie key under its own label (never the docs site's key), so the editor service needs `DATABASE_URL`, `SESSION_SECRET`, `EDITOR_PUBLIC_URL` and `PUBLIC_URL`.

## Consequences

- A site can be set up end to end from the browser after one CLI command (or by the provider).
- The bearer-token admin API remains for automation; it changes the same records, plus `GET /admin/api/settings` and `POST /admin/api/setup-links`.
- Database access now implies access to the sealed secrets only together with the key; a database dump alone does not reveal them.
- Adding the editor after Connect GitHub means adding its callback URL to the app on GitHub; the console lists the URLs it needs.
- A future "signed commits as the GitHub user" feature can store per-session user tokens with the same `SecretBox`.
