# 0002 A DITA subset, parsed in TypeScript

- Status: accepted
- Date: 2026-10-16

## Context

Authors write DITA, for its mature reuse (`conref`, keys) and standard profiling (DITAVAL). The reference toolchain, DITA-OT, is Java. Running it would mean a second runtime in every image, and it produces static output per filter, while OpenD needs a filterable tree per release.

## Decision

OpenD parses a documented subset of DITA 1.3 itself, with `saxes`, keeping the line and column of every element for diagnostics.

**Supported**

- Topic types: `topic`, `concept`, `task`, `reference`, `glossentry` and `troubleshooting`, plus nested topics and `<dita>` wrappers. The full element list is `SUPPORTED_ELEMENTS` in `packages/dita/src/elements.ts`.
- Maps and bookmaps:
  - Navigation elements: `topicref`, `topichead`, `topicgroup`, `mapref`, `keydef`, `chapter`, `part`, `appendix`, `frontmatter` and `backmatter`.
  - `toc="no"` and `processing-role="resource-only"`.
- Reuse:
  - `conref` and `conkeyref`, in the same file or across files, with cycle detection.
  - `keyref` for variable text, links and images.
  - Key precedence: within a map, document order; a referencing map wins over its submaps.
- Conditional keys: when a key has several conditional definitions, the build keeps all of them, in order, inside an `opend-choice` node. Each reader's filter picks the first one that survives, which is DITA's rule applied per reader.
- Filtering: DITAVAL `prop` rules (`include`, `exclude`, `flag`, `passthrough`) at build time, and reader policies at request time.
- Elements that never ship: `draft-comment` and `required-cleanup` are removed by the build.

**Not supported yet:** DTD processing and `@class` specialisation dispatch (elements are matched by name), `conrefend` ranges, `conaction`, relationship tables, key scopes, branch filtering (`ditavalref`), external or non-DITA `topicref`s, and flagging styles.

- Elements outside the subset render as a plain block and produce an `unsupported-element` warning.
- Unsupported attributes such as `conrefend` produce a warning instead of being silently ignored.

## Consequences

- No Java dependency. The smallest install stays the app plus Postgres.
- Docs that rely on specialisation or on the unsupported features need work, or a later increment, before they publish correctly.
- The subset is enforced by validation, so authors find out in CI and in the previewer rather than after publishing.
