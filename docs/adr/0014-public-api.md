# 0014 Public API and API keys

- Status: accepted
- Date: 2026-10-18

## Context

Site owners want to read and change their docs from their own tools: support bots, CI jobs, and AI assistants through MCP on managed hosting. The existing interfaces don't fit:

- **Admin API:** one all-powerful token, and no access to content.
- **Help API:** tokens are per reader and signed by a host app.

Whatever we add must keep OpenD's rule that a reader never sees what their entitlements do not allow. Changes must go through the repository's own review rules.

## Decision

**API keys, made by staff.** Keys live in `api_keys` (migration `009_api_keys`):

- **Token:** a key is `opd_<12-char prefix>_<32 random bytes, base64url>`. The prefix finds the row; only a SHA-256 hash of the secret is stored and compared in constant time. The token is shown once, in the console page that created it or in the admin API's 201 response, and never again.
- **Lifecycle:** keys can expire, and revocation is immediate. Last use is recorded at most once a minute.
- **Where to make them:** the console's **API & AI** page and `/admin/api/api-keys`. Both are audited (`api-key.create`, `api-key.revoke`).

**Scopes:**

- `read`: published content;
- `write`: source, validation, saving and pull requests;
- `publish`: merging;
- `builds`: list and start builds.

`publish` implies `write`, and `write` implies `read`. Merging needs `publish` explicitly: a `write` key's `POST /changes/publish` with `merge: true` is refused. `EditorService.publish` gained a `merge: false` option for this.

**Audiences reuse the site's audiences.** Every read goes through `audienceRelease` with an `Audience`, so filtering, caching and search are the same code as the site:

- **staff:** the unfiltered staff view; conditions are labelled in Markdown and HTML, and the key may choose a release line.
- **org:** `readerAudience` of that org's entitlements, on its line only.
- **public:** `publicAudience`, refused on private sites.

The leak test (`MARKERS`) runs over every org key's topics, navigation and search.

**Markdown output.** `renderMarkdown` in `@opend/render-html` follows the HTML renderer's rules through shared `resolveLink` and `resolveImage`. A link to a hidden topic keeps only its authored text, never the target's title. Markdown is the default format, for scripts and language models.

**Writes are the web editor's service.**

- **Author:** each key gets its own editor user (`api-key-<id>@api-keys.opend.invalid`, named "<key name> (API key)"). Its commits are credited to it, on its own working branch, with the same merge-never-rebase, stale-write (`expectSha`), validation and review-rule handling as people in the editor (ADR 0007).
- **Signed commits:** repositories that require signed commits refuse API saves, as they do company-sign-in authors (ADR 0012).
- **No editor host needed:** the docs site builds its own `EditorService` and GitHub client from the connection it already has (stored app, environment app or broker).

**Abuse limits:**

- 300 requests a minute per key (in memory, per replica);
- 50 files and 2 MB per file per change;
- queries capped at 200 characters.

**Described in OpenAPI 3.1** at `/api/v1/openapi.json` (no key needed). A test checks every described route exists.

**AI assistants.** `OPEND_MCP_URL` shows an MCP server address on the API page. Managed hosting runs that server on its control plane, on top of this API (see opend-hosted). Self-hosted sites can use any MCP or OpenAPI client.

## Consequences

- **Integrations without the admin token:** tools can read the docs as a chosen audience, and propose changes reviewers see as ordinary pull requests.
- **Per-replica rate limit:** with several web replicas the effective limit multiplies. A shared limiter can come later if needed.
- **Key editor users are hidden:** the Editor page's author list leaves them out, and the API page shows the keys instead.
