# 0003 Applicability and fail-closed filtering

- Status: accepted
- Date: 2026-10-16

## Context

Existing tools filter by release per build, and handle access per reader in a separate layer, if at all. The core idea of OpenD is that one rule on the content decides both, and that the same rule drives navigation, pages, search and PDF.

## Decision

**One model.** Applicability is expressed with DITA filtering attributes:

- `product` and `feature` are matched against the reader's entitlements.
- `release` is matched against the reader's version, using ranges.
- `audience`, `platform`, `otherprops`, `props` and `deliveryTarget` are for build-time DITAVAL filtering.

Allowed values are declared in `opend.config.yaml`. `release` is not declared there, because its values are ranges.

**DITAVAL semantics.** An element is excluded when, for some filtering attribute, every one of its values is excluded. So values in one attribute are OR'd, separate attributes are AND'd, and an excluded ancestor removes everything inside it. Map entries (`topicref`, `topichead`, `mapref`) take part in the same way.

**Release ranges.** A `release` value is a list of tokens, and content applies when the reader's version matches any of them:

| Token      | Matches                           |
| ---------- | --------------------------------- |
| `1.4`      | any 1.4.x                         |
| `2`        | any 2.x                           |
| `1.2..1.9` | 1.2 up to and including any 1.9.x |
| `2.0..`    | 2.0 and later                     |
| `..1.9`    | up to and including any 1.9.x     |

A leading `v` is allowed.

**One engine.** `@opend/filter` holds two kinds of `FilterPolicy`:

- a policy built from DITAVAL rules, applied at build time;
- a policy built from a reader context, applied at request time.

Both feed `isIncluded`, `filterTree` and `viewRelease`. A `ReleaseView` is the only way to get navigation and topics for a reader, so every output path goes through the same filter. The package does no I/O, so hosted delivery can use it as it is.

**Fail-closed.** For readers, an entitlement value they don't hold excludes the content, and so does an unparseable range or version. An undeclared value therefore hides content instead of showing it, and validation reports it as an error.

**No leaks through links or titles.**

- A topic is published to a reader only when it is reachable through navigation entries they can see, and its own root passes the filter.
- A link to a hidden topic renders as its authored text only, never the target's title.
- A hidden page returns the same 404 as a missing one.
- Navigation titles come from the topic as the reader sees it.

**Cache key.** `entitlementKey(context)` canonicalises products, features and version, so renders can be cached per entitlement set rather than per user or org.

## Consequences

- The previewer's "preview as" is the real filter, not an approximation.
- The leak test in `packages/cli/test/leak.test.ts` renders every page for several readers and checks that conditional phrases appear exactly when they should. New conditional features should extend it.
- Build-time filtering must not resolve conditional key alternatives, because it runs for every reader at once. `filterTree(..., { resolveChoices: false })` handles this.
