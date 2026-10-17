# OpenD: notes for contributors and agents

pnpm workspace, Node 22, TypeScript strict (`tsc -b`, NodeNext), Vitest, ESLint, Prettier (single quotes, width 100). Packages live in `packages/*`; OpenD's own docs are the DITA project in `site/`; `templates/docs-starter` is the customer starter.

## UI and design system

- Every UI follows the OpenD design system: `docs/design-system.md` in the sister `opend-hosted` repository (tokens in `packages/control/src/http/theme.ts` there). Key tokens: emerald accent `#187f65` (dark scheme `#3fbf98`), cool green-grey neutrals (text `#1d2733`, muted `#5a6673`, border `#e1e7e4`; dark surface `#111816`), radii 6/10/16px, soft shadows, the system font stack, light and dark schemes.
- Docs pages (`packages/render-html`, styles in `src/style.ts`) use the `--opend-*` custom properties, never raw colours in rules. Customer themes override those properties, so keep the contract documented in `style.ts` and `site/topics/pdf/pdf-theming.dita`, and derive new tokens from the primary ones.
- No inline scripts or event-handler attributes, and no `style=` attributes in new markup: styles belong in the stylesheet modules. The hosted site's CSP allows no scripts, so pages must work without JavaScript: use `<details>`, forms and links.
- Keyboard operable, visible focus, AA contrast in both schemes, and respect `prefers-reduced-motion`.
- Screenshot UI changes at desktop (1440px) and mobile (390px) widths, light and dark, with Playwright and the preinstalled Chromium (`/opt/pw-browsers/chromium`) against `node packages/cli/dist/bin.js preview site`.

## Per-reader filtering must never leak

A reader only ever sees topics, navtitles, images, search hits and PDFs their entitlements allow. Hidden topics must not appear in the navigation (labels, toggles, headings), links or caches. Pages are cached per entitlement key, and per-request parts are injected through markers. Run the leak tests (`packages/cli/test/leak.test.ts`, `packages/server/test/e2e.test.ts`, the nav tests in `packages/render-html/test/render.test.ts`) after touching rendering, filtering or caching.

## Checks before committing

```sh
pnpm install --frozen-lockfile
npx tsc -b
npx eslint .
npx prettier --check .
node packages/cli/dist/bin.js validate site --strict   # 0 errors, 0 warnings
TEST_DATABASE_URL=postgres://opend@127.0.0.1:55432/opend_test npx vitest run
```

`packages/cli/test/site.test.ts` keeps `site/` in step with the code: a new config field, diagnostic code, environment variable or admin route must be documented in `site/` (and the README) in the same change.
