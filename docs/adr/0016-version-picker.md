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

## Addendum: following the live lines, and a `latest` public default

Docs published per minor version (`repos.release_lines`) made the `list` mode a chore: OpenV's release workflow had to rewrite both the list and the public version after every release, and a missed call left the site on the old default.

**`live` mode.** `{"mode":"live"}` offers every live release line of the repo, newest first by version (`0.23` before `0.3`), read from the same cached list of live lines the `list` mode filters with. It has no list: a line appears when its first release goes live and disappears when it is retired, and the line caches drop on both through `NOTIFY`. A requested version is matched by its line (`0.22.1` asks for `0.22`), so a cookie or a help API `version` can only name a line that is live. A reader starts on their own line when it is live and is served their own version there (`VersionChoice.serve`), so release conditions within the line apply to them as with the picker off; on another line, or when their own is not live and they start on the newest, the line's name is their version.

**`latest` public version.** The public set's `version` may be `latest`, accepted only there (`publicEntitlementsSchema`; organizations name real versions). `servedRepo` resolves it per request to the newest live line before anything else reads the repo, so `publicAudience`, `ownVersion`, the union with signed-in readers and the cache keys all see a real version, and a new line changes the anonymous cache key along with the default. With nothing live, the public set is treated as absent. The admin API, seed files and the console return `latest` as stored.

**The help JSON API anonymously.** The help JSON API (ADR 0005) answers requests without an `Authorization` header on a public site with the anonymous public view, at an optional `version` that goes through the same `versionChoice` check as the cookie (the cookie itself is ignored there): anything not offered gets the default, never an error. These answers reveal nothing the public site does not, so they exist with embedding off, carry `Access-Control-Allow-Origin: *` without credentials, and are cached `public, max-age=60` with `Vary: Origin, Authorization`. Token requests are unchanged, and a bad token never falls back to the anonymous view. Every answer names its release in `OpenD-Release` and `OpenD-Release-Line`, exposed to browser callers, so a caller can tell when it was given the default. This makes the earlier scope note narrower: the panel, token requests and the public API keep the reader's own version; only anonymous help API requests follow the picker.
