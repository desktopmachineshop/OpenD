/**
 * Base layout and typography: the OpenD design system (emerald accent, cool
 * neutrals, system fonts, light and dark).
 *
 * Theming contract: brand themes load after this stylesheet and override the
 * `--opend-*` custom properties on `:root` (and anything else they like). The
 * primary tokens are `--opend-accent`, `--opend-text`, `--opend-muted`,
 * `--opend-surface`, `--opend-surface-alt`, `--opend-border`, `--opend-warn`,
 * `--opend-cond`, `--opend-font` and `--opend-mono`. Everything else (link,
 * hover, soft and focus colours, headings, code, notes) is derived from them
 * with `color-mix()`, so a theme that only sets `--opend-accent` restyles the
 * whole site; themes may still set the derived tokens directly. Layout tokens:
 * `--opend-radius`, `--opend-radius-sm`, `--opend-shadow`, `--opend-measure`,
 * `--opend-sidebar-width`, `--opend-header-height` and `--opend-layout-max`.
 *
 * Pages work without scripts: navigation groups and the narrow-screen menu are
 * `<details>` elements, so only CSS reacts to their state.
 */
export const DEFAULT_CSS = `
:root {
  color-scheme: light dark;
  --opend-accent: #187f65;
  --opend-text: #1d2733;
  --opend-muted: #5a6673;
  --opend-surface: #ffffff;
  --opend-surface-alt: #f5f7f6;
  --opend-border: #e1e7e4;
  --opend-warn: #a5520f;
  --opend-danger: #b3261e;
  --opend-info: #2457c5;
  --opend-cond: #6b3fd1;
  --opend-font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --opend-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --opend-on-accent: #ffffff;
  --opend-tint: #000000;
  --opend-radius-sm: 6px;
  --opend-radius: 10px;
  --opend-shadow: 0 1px 2px rgb(16 24 22 / 0.04), 0 8px 24px -12px rgb(16 24 22 / 0.16);
  --opend-measure: 46rem;
  --opend-sidebar-width: 17.5rem;
  --opend-header-height: 3.75rem;
  --opend-layout-max: 90rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --opend-accent: #3fbf98;
    --opend-text: #dfe7e3;
    --opend-muted: #9aa8a2;
    --opend-surface: #111816;
    --opend-surface-alt: #141c19;
    --opend-border: #233029;
    --opend-warn: #f0b46a;
    --opend-danger: #ff9b91;
    --opend-info: #8db0ff;
    --opend-cond: #b9a0ff;
    --opend-on-accent: #04140f;
    --opend-tint: #ffffff;
    --opend-shadow: 0 1px 0 rgb(255 255 255 / 0.02), 0 12px 32px -16px rgb(0 0 0 / 0.7);
  }
}
/* Derived tokens: computed from whatever the theme sets above. */
:root {
  --opend-heading: var(--opend-text);
  --opend-link: color-mix(in srgb, var(--opend-accent) 82%, var(--opend-tint));
  --opend-link-hover: color-mix(in srgb, var(--opend-accent) 64%, var(--opend-tint));
  --opend-accent-soft: color-mix(in srgb, var(--opend-accent) 12%, var(--opend-surface));
  --opend-focus: var(--opend-accent);
  --opend-border-strong: color-mix(in srgb, var(--opend-border) 88%, var(--opend-text));
  --opend-hover: color-mix(in srgb, var(--opend-text) 6%, transparent);
  --opend-code-bg: var(--opend-surface-alt);
}
@media (prefers-color-scheme: dark) {
  :root {
    --opend-link: color-mix(in srgb, var(--opend-accent) 72%, var(--opend-tint));
    --opend-link-hover: color-mix(in srgb, var(--opend-accent) 55%, var(--opend-tint));
    --opend-accent-soft: color-mix(in srgb, var(--opend-accent) 16%, var(--opend-surface));
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-padding-top: calc(var(--opend-header-height) + 1rem); }
body { margin: 0; font: 16px/1.65 var(--opend-font); color: var(--opend-text); background: var(--opend-surface); -webkit-font-smoothing: antialiased; }
a { color: var(--opend-link); text-underline-offset: 0.18em; text-decoration-thickness: 1px; }
a:hover { color: var(--opend-link-hover); text-decoration-thickness: 2px; }
:focus-visible { outline: 3px solid var(--opend-focus); outline-offset: 2px; border-radius: 4px; }
::selection { background: color-mix(in srgb, var(--opend-accent) 28%, transparent); }
.opend-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.opend-skip { position: absolute; left: -999px; top: 8px; z-index: 100; padding: 8px 14px; border-radius: var(--opend-radius-sm); background: var(--opend-surface); color: var(--opend-heading); font-weight: 600; box-shadow: var(--opend-shadow); }
.opend-skip:focus { left: 8px; }
button, input, textarea, select { font: inherit; color: inherit; }

/* Header */
.site-header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; min-height: var(--opend-header-height); padding: 8px max(16px, calc((100% - var(--opend-layout-max)) / 2 + 24px)); background: var(--opend-surface); border-bottom: 1px solid var(--opend-border); }
.site-title { display: inline-flex; align-items: center; gap: 10px; min-width: 0; font-weight: 700; font-size: 17px; letter-spacing: -0.01em; line-height: 1.25; text-decoration: none; color: var(--opend-heading); }
.site-title:hover { color: var(--opend-heading); }
.site-logo { display: block; width: auto; height: 28px; flex: none; }
.site-release { padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 1.6; color: var(--opend-link); background: var(--opend-accent-soft); white-space: nowrap; }
.site-pdfs { margin-left: auto; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 14px; }
.site-pdf { text-decoration: none; font-weight: 500; }
.site-pdf:hover { text-decoration: underline; }
.site-search { margin-left: auto; display: flex; gap: 6px; }
.site-pdfs + .site-search { margin-left: 0; }
.site-search input { font-size: 14px; width: 15em; max-width: 100%; min-height: 36px; padding: 4px 12px; border: 1px solid var(--opend-border-strong); border-radius: 999px; background: var(--opend-surface-alt); }
.site-search input:focus-visible { outline-offset: 0; border-color: var(--opend-accent); border-radius: 999px; }
.site-search button, .opend-feedback button, .opend-user-bar button { min-height: 36px; padding: 4px 14px; border: 1px solid var(--opend-border-strong); border-radius: 999px; background: var(--opend-surface); font-size: 14px; font-weight: 600; cursor: pointer; }
.site-search button:hover, .opend-feedback button:hover, .opend-user-bar button:hover { border-color: var(--opend-accent); color: var(--opend-link); }
.site-search button:focus-visible, .opend-feedback button:focus-visible, .opend-user-bar button:focus-visible { border-radius: 999px; }
.site-menu { display: none; }
.site-menu > summary { display: block; flex: none; list-style: none; cursor: pointer; user-select: none; border-radius: var(--opend-radius); }
.site-menu > summary::-webkit-details-marker { display: none; }
.site-menu > summary:focus-visible { outline: none; }
.site-menu-button { position: relative; z-index: 3; display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 6px 12px 6px 10px; border: 1px solid var(--opend-border-strong); border-radius: var(--opend-radius); background: var(--opend-surface); color: var(--opend-heading); font-size: 15px; font-weight: 600; }
.site-menu > summary:focus-visible .site-menu-button { outline: 3px solid var(--opend-focus); outline-offset: 2px; }
.site-menu > summary:hover .site-menu-button { background: color-mix(in srgb, var(--opend-text) 6%, var(--opend-surface)); }
.site-menu[open] .site-menu-button { background: var(--opend-accent-soft); border-color: var(--opend-accent); color: var(--opend-link); }
.site-menu-icon { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.site-menu-close, .site-menu[open] .site-menu-bars { display: none; }
.site-menu[open] .site-menu-close { display: inline; }
.opend-user-bar { display: flex; flex-wrap: wrap; gap: 4px 12px; justify-content: flex-end; align-items: center; padding: 6px max(16px, calc((100% - var(--opend-layout-max)) / 2 + 24px)); font-size: 14px; color: var(--opend-muted); background: var(--opend-surface-alt); border-bottom: 1px solid var(--opend-border); }
.opend-user-bar form { margin: 0; }
.opend-user-bar button { min-height: 30px; padding: 2px 12px; font-size: 13px; }

/* Layout: sticky header and sidebar on wide screens. */
.layout { display: grid; grid-template-columns: var(--opend-sidebar-width) minmax(0, 1fr); max-width: var(--opend-layout-max); margin: 0 auto; }
.opend-site .site-header { position: sticky; top: 0; z-index: 20; background: color-mix(in srgb, var(--opend-surface) 92%, transparent); backdrop-filter: saturate(1.4) blur(10px); -webkit-backdrop-filter: saturate(1.4) blur(10px); }
.toc { position: sticky; top: var(--opend-header-height); align-self: start; height: calc(100vh - var(--opend-header-height)); overflow-y: auto; overscroll-behavior: contain; padding: 20px 12px 48px 16px; border-right: 1px solid var(--opend-border); font-size: 14.5px; line-height: 1.4; scrollbar-width: thin; }
main { padding: 32px 48px 80px; min-width: 0; }
main > article, main > .opend-feedback { max-width: var(--opend-measure); margin-left: auto; margin-right: auto; }

/* Navigation tree: the sidebar and the menu panel's copy. */
.opend-nav ul { list-style: none; margin: 0; padding: 0; }
.opend-nav ul ul { margin: 2px 0 6px 12px; padding-left: 8px; border-left: 1px solid var(--opend-border); }
.opend-nav li { margin: 1px 0; }
.opend-nav a { display: block; padding: 6px 10px; border-radius: var(--opend-radius-sm); color: var(--opend-text); text-decoration: none; }
.opend-nav a:hover { background: var(--opend-hover); color: var(--opend-heading); }
.opend-nav a[aria-current="page"] { background: var(--opend-accent-soft); color: var(--opend-link); font-weight: 650; box-shadow: inset 3px 0 0 var(--opend-accent); }
.opend-nav details > summary { list-style: none; cursor: pointer; }
.opend-nav details > summary::-webkit-details-marker { display: none; }
.opend-nav .nav-heading { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding: 6px 10px; border-radius: var(--opend-radius-sm); color: var(--opend-heading); font-weight: 650; }
.opend-nav > ul > li:first-child > details > .nav-heading { margin-top: 0; }
.opend-nav .nav-heading:hover { background: var(--opend-hover); }
.opend-nav .nav-heading::after, .opend-nav .nav-toggle::after { content: ''; flex: none; width: 7px; height: 7px; margin-left: auto; border: solid var(--opend-muted); border-width: 0 1.75px 1.75px 0; transform: translateY(-1px) rotate(-45deg); }
.opend-nav details[open] > .nav-heading::after, .opend-nav details[open] > .nav-toggle::after { transform: translateY(-3px) rotate(45deg); }
.nav-group-link { position: relative; }
.nav-group-link > a { padding-right: 40px; }
.opend-nav .nav-toggle { position: absolute; top: 0; right: 0; display: flex; align-items: center; justify-content: center; width: 28px; height: 33px; border-radius: var(--opend-radius-sm); }
.opend-nav .nav-toggle::after { margin: 0; }
.opend-nav .nav-toggle:hover { background: var(--opend-hover); }
.opend-nav .opend-badge { margin-left: 10px; }
@media (prefers-reduced-motion: no-preference) {
  .opend-nav .nav-heading::after, .opend-nav .nav-toggle::after { transition: transform 0.15s ease; }
}

/*
 * Narrow screens: a compact sticky header. Search, the PDF links and the
 * sidebar move into the Menu panel, which overlays the page under the header
 * with its own scroll. Bars above the header (preview banner, user bar)
 * scroll away; the panel is positioned within the header, so it always starts
 * right under it.
 */
@media (max-width: 60rem) {
  :root { --opend-header-height: 3.5rem; }
  .layout { display: block; }
  .toc, .site-header > .site-search, .site-header > .site-pdfs { display: none; }
  .opend-site .site-header { flex-wrap: nowrap; gap: 10px; height: var(--opend-header-height); min-height: 0; padding: 0 12px; background: var(--opend-surface); backdrop-filter: none; -webkit-backdrop-filter: none; }
  .site-menu { display: block; }
  .site-title { flex: 0 1 auto; font-size: 16px; gap: 8px; }
  .site-title > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .site-logo { height: 24px; }
  .site-menu-panel { position: absolute; z-index: 2; top: 100%; left: 0; right: 0; max-height: calc(100vh - var(--opend-header-height)); max-height: calc(100dvh - var(--opend-header-height)); overflow-y: auto; overscroll-behavior: contain; padding: 12px 12px 32px; background: var(--opend-surface); border-top: 1px solid var(--opend-border); border-bottom: 1px solid var(--opend-border-strong); box-shadow: 0 16px 32px -12px rgb(0 0 0 / 0.35); font-size: 15.5px; line-height: 1.4; }
  /* Dims the page under the open panel. */
  .site-menu[open]::after { content: ''; position: fixed; inset: 0; z-index: 1; background: rgb(8 16 13 / 0.45); }
  @media (prefers-color-scheme: dark) { .site-menu[open]::after { background: rgb(0 0 0 / 0.65); } }
  .site-menu-search { display: flex; gap: 8px; margin: 0 0 12px; }
  .site-menu-search input { flex: 1; min-width: 0; min-height: 44px; padding: 6px 14px; border: 1px solid var(--opend-border-strong); border-radius: 999px; background: var(--opend-surface-alt); font-size: 16px; }
  .site-menu-search input:focus-visible { outline-offset: 0; border-color: var(--opend-accent); border-radius: 999px; }
  .site-menu-search button { min-height: 44px; padding: 6px 16px; border: 1px solid var(--opend-border-strong); border-radius: 999px; background: var(--opend-surface); font-weight: 600; cursor: pointer; }
  .site-menu-search button:focus-visible { border-radius: 999px; }
  .opend-nav a, .opend-nav .nav-heading { padding-top: 9px; padding-bottom: 9px; }
  .opend-nav .nav-toggle { width: 44px; height: 39px; }
  .nav-group-link > a { padding-right: 48px; }
  .site-menu-pdfs { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--opend-border); }
  .site-menu-heading { margin: 0 0 4px; padding: 0 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--opend-muted); }
  .site-menu-pdfs ul { list-style: none; margin: 0; padding: 0; }
  .site-menu-pdfs a { display: block; padding: 8px 10px; border-radius: var(--opend-radius-sm); font-size: 14.5px; text-decoration: none; }
  .site-menu-pdfs a:hover { background: var(--opend-hover); }
  main { padding: 20px 16px 56px; }
  h1 { font-size: 28px; }
}
@media (max-width: 30rem) {
  .site-release { display: none; }
}
@media (max-width: 60rem) and (prefers-reduced-motion: no-preference) {
  .site-menu[open] .site-menu-panel { animation: opend-menu-in 0.18s ease-out; }
  .site-menu-icon { transition: transform 0.15s ease; }
}
@keyframes opend-menu-in { from { opacity: 0; transform: translateY(-6px); } }

/* Topic content */
article { max-width: var(--opend-measure); }
h1, h2, h3, h4, h5, h6 { color: var(--opend-heading); line-height: 1.25; letter-spacing: -0.015em; }
h1 { font-size: 32px; font-weight: 750; letter-spacing: -0.025em; margin: 4px 0 12px; }
h2 { font-size: 22px; font-weight: 700; margin: 36px 0 10px; }
h3 { font-size: 18px; font-weight: 650; margin: 28px 0 8px; }
h4, h5, h6 { font-size: 16px; font-weight: 650; margin: 24px 0 6px; }
p, ul, ol, dl, blockquote, figure { margin: 0 0 14px; }
li > p:last-child { margin-bottom: 0; }
dt { font-weight: 650; color: var(--opend-heading); }
dd { margin: 2px 0 12px 20px; }
.shortdesc { font-size: 18px; line-height: 1.55; color: var(--opend-muted); margin-bottom: 24px; }
code, pre, kbd, samp { font-family: var(--opend-mono); font-size: 0.875em; }
:not(pre) > code, kbd { padding: 0.1em 0.35em; border: 1px solid var(--opend-border); border-radius: 5px; background: var(--opend-code-bg); overflow-wrap: break-word; }
kbd { border-bottom-width: 2px; }
pre { background: var(--opend-code-bg); border: 1px solid var(--opend-border); padding: 14px 16px; border-radius: var(--opend-radius); overflow-x: auto; line-height: 1.55; font-size: 14px; tab-size: 2; }
pre code { font-size: inherit; }
blockquote { margin-left: 0; padding-left: 16px; border-left: 3px solid var(--opend-border-strong); color: var(--opend-muted); }
figure { margin-left: 0; margin-right: 0; }
figcaption, caption { font-size: 14px; color: var(--opend-muted); text-align: left; padding: 6px 0; }
.lines { white-space: pre-line; }
hr { border: 0; border-top: 1px solid var(--opend-border); margin: 32px 0; }
.note { --opend-note: var(--opend-info); display: block; border: 1px solid color-mix(in srgb, var(--opend-note) 28%, var(--opend-border)); border-left: 4px solid var(--opend-note); background: color-mix(in srgb, var(--opend-note) 7%, var(--opend-surface)); padding: 12px 16px; margin: 18px 0; border-radius: var(--opend-radius-sm); }
.note-tip, .note-fastpath, .note-important, .note-remember { --opend-note: var(--opend-accent); }
.note-warning, .note-caution, .note-attention, .note-restriction, .note-trouble { --opend-note: var(--opend-warn); }
.note-danger { --opend-note: var(--opend-danger); }
.note > :last-child { margin-bottom: 0; }
.note-label { font-weight: 700; color: color-mix(in srgb, var(--opend-note) 75%, var(--opend-text)); }
.section-label { font-size: 18px; }
.steps, .substeps { padding-left: 1.6em; }
.steps > li, .substeps > li { margin: 10px 0; padding-left: 4px; }
.steps > li::marker { font-weight: 700; color: var(--opend-link); }
.cmd { display: block; }
.uicontrol { font-weight: 600; }
.menucascade-sep { color: var(--opend-muted); }
.table-wrap { overflow-x: auto; margin: 18px 0; border: 1px solid var(--opend-border); border-radius: var(--opend-radius); }
table { border-collapse: collapse; width: 100%; font-size: 15px; line-height: 1.5; }
th, td { border-bottom: 1px solid var(--opend-border); padding: 9px 12px; text-align: left; vertical-align: top; }
th + th, td + td { border-left: 1px solid var(--opend-border); }
tbody tr:last-child > * { border-bottom: 0; }
th { background: var(--opend-surface-alt); color: var(--opend-heading); font-weight: 650; }
.table-wrap > table > caption { padding: 8px 12px; border-bottom: 1px solid var(--opend-border); }
img { max-width: 100%; height: auto; }
.xref-unavailable { color: var(--opend-muted); }
.related-links { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--opend-border); }
.opend-conditional { outline: 1px dashed var(--opend-cond); outline-offset: 2px; }
.opend-conditional::before { content: attr(data-applies); display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 4px; font: 11px/1.6 var(--opend-mono); color: var(--opend-surface); background: var(--opend-cond); }
opend-cond { display: contents; }
.opend-alt-sep { color: var(--opend-cond); }
.opend-badge { font: 11px/1.6 var(--opend-mono); color: var(--opend-cond); }

/* Search results */
.search-summary { color: var(--opend-muted); }
.search-hits { list-style: none; padding: 0; margin: 20px 0 0; }
.search-hits li { margin: 0 0 12px; padding: 12px 16px; border: 1px solid var(--opend-border); border-radius: var(--opend-radius); }
.search-hits li:hover { border-color: var(--opend-border-strong); background: var(--opend-surface-alt); }
.search-hits a { font-weight: 650; font-size: 17px; text-decoration: none; }
.search-hits a:hover { text-decoration: underline; }
.search-snippet { margin: 4px 0 0; color: var(--opend-muted); font-size: 15px; }

/* Page feedback */
.opend-feedback { margin-top: 48px; padding: 16px 20px; border: 1px solid var(--opend-border); border-radius: var(--opend-radius); background: var(--opend-surface-alt); font-size: 15px; }
.opend-feedback form { margin: 0; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.opend-feedback form > span { font-weight: 600; color: var(--opend-heading); margin-right: 4px; }
.opend-feedback details { flex-basis: 100%; }
.opend-feedback summary { cursor: pointer; color: var(--opend-link); width: fit-content; }
.opend-feedback label { display: block; margin-top: 10px; }
.opend-feedback textarea { display: block; width: 100%; max-width: 560px; min-height: 5em; margin: 6px 0 10px; padding: 8px 10px; border: 1px solid var(--opend-border-strong); border-radius: var(--opend-radius-sm); background: var(--opend-surface); }
.opend-feedback-thanks { margin: 0; color: var(--opend-muted); }
`;
