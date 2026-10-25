# Managed hosting: GitHub through the control plane

In managed hosting, one GitHub App belongs to the hosting provider's control plane (opend-hosted), not to each OpenD instance. The control plane installs it for each tenant, mints installation tokens for the tenant's repositories, signs readers in with GitHub as an OIDC provider, and forwards GitHub's push webhooks. This page is the contract between an OpenD instance and the control plane. The OpenD side is in `packages/worker/src/broker.ts` (`GitHubBroker`), `packages/worker/src/connection.ts` and the admin console; see [ADR 0011](adr/0011-admin-console-and-github-connection.md).

## Instance configuration

Set by the control plane when it provisions a tenant.

| Variable                                                                                        | Services            | Meaning                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `OPEND_GITHUB_BROKER_URL`                                                                       | web, worker, editor | Token broker base URL, e.g. `https://control.example/broker/v1`                                                    |
| `OPEND_GITHUB_BROKER_SECRET`                                                                    | web, worker, editor | This instance's bearer secret for the broker (at least 16 characters)                                              |
| `OPEND_GITHUB_INSTALL_URL`                                                                      | web                 | The shared app's install page for this tenant. Linked **as given**: it may carry a signed `state` already          |
| `GITHUB_WEBHOOK_SECRET`                                                                         | web                 | The secret the control plane re-signs forwarded webhooks with                                                      |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_DISPLAY_NAME=GitHub`               | web                 | Reader sign-in through the control plane's OIDC provider; `GitHub` shows GitHub's mark (or set `OIDC_ICON=github`) |
| `EDITOR_PUBLIC_URL`, `EDITOR_OIDC_ISSUER`, `EDITOR_OIDC_CLIENT_ID`, `EDITOR_OIDC_CLIENT_SECRET` | editor              | Author sign-in through the same issuer. The editor's redirect URI is `https://<editor host>/auth/oidc/callback`    |

`OPEND_GITHUB_BROKER_URL` and `GITHUB_APP_ID` are mutually exclusive: an instance either has its own GitHub App or uses the broker. In broker mode the admin console's manifest flow (Connect GitHub for self-hosters) is hidden and any app stored by it is ignored.

## Token broker

Every request carries `Authorization: Bearer <OPEND_GITHUB_BROKER_SECRET>`.

### `POST {broker}/token`

```json
{ "repo": "owner/name", "permissions": "read" }
```

`permissions` is `"read"` (builds and polling: clone, list refs) or `"write"` (the web editor: commits, branches, pull requests).

| Status | Body                                                      | Meaning                                                    |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------- |
| 200    | `{"token": "ghs_…", "expiresAt": "2026-10-17T10:00:00Z"}` | An installation token scoped to that repository            |
| 404    | any                                                       | The repository is not linked to this tenant's installation |
| 401    | any                                                       | Wrong or revoked instance secret                           |

The instance caches each token per repository and permission until 60 seconds before `expiresAt`, and shares one request between concurrent callers. A 404 fails the build (retried, as other fetch errors) with "not in this site's GitHub installation". Write tokens carry `contents:write`, `pull_requests:write` and `metadata:read`, not commit statuses, so builds in broker mode post **no `opend/build` commit status** (logged once per process).

The instance asks for a token only for repositories whose clone URL is `https://` on github.com (or the `GITHUB_WEB_URL` host), and git sends it only to that host (`gitAuthArgs`), so a repository registered with any other URL never receives one. Tokens go in an HTTP header, never in a URL or a log line.

### `GET {broker}/repos`

```json
{
  "repos": [
    { "fullName": "acme/docs", "private": true, "defaultBranch": "main", "installationId": 123 }
  ]
}
```

The repositories this tenant's installation can access. The admin console's docs-source picker lists them; the instance registers the picked one as `https://github.com/<fullName>.git` and never trusts a repository name or installation id posted by the browser (it re-reads this list).

## Site API: custom domain

Every managed site, whatever its GitHub connection (broker, a console-connected app, or
none), gets `OPEND_HOSTING_URL` (such as `https://control.example/site/v1`) and
`OPEND_HOSTING_TOKEN`, its bearer token there. Without them, a broker URL ending in
`/broker/v1` implies `/site/v1` with the broker secret, which is the same credential.

### `GET {hosting}/domain`, `PUT {hosting}/domain`

The site's custom domain, for the admin console's **Custom domain** page. `PUT` takes
`{"domain": "docs.example.com" | null, "actor": "<staff email>"}`; `actor` is recorded in the
provider's audit log only. Both answer:

```json
{
  "domain": "docs.example.com",
  "status": "awaiting-dns",
  "records": [
    { "type": "CNAME", "name": "docs", "value": "x.up.railway.app", "propagated": false }
  ],
  "checkedAt": "2026-10-25T09:30:00Z",
  "defaultAddress": "https://acme.opend.app",
  "publicUrl": "https://acme.opend.app",
  "available": true,
  "unavailableReason": null,
  "error": null
}
```

`status` is `none`, `attaching`, `awaiting-dns`, `live` or `error`. A refused change answers 400,
409 (taken, under the provider's domain, a job running) or 429 with `{"error": "…"}`, which the
console shows as is; 403 means the site is suspended. The console changes nothing itself:
`PUBLIC_URL` follows on the provider's next sync, once the records have propagated.

## Connect GitHub (managed)

1. The console's **GitHub** page (also at `/admin/integrations`) says "Managed by your hosting provider" and links **Connect GitHub** to `OPEND_GITHUB_INSTALL_URL`, unchanged.
2. After the installation, the control plane redirects the browser to `<PUBLIC_URL>/admin/integrations?github=connected`. The page shows "GitHub connected" and a picker of `GET {broker}/repos`.
3. Picking a repository registers it and queues its first build.

## Webhooks

The control plane receives GitHub's `push` deliveries for the shared app and forwards each to `<PUBLIC_URL>/webhooks/github`:

- the body unchanged (GitHub's JSON),
- `X-Hub-Signature-256` recomputed with the instance's `GITHUB_WEBHOOK_SECRET`,
- `X-GitHub-Event` and `X-GitHub-Delivery` preserved.

The instance verifies the signature in constant time, records the delivery id and the body hash (so a resent delivery or a replayed body does nothing), and queues a build only for a registered repository and release ref. The payload's `installation.id` is ignored: the repository is matched by `repository.full_name` against the instance's own registrations, and tokens come from the broker by repository name.

## Sign-in

Readers and staff sign in with the instance's existing OIDC support against the control plane, which authenticates them with GitHub and returns verified emails. No GitHub OAuth client exists on the instance in managed mode. The web editor uses its `EDITOR_OIDC_*` settings against the same issuer.

**Signed commits.** OIDC sign-in gives the editor no GitHub user access token, so in managed mode the editor commits through broker installation tokens, which GitHub does not sign. On repositories whose branch protection or rulesets require signed commits, authors therefore cannot save or publish; the editor tells them so. A follow-up could let the control plane issue GitHub App user tokens through a token-exchange endpoint (an OIDC session in, a user token for the same person out); it is not part of this contract yet. See [ADR 0012](adr/0012-signed-commits-from-the-editor.md).
