# 0001 TypeScript on Node

- Status: accepted
- Date: 2026-10-16

## Context

The platform needs a build and filter core, a local previewer, a delivery service, a worker, and a browser editor. The plan requires the previewer to use the same build and filter code as the hosted pipeline, so that what a developer sees locally matches what readers see.

## Decision

Everything is written in TypeScript on Node 22, in one pnpm workspace with one package per concern.

## Consequences

- The previewer, CLI, delivery service and editor import the same `@opend/filter` and `@opend/build` packages. There is no second implementation to drift.
- The editor frontend can share the model types and run the filter in the browser for draft previews.
- DITA-OT (Java) is not used. See [0002](0002-dita-subset.md).
- PDF rendering will call out to an external renderer (Prince, Paged.js or WeasyPrint) over HTML, which fits a Node service.
