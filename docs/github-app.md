# One GitHub App for OpenD

One GitHub App serves the whole managed install:

- **Reader sign-in** on the docs site (`/auth/github/callback` on the docs host).
- **Author sign-in** in the web editor (`/auth/github/callback` on the editor host).
- **Installation tokens** for the worker (private clones, `opend/build` commit statuses) and the editor (commits, pull requests, branch protection).
- **The push webhook** that starts builds (`/webhooks/github` on the docs host).

A GitHub App accepts up to ten callback URLs, so the docs site and the editor share one client id and secret even though their callbacks differ.

## Settings

| Setting                                                | Value                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| GitHub App name                                        | Any name not yet taken on GitHub (at most 34 characters), e.g. `Acme docs`                    |
| Homepage URL                                           | `https://DOCS_HOST`                                                                           |
| Callback URLs                                          | `https://DOCS_HOST/auth/github/callback` and `https://EDITOR_HOST/auth/github/callback`       |
| Expire user authorization tokens                       | On (the default; OpenD uses the token once, at sign-in)                                       |
| Request user authorization (OAuth) during installation | **Off**                                                                                       |
| Enable Device Flow                                     | Off                                                                                           |
| Setup URL                                              | Empty                                                                                         |
| Webhook                                                | Active. URL `https://DOCS_HOST/webhooks/github`. Secret: the value of `GITHUB_WEBHOOK_SECRET` |
| Repository permissions                                 | Contents: Read and write                                                                      |
|                                                        | Pull requests: Read and write                                                                 |
|                                                        | Administration: Read-only                                                                     |
|                                                        | Commit statuses: Read and write (the editor only reads them; builds report `opend/build`)     |
|                                                        | Checks: Read-only                                                                             |
|                                                        | Metadata: Read-only                                                                           |
| Account permissions                                    | Email addresses: Read-only (readers and authors are matched by verified email)                |
| Subscribe to events                                    | Push                                                                                          |
| Where can this GitHub App be installed?                | Only on this account                                                                          |

Then:

1. **Generate a client secret** and **a private key** on the App's page.
2. **Install** the App on the docs repository, and note the installation id at the end of the installation's URL (`…/settings/installations/<id>`).
3. **Register** (or re-register) the repository with that id: `POST /admin/api/repos` with `"installationId": <id>` (send every field: registering replaces the settings).

Sign-in uses GitHub's OAuth web flow with `state` and PKCE (`S256`). A GitHub App ignores OAuth scopes (OpenD still sends `read:user user:email` for OAuth Apps) and reads email addresses through the **Email addresses** account permission. Only verified addresses are used.

## Pre-filled registration link

GitHub pre-fills the registration form from [URL parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters). The script prints the link for your two hosts:

```sh
node scripts/github-app-url.mjs https://web-production-d2d0f.up.railway.app https://EDITOR_HOST
# optional third argument: the App's name; --org <org> registers it under an organization
```

It sets `name`, `description`, `url`, both `callback_urls[]`, `request_oauth_on_install=false`, `public=false`, `webhook_active=true`, `webhook_url`, `events[]=push`, and the permissions `contents=write`, `pull_requests=write`, `administration=read`, `checks=read`, `statuses=write`, `metadata=read` and `email_addresses=read`.

GitHub does not accept the webhook secret as a parameter: type the value of `GITHUB_WEBHOOK_SECRET` into the form before you press **Create GitHub App**.

## Which service gets which variable

| Variable                                               | web (docs site)                        | worker | editor                   |
| ------------------------------------------------------ | -------------------------------------- | ------ | ------------------------ |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`              | yes                                    | yes    | yes                      |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | yes (reader sign-in)                   | no     | yes (author sign-in)     |
| `GITHUB_WEBHOOK_SECRET`                                | yes                                    | no     | no                       |
| `EDITOR_PUBLIC_URL`                                    | optional (**Edit this page** links)    | no     | required                 |
| `PUBLIC_URL`                                           | required                               | same   | recommended (host check) |
| `OPEND_GITHUB_COLLABORATOR_ORG`, `…_STAFF`             | optional (auto-add repo collaborators) | no     | no                       |
| `OPEND_SOURCE_LINKS`                                   | optional (**View source on GitHub**)   | no     | no                       |

On Railway, web and worker share their variables; the editor is its own service (see [railway.md](railway.md)). The OpenD docs describe the same setup in `site/topics/hosting/github-app.dita`.
