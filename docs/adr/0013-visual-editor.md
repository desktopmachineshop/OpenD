# 0013 Visual editing in the web editor

- Status: accepted
- Date: 2026-10-17

## Context

ADR 0007 shipped the web editor with a DITA source textarea and a live preview. Authors who don't write XML expect an editor like WordPress or Google Docs, where they edit the page as it reads. The editor must still:

- keep the repository as the only content store;
- never lose markup it doesn't understand;
- keep reviewers' diffs small;
- keep per-reader conditions visible and editable;
- work under the editor's CSP (`script-src 'self'`).

## Decision

**ProseMirror, bundled and served by the editor.**

- **Bundle:** `packages/editor/src/visual/` is bundled with esbuild once per process, from the TypeScript sources in development and tests and from the compiled output in the image. It is served as `/assets/visual.js`. There is no CDN and no separate build step, and the CSP is unchanged.
- **Licence:** ProseMirror is MIT-licensed.

**A generic, lossless document model.**

- **Few node types:** the schema has a handful of node types: text block, code, list, item, container, and a raw block and raw inline node. Each node and mark keeps its DITA element name and every XML attribute.
- **Marks:** inline formatting elements (`b`, `codeph`, `uicontrol`, `xref`…) are marks.
- **Raw nodes:** anything else is stored as XML and shown as a locked chip. That covers tables, reused content (`conref`, `conkeyref`), images, key references without text, comments and unknown elements. Its XML can be edited from block settings, and the result is converted back into editor nodes where possible.
- **Mixed content:** text directly inside a container (`<li>Text</li>`) is an implicit text block that is written back without a wrapper.

**Round-trip check before editing.**

- **When a file opens visually:** only if converting it to the editor and back gives the same file byte for byte when unchanged, and the same meaning when every block is regenerated.
- **What "same meaning" ignores:** attribute order, insignificant whitespace and the nesting order of formatting.
- **Otherwise:** the file opens in Source with the reason. Maps and multi-topic files always open in Source.

**Minimal writes.**

- **Splicing:** a small scanner records where the title, short description, body and each body child sit in the source. Saving splices in only the parts whose editor nodes changed, found by node identity.
- **Formatting:** untouched blocks keep their exact text, and new or changed blocks are indented like their neighbours.

**The source textarea stays the form field.** The visual editor writes DITA into it after each change, so preview, diagnostics, save, publish and conflicts are unchanged. Edits made in Source win until the Visual tab reopens them. Without JavaScript, the page is the source editor.

**Conditions are first class.** Block settings edits every filtering attribute OpenD applies (`FILTER_ATTRIBUTES`; a test keeps the lists equal). Conditional blocks are outlined and labelled "Only for …".

## Consequences

- **More authors:** people without DITA or Git knowledge can edit topics, and the round-trip check and minimal writes protect the source.
- **Bundle size:** the editor ships a larger script, about 150 KB minified. It loads only on topic edit pages.
- **Later work:** visual editing of tables, images shown inline and uploads, resolved key text in chips, and a visual map editor.
