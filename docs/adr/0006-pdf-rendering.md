# 0006 PDF publications printed by headless Chromium

- Status: accepted
- Date: 2026-10-16

## Context

Customers want curated manuals as PDFs: an administrator guide, a quick start. Each one is a DITA bookmap listed under `publications` in `opend.config.yaml`. The build already compiles publication topics into the release snapshot.

A PDF has to obey the same rule as the website. A V1 customer with two products must get a PDF that holds only those products and that release. The PDF is also downloaded and passed around, so a leak there is worse than on the web.

We needed to decide two things: how a reader's view of a bookmap is built, and what turns it into a PDF.

## Decision

**Publication views in the filter.** `viewPublication(release, file, policies)` in `@opend/filter` builds a `PublicationView` with the same policies as `viewRelease`.

- Navigation and the set of published topics come from the bookmap rather than the site map.
- Chapter, part and topicref conditions apply to everything under them, and each topic root's conditions apply too.
- A topic only the bookmap references is visible exactly when the reader may see it there. Before this change, `viewRelease` never published such topics.
- Both views share one implementation, so the "reachable from the filtered map, and the root passes" rule cannot drift between web and PDF.

**One print HTML renderer.** `renderPublication(view, options)` in `@opend/render-html` turns a publication view into one self-contained HTML document:

- **Content:** a cover, a contents list with links, then every visible topic in map order, rendered by the same `renderTopic` as the site.
- **Links:** a link to a topic in the publication becomes an in-document anchor. Element ids are prefixed per topic so they stay unique. A link to a topic outside the publication points at the docs site if the reader can see that topic there. Otherwise it renders as plain text, as on the web.
- **Images** are inlined as data URIs through an `assets(path)` hook. The hook is only asked for images in topics the reader can see.
- **Styles:** print CSS covers A4 pages, chapter page breaks, and no breaks inside notes, tables or figures. The project theme is inlined after it, so brand rules win.

**Chromium prints it.** `@opend/pdf` drives a headless Chromium through `playwright-core`, pinned to the version the browser tests use.

- **One browser** is launched on first use and reused. It is relaunched if it exits, and at most two documents print at once.
- **PDF options:** `page.pdf` produces A4 output with the title in the header and "n / total" in the footer. It is tagged (`tagged: true`) and has a document outline built from headings (`outline: true`).
- **Isolation:** each document gets a fresh browser context with JavaScript disabled, and every network request is aborted. The HTML has to be self-contained, and authored content cannot make the server fetch URLs.

**Delivery.**

- **Previewer:** `GET /pdf/<name>.pdf` for the current preview reader, and `/pdf/<name>.html` for the print HTML. `/_opend/publications` lists them.
- **Hosted:** `GET /pdf/<name>.pdf` for the signed-in reader. A publication that doesn't exist and one with nothing visible return the same 404.
- **Caching:** generated PDFs are cached in the blob store under `pdf/<releaseId>/<sha256(entitlementKey)>/<name>.pdf`. Readers with the same entitlement set share one render, and a new release gets new keys. One in-flight promise per key stops a process rendering the same PDF twice at once.
- **Shared renders never name an organization.** The cover leaves out the org name in hosted delivery, because readers from different orgs share the file.
- **Links on the site:** pages show a link for each publication the reader can see.

### Alternatives considered

| Option                           | Why not                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Prince**                       | The best CSS paged-media support (`target-counter`, footnotes, leaders). But it is commercial, licensed per server, and closed source. That is a poor fit for an MIT project that people self-host.                                                                                              |
| **WeasyPrint**                   | Open source with good paged-media support, but it adds a Python runtime and its native dependencies (Pango, cairo) to a Node image. Its CSS layout also differs from the browser the site is designed in, so themes would need print-specific fixes.                                             |
| **Paged.js** (in Chromium)       | Polyfills paged-media features in the browser. It still needs Chromium, plus page JavaScript, which we want off for isolation. It is worth revisiting if we need page numbers in the table of contents.                                                                                          |
| **DITA-OT / Apache FOP**         | The DITA-native path. But it needs a JVM and a second rendering of the content with a separate styling language (XSL-FO). That would bypass our filter and renderer, so the "one rule" guarantee would rest on two implementations.                                                              |
| **Chromium via playwright-core** | Chosen. It uses the same HTML and CSS engine as the site, so themes carry over. It is free and open source, already a test dependency, and produces tagged PDFs with outlines. Its weaknesses are limited paged-media CSS (no `target-counter` page numbers in the contents) and the image size. |

## Consequences

- **Image size:** the hosted image installs Debian's `chromium` plus DejaVu and Liberation fonts (a few hundred MB), and sets `OPEND_CHROMIUM_PATH=/usr/bin/chromium`. `playwright-core` downloads no browser of its own. Debian's Chromium is not the exact build Playwright 1.56 was tested with. Printing uses only long-stable CDP calls, but a Debian update that breaks it would show as a 500 on `/pdf`, so the image smoke test should grow a print check.
- **Chromium sandbox:** Chromium runs without its own sandbox (Playwright's default, `--no-sandbox`). Its sandbox needs user namespaces or setuid helpers that Docker's default seccomp profile and an unprivileged user don't allow. Requiring `--cap-add SYS_ADMIN` or a custom seccomp profile would weaken the container more than it protects. Instead:
  - the container runs as the unprivileged `node` user;
  - the HTML comes from the reviewed docs repository, never from readers;
  - scripts are off and every network request is refused.

  Operators who can allow it can set `OPEND_CHROMIUM_SANDBOX=1`.

- **Contents page numbers:** the contents lists entries with links but no page numbers, since Chromium lacks `target-counter`. The PDF outline (bookmarks) gives page-accurate navigation.
- **Header and footer:** they appear on the cover too. Theme `url()` references to files are not resolved, because the document has no base URL. Only images in content are inlined.
- **First request cost:** the first request for a new release and entitlement set prints the PDF, which takes about a second for small manuals. Later requests are blob reads.
- **Tests:** the filter and renderer have unit tests. The stage 1 leak markers run over the admin guide for every preview reader. The `@opend/pdf` and hosted `/pdf` tests run real Chromium when one is installed.
