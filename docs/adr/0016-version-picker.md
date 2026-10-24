# 0016 A version picker on the docs site

## Status

Accepted.

## Context

A reader is served the version their organization is entitled to (ADR 0003), and anonymous visitors of a public site the public set's version (ADR 0010). Readers also want to look at another version's docs, for example before upgrading, and docs owners want to decide whether they may: some offer a few versions, some pin the site to one version, some just want readers to see which version they are reading, and some want nothing shown.

## Decision

**One operator-controlled setting per repository.** Migration `011_version_picker` adds `repos.version_picker` (jsonb, default `{"mode":"off"}`), changed only through `PUT /admin/api/repos/:id/versions`, the admin console's Site & access page or a seed file, and audited as `repo.versions`. The modes:

| Mode                         | Version served                                   | Header                                    |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------- |
| `off`                        | the reader's own                                 | the release label, as before              |
| `reader`                     | the reader's own                                 | that version                              |
| `fixed` (`version`)          | `version`, for everyone                          | that version                              |
| `list` (`versions`, 1 to 50) | the reader's choice among `versions` and own one | a menu, newest first, starting on the own |

**Only the version changes.** `audienceFor` takes the chosen version and puts it in place of the context's version; products and features still come from the reader's entitlements, and on a public site the public set follows the chosen version, so the union with it holds on any line. Without a public set, an anonymous visitor on a chosen version sees content gated only by release. Listing a version, or fixing one, is the operator opening that version to every reader of the site; it never opens a product or feature.

**The choice is a request, checked every time.** The picker's links go to `/_version?v=&returnTo=`, which stores the version in an unsigned `opend_version` cookie (any well-formed version) and returns to a same-site path. `versionChoice` honours it only when the current picker offers it to that reader, so a forged cookie, or a version since removed from the list, falls back to the reader's own. Private sites choose nothing for anonymous requests, which are sent to sign in as before.

**Caching is unchanged.** The version is part of the entitlement key, so pages are cached per version; the picker itself depends on the reader's own version and the page's address, so it is injected per request through markers, like the account controls. Changing the picker drops every replica's caches through `NOTIFY`, as an access change does.

**Scope.** Pages, navigation, search, assets, PDFs and feedback follow the version served. The embedded help panel and the public API keep the reader's own version: they answer for a host app or a key, not for someone browsing the site.

## Consequences

- No scripts: the menu is a `<details>` list of links in the header, and a section of the Menu panel on narrow screens.
- A reader who switches to a version where the current page does not exist gets the usual not-found page, with that version's navigation.
