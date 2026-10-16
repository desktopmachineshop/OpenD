# 0008 Search: Postgres full-text search that cannot leak

- Status: accepted
- Date: 2026-10-16

## Context

Hosted search ran `searchView` in memory: it scanned the text of every topic a reader can see, on every query, for each view. It is safe by construction, because it only ever reads the reader's filtered view. But it does not stem ("installing" misses "install"), has no phrase syntax, and its cost grows with the size of the release.

Postgres is already the content store, and its full-text search gives stemming, weighting, `websearch_to_tsquery` syntax and GIN indexes. The catch is that an index is built once per release, while visibility is decided per reader:

- **Conditions:** DITAVAL-style product, feature, audience and release attributes, combined with OR within an attribute and AND across attributes. The conditions of every ancestor apply.
- **Conditional keys** (`opend-choice`): a reader sees the first alternative their filter keeps.
- **Navigation:** a topic is only published to a reader when a topicref they may see points at it.
- **Sections:** a section can be hidden from a reader whose filter still keeps the topic around it.

A naive per-topic index would let hidden words match, rank, or turn up in a snippet. Even a missing snippet would leak: if a search for a hidden word returns a topic, the reader learns that the word is in it.

## Decision

**Index segments, not topics.** After a build, the worker splits every topic into segments with `searchSegments` (`@opend/filter`). A segment is a run of text with one weight and one condition:

- **Weight:** A for the topic title, B for the short description, C for everything else.
- **Condition:** a list of _gates_, one per element on the path from the topic root that has filtering attributes. An `opend-choice` alternative becomes a gate that passes when its own attributes are kept and every earlier alternative's are not. That is how `filterTree` picks the first surviving alternative.

The rows are written in the same transaction that publishes the release (migration `004_search`):

- `search_indexes`: one row per release, with the segmentation `format`.
- `search_conditions`: each distinct gate list, keyed by a hash of it.
- `search_segments`: one weighted `tsvector` per segment.
- `search_topics`: the concatenation of all of a topic's segments, with a GIN index.

All of them cascade from `releases`. No readable text is stored: the text goes to Postgres only as an argument to `to_tsvector`.

**Query in three steps** (`searchRelease` in `@opend/server`):

1. **Visible conditions.** Load the release's conditions and evaluate each against the reader's view, with `ReleaseView.passes` (the view's own policies). Because keys are content hashes, a key means the same thing in every release and survives reindexing.
2. **Candidates.** `search_topics` (GIN) narrows the release to topics that match on any text. For those topics only, the segments behind visible conditions are concatenated, in order, into one `tsvector`. A topic is a candidate only if that vector matches. It is ranked with `ts_rank` on that vector too, so words in hidden segments neither match nor rank. Up to three times the result limit is fetched.
3. **Re-check and quote from the view.** Every candidate goes through the reader's `ReleaseView`. A topic the view does not publish is dropped, which catches hidden topics and topics outside the reader's navigation. For the rest, the filtered topic's own text (`searchText`, the same segmentation applied to the filtered tree) goes back to Postgres. Postgres matches it against the query again, ranks it with `ts_rank` and builds the snippet with `ts_headline`. The title comes from the view.

The candidate step is only an optimisation. Step 3 decides what is returned, its score and its snippet, and step 3 reads only text the reader can see.

- **No text leak:** a disagreement between gates and `filterTree` could not put hidden text in a result. A test checks that the two agree for every reader.
- **No inference:** a hidden topic, or a topic that would match only on a hidden section, is never returned. A returned topic's score depends only on its visible text. A test compares a topic with a hidden section against a twin without it: same score.
- **Possible miss:** a disagreement could at worst drop a result.

**Query syntax.**

- `websearch_to_tsquery('english', …)` handles quoted phrases, `or` and `-word`.
- **Prefix:** when the last term is a bare word (not in an open quote, not negated, and the query has no `or`), it also matches as a prefix, under both the `english` and `simple` configurations, so search-as-you-type finds "installer" from "insta".
- **Partial stems:** a partial word that runs past its stem (such as "configura", whose stem is "configur") does not match until it is complete. Prefixes match stemmed lexemes, and we accept that.

**Fallback.** `searchView` remains:

- **Previewer:** the local previewer (no database) uses it.
- **Unindexed releases:** releases stored before `004_search`, or indexed with a different `format`, use it on the server.

`opend-server reindex [--release <id>]` rebuilds indexes from the stored snapshots, one release per transaction. Bump `SEARCH_INDEX_FORMAT` whenever segmentation changes. Old indexes are then ignored, so search is never wrong in the meantime, and reindexing restores full-text search.

**Response shapes are unchanged:**

- the embed panel (`/embed/search`) and `GET /api/v1/help/search` return `{ topicId, title, snippet, score }` hits;
- `score` is now a `ts_rank` value rather than a match count;
- `handleEmbedRequest` takes precomputed hits, so the previewer and the server share the panel renderer.

## Consequences

- **Cost per search:** three small round trips. Building a visible vector per candidate topic is linear in that topic's segments, and the GIN prefilter keeps the candidate set small. Re-matching step 3 costs at most `3 × limit` filtered topics.
- **Index size:** indexes grow with every stored release, not only live ones. They go away with their release.
- **Site page:** the docs site's search page (`GET /search?q=`, a plain form in the page header, since pages run no script) calls `searchRelease` with a limit of 20 and renders per request, never from the per-entitlement page cache. The previewer's search page uses `searchView`.
- **Language:** the `english` configuration is fixed. Per-project languages need a config field and a `regconfig` column.
- **Phrases across segments:** segment vectors are concatenated with adjacent positions, so a phrase can match across a condition boundary. Step 3 checks the filtered text again, where the hidden segment is absent.
