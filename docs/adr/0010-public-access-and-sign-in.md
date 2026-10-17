# 0010 Public sites, sign-in providers and staff readers

## Status

Accepted.

## Context

Until now every hosted site was private: each page needed a signed-in, registered reader, and the front door for evaluation was the development reader picker. Docs owners also want:

- **Public docs**, readable without an account, while keeping gated content (other products, paid features, other releases) for the readers entitled to it.
- **Sign-in in the docs themselves**: a visible "Sign in" for visitors, the reader's name and "Sign out" when signed in, and a real sign-in page instead of a redirect or a picker.
- **GitHub sign-in**, because the people who own and write the docs live on GitHub, and the web editor already signs developers in with the same GitHub App.
- **A full view for the owner's team**, as the previewer's staff view, on the live site.
- **"Edit this page"**, from a page to its source in the web editor.

The invariants from ADR 0003 and 0004 stand: filtering fails closed, hidden topics are indistinguishable from missing ones, pages are cached per entitlement set with per-request parts injected through markers, and nothing in the docs repository may widen who sees what.

## Decision

**Access mode per repository, operator-controlled.** Migration `006_access` adds `repos.access` (`private` | `public`, default `private`) and `repos.public_entitlements` (`{products, features, version}` or null). They change only through `PUT /admin/api/repos/:id/access` or a seed file, never through the docs repository, and re-registering a repository does not reset them. Every change is audited (`repo.access`).

**Who sees what** (`audienceFor` in `packages/server/src/access.ts`):

| Viewer                               | private site              | public site                                                          |
| ------------------------------------ | ------------------------- | -------------------------------------------------------------------- |
| anonymous                            | redirect to `/auth/login` | the public entitlements                                              |
| reader with entitlements             | their own                 | their own ∪ public, when both are on the same release line; else own |
| reader whose org has no entitlements | "No access yet"           | the public entitlements                                              |
| staff reader                         | unfiltered staff view     | unfiltered staff view                                                |

- **Union, not "own only".** Signing in should never hide something a visitor could read anonymously, so a signed-in reader gets their entitlements together with the public set. It is safe because everything in the public set is, by definition, shown to everybody; a reader gains nothing they could not see by signing out.
- **Only on the same release line.** The public set names one version, so it opens one release line. A reader on another line keeps exactly their own entitlements. Otherwise a public "2.x widget" set would open widget content of the 1.x line that the operator never made public.
- **Fail-closed without a public set.** A public site without public entitlements uses `NOTHING_GATED`: no products, no features and an unparseable version, so every product, feature and release condition excludes. Anonymous visitors see only unconditioned content, on the newest live line.

**Cache keys.** Every view, page, publication and PDF is cached under an audience key: a reader's entitlement key (`p=…;f=…;v=…`), `public|<entitlement key>` or `public|none` for anonymous visitors, and `staff`. The spaces cannot collide, so anonymous, reader and staff renders are never shared, even when the entitlement sets happen to be equal. The per-request parts (account controls in the header and the mobile menu, "Edit this page", the feedback form) are markers filled after the cache, from the request's own session. Changing the access mode or the public set calls `setRepoAccess`, which sends the existing `opend_release_changed` notification, so every replica drops its views, pages, publications and site-repo cache at once; generated PDFs are keyed by audience, so a new public set gets new PDFs.

**One resolver for every route.** `viewerRelease` decides the audience for pages, search, `/_assets`, `/_logo`, `/_theme.css`, PDFs and feedback alike. Anonymous page views and searches are recorded with `org_slug` null (the column becomes nullable). Feedback still needs a signed-in reader and a CSRF token. The embedded help panel is unchanged: it trusts only the host's signed token and the reader's own entitlements.

**Sign-in page and account controls.** `/auth/login` lists every configured provider: GitHub, OIDC (named by `OIDC_DISPLAY_NAME`), and, only with `OPEND_DEV_LOGIN` outside production, "Demo readers". With exactly one provider and no demo readers it redirects to it (as OIDC-only installs behaved before). OIDC starts at `/auth/oidc`; its callback stays `/auth/callback`, so registered redirect URIs keep working. `returnTo` is still same-site only (`safeReturnTo`) on every path: the sign-in page, the demo picker and both providers. Signing out is a POST with the session's CSRF token; `GET /auth/logout` only asks, so a link or image cannot sign anyone out. The header shows "Sign in" (anonymous, public sites) or the reader's name and "Sign out", duplicated in the mobile menu panel, all with `--opend-*` tokens and no script.

**GitHub sign-in.** The OAuth web flow with a random `state` and PKCE (`S256`, which GitHub supports for OAuth Apps and GitHub Apps), both kept in a signed, `HttpOnly`, ten-minute cookie scoped to `/auth`. The editor's `createGitHubOAuth` gained PKCE and now returns every verified email, primary first, and the editor uses PKCE too. Readers are matched by the same rule as OIDC: an identity already linked wins; otherwise the first verified email belonging to a reader not yet linked to GitHub links them (new table `reader_identities`, so a reader can have both an OIDC and a GitHub link). Later sign-ins match the GitHub account id, so an email change on GitHub keeps the reader, and another account with the same email cannot take it over. It reuses `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`, the editor's names, so one GitHub App with two callback URLs serves both hosts.

**Collaborator provisioning (off by default).** With `OPEND_GITHUB_COLLABORATOR_ORG`, a GitHub user with write, maintain or admin permission on the site's repository (asked through the App installation) whose verified primary email no reader has yet becomes a reader of that org; `OPEND_GITHUB_COLLABORATOR_STAFF` makes them staff. They can read every source file anyway, so this widens nothing. Existing readers are never moved. Each one is audited (`reader.provision`).

**Staff readers.** `readers.staff` (default false) gives the previewer's staff view: no reader policy, every alternative of a conditional key, conditions marked. Build-time filtering still applies. Only `PUT /admin/api/readers/:id/staff`, `POST /admin/api/readers` with `staff`, and seed files set it. `upsertReader` changes it only when told to, so entitlement sync (which has no such field) can neither grant nor revoke it. The staff view serves the reader's own line, or the newest live line.

**Edit and source links.** With `EDITOR_PUBLIC_URL` on the docs server, signed-in readers get "Edit this page", linking to the editor's existing `/edit?path=<docs-relative file>`; the path is the topic's `file`, which is relative to the docs root as the editor's paths are. `OPEND_SOURCE_LINKS` adds "View source on GitHub" at the built commit for repositories cloned from github.com. Both are built only for the topic being shown, so no hidden topic's path appears anywhere.

## Consequences

- Operators switch a live site with one admin call; no redeploy and no change to the docs repository.
- The audience key is now the cache contract. Anything new that renders reader content must go through `viewerRelease` (or `audienceRelease`) and key its cache by `release.key`.
- Anonymous traffic shares one cached render per page, which makes public sites cheap to serve; analytics count anonymous use without an org.
- A reader linked to GitHub cannot link a second GitHub account; an operator deletes and re-adds the reader to relink. The same holds for OIDC, as before.
- Source links point to files on GitHub that contain every condition's content. That is the operator's choice, documented with the flag: turn it on only for public repositories or audiences allowed to read the source.
