/** The editor's stylesheet, served as `/assets/editor.css` (the CSP allows no inline styles). */
export const EDITOR_CSS = `
:root { --ed-fg: #1d2733; --ed-muted: #5a6673; --ed-border: #e1e7e4; --ed-accent: #187f65; --ed-on-accent: #ffffff;
  --ed-bg: #ffffff; --ed-soft: #f5f7f6; --ed-warn: #a5520f; --ed-ok: #187f65; --ed-err: #b3261e;
  --ed-radius-sm: 6px; --ed-radius: 10px; --ed-radius-lg: 16px;
  --ed-shadow: 0 1px 2px rgb(16 24 22 / 0.04), 0 8px 24px -12px rgb(16 24 22 / 0.16);
  --ed-font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --ed-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; }
@media (prefers-color-scheme: dark) {
  :root { --ed-fg: #dfe7e3; --ed-muted: #9aa8a2; --ed-border: #233029; --ed-accent: #3fbf98; --ed-on-accent: #04140f;
    --ed-bg: #111816; --ed-soft: #141c19; --ed-warn: #f0b46a; --ed-ok: #3fbf98; --ed-err: #ff9b91;
    --ed-shadow: 0 1px 0 rgb(255 255 255 / 0.02), 0 12px 32px -16px rgb(0 0 0 / 0.7); }
}
/* Derived tokens, from the primary ones above. */
:root { --ed-accent-soft: color-mix(in srgb, var(--ed-accent) 12%, var(--ed-bg));
  --ed-warn-bg: color-mix(in srgb, var(--ed-warn) 12%, var(--ed-bg)); }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 var(--ed-font); color: var(--ed-fg); background: var(--ed-bg); }
a { color: var(--ed-accent); }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, pre:focus-visible {
  outline: 3px solid var(--ed-accent); outline-offset: 2px; }
.ed-skip { position: absolute; left: -9999px; }
.ed-skip:focus { left: 8px; top: 8px; background: var(--ed-bg); padding: 6px 10px; z-index: 10; }
.ed-header { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--ed-border); background: var(--ed-soft); }
.ed-brand { font-weight: 700; text-decoration: none; color: var(--ed-fg); }
.ed-repo { color: var(--ed-muted); font-size: 14px; }
.ed-nav { display: flex; gap: 12px; }
.ed-nav a[aria-current="page"] { font-weight: 700; text-decoration: none; color: var(--ed-fg); }
.ed-user { margin-left: auto; display: flex; gap: 8px; align-items: center; font-size: 14px; }
.ed-user form { margin: 0; }
.ed-link { background: none; border: 0; color: var(--ed-accent); text-decoration: underline; cursor: pointer; font: inherit; padding: 0; }
.ed-main { padding: 16px; max-width: 1600px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 12px; }
h1.ed-file { font-family: var(--ed-mono); font-size: 18px; }
h2 { font-size: 18px; margin: 0 0 8px; }
label { display: block; font-weight: 600; margin-bottom: 4px; }
input[type="radio"] + * { font-weight: normal; }
fieldset label { display: inline-block; font-weight: normal; margin-right: 16px; }
input:not([type="radio"]):not([type="hidden"]), select { font: inherit; padding: 6px 8px; border: 1px solid var(--ed-border); border-radius: var(--ed-radius-sm); background: var(--ed-bg); color: var(--ed-fg); min-width: 16em; }
button, .ed-button { font: inherit; padding: 6px 16px; border-radius: var(--ed-radius-sm); border: 1px solid var(--ed-accent); background: var(--ed-accent); color: var(--ed-on-accent); cursor: pointer; text-decoration: none; display: inline-block; }
button[disabled] { opacity: .5; cursor: not-allowed; }
textarea { width: 100%; font: 13px/1.5 var(--ed-mono); padding: 8px; border: 1px solid var(--ed-border); border-radius: var(--ed-radius-sm); background: var(--ed-bg); color: var(--ed-fg); tab-size: 2; }
#ed-source { min-height: 60vh; resize: vertical; }
.ed-hint { color: var(--ed-muted); font-size: 13px; font-weight: normal; }
.ed-card { border: 1px solid var(--ed-border); border-radius: var(--ed-radius); padding: 12px 16px; margin-bottom: 16px; }
.ed-status { margin-bottom: 16px; }
.ed-alert { background: var(--ed-warn-bg); color: var(--ed-warn); padding: 8px 12px; border-radius: var(--ed-radius-sm); }
.ed-notice { border-left: 4px solid var(--ed-ok); padding: 4px 12px; }
.ed-ok { color: var(--ed-ok); }
.ed-columns { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(320px, 1fr); gap: 24px; }
.ed-workspace { display: grid; grid-template-columns: 220px minmax(320px, 1fr) minmax(320px, 1fr); gap: 16px; align-items: start; }
@media (max-width: 1000px) { .ed-columns, .ed-workspace { grid-template-columns: 1fr; } }
.ed-tree ul { list-style: none; padding-left: 14px; margin: 0; }
.ed-tree > ul { padding-left: 0; }
.ed-tree a { text-decoration: none; }
.ed-tree a[aria-current="page"] { font-weight: 700; }
.ed-dir { color: var(--ed-muted); }
.ed-badge { font-size: 11px; border: 1px solid var(--ed-border); border-radius: 10px; padding: 0 6px; color: var(--ed-muted); }
.ed-preview iframe { width: 100%; height: 75vh; border: 1px solid var(--ed-border); border-radius: var(--ed-radius-sm); background: var(--ed-bg); }
.ed-inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.ed-inline label { display: inline; margin: 0; }
.ed-diags { padding-left: 18px; font-size: 13px; }
.ed-diag.ed-error strong { color: var(--ed-err); }
.ed-diag.ed-warning strong { color: var(--ed-warn); }
.ed-actions { display: flex; gap: 12px; align-items: center; }
.ed-signin { list-style: none; padding: 0; }
.ed-signin li { margin: 12px 0; }
.ed-conflict { border: 1px solid var(--ed-border); border-radius: var(--ed-radius); margin: 0 0 16px; padding: 12px; }
.ed-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 800px) { .ed-sides { grid-template-columns: 1fr; } }
.ed-sides figure { margin: 0; min-width: 0; }
.ed-sides figcaption { font-weight: 600; }
.ed-sides pre { max-height: 50vh; overflow: auto; background: var(--ed-soft); padding: 8px; border-radius: var(--ed-radius-sm); font-size: 12px; }
table { border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid var(--ed-border); padding: 4px 8px; text-align: left; font-size: 14px; }
caption { text-align: left; font-weight: 600; }
.ed-identity { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin: 0 0 8px; color: var(--ed-muted); font-size: 14px; }
.ed-identity strong { color: var(--ed-fg); }
.ed-verified { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; color: var(--ed-accent);
  background: var(--ed-accent-soft); border: 1px solid color-mix(in srgb, var(--ed-accent) 35%, transparent); border-radius: 999px; padding: 0 8px; }
.ed-verified::before { content: "\\2713"; }
.ed-badge-signed { color: var(--ed-fg); border-color: var(--ed-border); background: var(--ed-soft); font-weight: 600; }
.ed-blocked { border: 1px solid color-mix(in srgb, var(--ed-warn) 45%, var(--ed-border)); background: var(--ed-warn-bg); border-radius: var(--ed-radius);
  padding: 12px 16px; margin: 0 0 16px; box-shadow: var(--ed-shadow); }
.ed-blocked h2 { color: var(--ed-fg); font-size: 16px; }
.ed-blocked p { margin: 6px 0; }
.ed-blocked .ed-hint { color: var(--ed-fg); }
@media (prefers-reduced-motion: no-preference) { button, .ed-button { transition: background-color .15s ease, border-color .15s ease; } }
/* Visual editor (visual/main.ts): the topic edited as it reads, with a toolbar. */
.vx-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--ed-border); margin-bottom: 12px; }
.vx-tabs [role="tab"] { background: none; color: var(--ed-muted); border: 0; border-bottom: 3px solid transparent; border-radius: 0; padding: 8px 14px; font-weight: 600; }
.vx-tabs [role="tab"][aria-selected="true"] { color: var(--ed-fg); border-bottom-color: var(--ed-accent); }
.vx-tabs [role="tab"][disabled] { opacity: .5; }
.vx-notice { background: var(--ed-warn-bg); color: var(--ed-fg); border-left: 4px solid var(--ed-warn); padding: 8px 12px; border-radius: var(--ed-radius-sm); }
.ed-workspace > * { min-width: 0; }
.vx-pane { min-width: 0; border: 1px solid var(--ed-border); border-radius: var(--ed-radius); background: var(--ed-bg); box-shadow: var(--ed-shadow); margin-bottom: 12px; }
.vx-toolbar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 6px 12px; padding: 8px; background: var(--ed-soft);
  border-bottom: 1px solid var(--ed-border); border-radius: var(--ed-radius) var(--ed-radius) 0 0; }
.vx-group { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.vx-tool { background: var(--ed-bg); color: var(--ed-fg); border: 1px solid var(--ed-border); padding: 4px 10px; min-width: 36px; min-height: 36px; font-size: 14px; }
.vx-tool:hover:not([disabled]) { border-color: var(--ed-accent); }
.vx-tool[aria-pressed="true"], .vx-tool[aria-expanded="true"] { background: var(--ed-accent-soft); border-color: var(--ed-accent); color: var(--ed-fg); }
.vx-tool[disabled] { opacity: .4; }
.vx-b { font-weight: 800; }
.vx-i { font-style: italic; }
.vx-mono { font-family: var(--ed-mono); }
select.vx-more { min-width: 0; min-height: 36px; padding: 4px 8px; }
.vx-surface { padding: 8px 0; }
.vx-editor { max-width: 760px; margin: 0 auto; padding: 16px 24px 48px; min-height: 50vh; font-size: 16px; line-height: 1.65; outline: none; white-space: pre-wrap; word-wrap: break-word; }
.vx-editor:focus-visible { box-shadow: inset 0 0 0 2px var(--ed-accent-soft); }
.vx-title { font-size: 30px; line-height: 1.25; margin: 8px 0 4px; }
.vx-shortdesc { font-size: 18px; color: var(--ed-muted); margin: 0 0 24px; }
.vx-empty::before { content: attr(data-placeholder); color: var(--ed-muted); opacity: .7; pointer-events: none; float: left; height: 0; }
.vx-editor p { margin: 0 0 12px; }
.vx-editor h2.vx-tb-title { font-size: 22px; margin: 24px 0 8px; }
.vx-c-section, .vx-c-example { margin: 0 0 8px; }
.vx-c-prereq, .vx-c-context, .vx-c-result, .vx-c-postreq { border-left: 3px solid var(--ed-border); padding-left: 12px; margin: 0 0 16px; }
.vx-c-prereq::before, .vx-c-context::before, .vx-c-result::before, .vx-c-postreq::before, .vx-c-info::before, .vx-c-stepresult::before, .vx-c-example:not(:has(> h2))::before {
  display: block; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--ed-muted); margin-bottom: 4px; }
.vx-c-prereq::before { content: "Before you begin"; }
.vx-c-context::before { content: "Context"; }
.vx-c-result::before { content: "Result"; }
.vx-c-postreq::before { content: "What to do next"; }
.vx-c-info::before { content: "Details"; }
.vx-c-stepresult::before { content: "Result of this step"; }
.vx-c-example:not(:has(> h2))::before { content: "Example"; }
.vx-c-note { display: block; border: 1px solid var(--ed-border); border-left: 4px solid var(--ed-accent); background: var(--ed-accent-soft); border-radius: var(--ed-radius-sm); padding: 8px 12px; margin: 0 0 12px; }
.vx-c-note::before { content: attr(data-note); display: block; font-weight: 700; text-transform: capitalize; margin-bottom: 2px; }
.vx-c-note[data-note="caution"], .vx-c-note[data-note="warning"], .vx-c-note[data-note="danger"], .vx-c-note[data-note="attention"], .vx-c-note[data-note="restriction"] {
  border-left-color: var(--ed-warn); background: var(--ed-warn-bg); }
.vx-c-note > :last-child, .vx-item > :last-child { margin-bottom: 0; }
.vx-c-lq { border-left: 3px solid var(--ed-border); margin: 0 0 12px; padding-left: 12px; color: var(--ed-muted); }
.vx-c-fig { margin: 0 0 12px; }
.vx-c-info, .vx-c-stepresult, .vx-c-stepxmp { margin: 4px 0 8px; font-size: 15px; }
.vx-list { margin: 0 0 12px; padding-left: 28px; }
.vx-list-steps > .vx-item { margin-bottom: 12px; }
.vx-list-steps > .vx-item::marker { font-weight: 700; color: var(--ed-accent); }
.vx-tb-cmd { font-weight: 600; }
.vx-item > p { margin-bottom: 4px; }
.vx-code { background: var(--ed-soft); border: 1px solid var(--ed-border); border-radius: var(--ed-radius-sm); padding: 10px 12px; font: 14px/1.5 var(--ed-mono); white-space: pre-wrap; margin: 0 0 12px; }
.vx-m-codeph, .vx-m-tt, .vx-m-filepath, .vx-m-cmdname, .vx-m-userinput, .vx-m-systemoutput, .vx-m-varname, .vx-m-parmname, .vx-m-apiname, .vx-m-option {
  font-family: var(--ed-mono); font-size: .9em; background: var(--ed-soft); border-radius: 4px; padding: 0 3px; }
.vx-m-varname { font-style: italic; }
.vx-m-uicontrol, .vx-m-wintitle { font-weight: 600; }
.vx-m-term { font-style: italic; }
.vx-m-xref { color: var(--ed-accent); text-decoration: underline; }
[data-cond] { position: relative; outline: 1px dashed color-mix(in srgb, var(--ed-warn) 60%, transparent); outline-offset: 3px; border-radius: 2px; }
.vx-tb[data-cond]::after, .vx-c[data-cond]::after, .vx-item[data-cond]::after, .vx-list[data-cond]::after, .vx-code[data-cond]::after {
  content: "Only for " attr(data-cond); display: block; width: fit-content; font: 600 11px/1.6 var(--ed-font); color: var(--ed-warn); background: var(--ed-warn-bg);
  border-radius: 999px; padding: 0 8px; margin-top: 2px; white-space: normal; }
.vx-raw, .vx-raw-inline { font: 13px/1.4 var(--ed-font); color: var(--ed-muted); background: var(--ed-soft); border: 1px dashed var(--ed-border); border-radius: var(--ed-radius-sm); cursor: default; white-space: normal; }
.vx-raw { display: block; padding: 10px 12px; margin: 0 0 12px; }
.vx-raw::before { content: "\\1F512\\FE0E  "; }
.vx-raw-inline { display: inline-block; padding: 0 6px; margin: 0 1px; }
.ProseMirror-selectednode { outline: 2px solid var(--ed-accent) !important; outline-offset: 2px; }
.ProseMirror-gapcursor { display: none; pointer-events: none; position: absolute; }
.ProseMirror-gapcursor::after { content: ""; display: block; position: absolute; top: -2px; width: 20px; border-top: 1px solid var(--ed-fg); }
.ProseMirror-focused .ProseMirror-gapcursor { display: block; }
.ProseMirror-hideselection *::selection { background: transparent; }
.vx-props { border-top: 1px solid var(--ed-border); padding: 12px 16px; background: var(--ed-soft); border-radius: 0 0 var(--ed-radius) var(--ed-radius); }
.vx-props h2 { font-size: 16px; }
.vx-props input:not([type="checkbox"]), .vx-props select { min-width: 0; width: 100%; max-width: 28em; }
.vx-props textarea { min-height: 10em; }
.vx-crumbs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 12px; }
.vx-crumb { background: var(--ed-bg); color: var(--ed-fg); border: 1px solid var(--ed-border); padding: 2px 10px; font-size: 13px; }
.vx-crumb[aria-current="true"] { border-color: var(--ed-accent); background: var(--ed-accent-soft); font-weight: 600; }
.vx-conds { border: 1px solid var(--ed-border); border-radius: var(--ed-radius-sm); padding: 8px 12px; }
.vx-conds label { display: block; font-weight: 600; margin: 0; }
.vx-muted { color: var(--ed-muted); font-size: 13px; }
.vx-error { color: var(--ed-err); }
.vx-dialog { border: 1px solid var(--ed-border); border-radius: var(--ed-radius); background: var(--ed-bg); color: var(--ed-fg); box-shadow: var(--ed-shadow); width: min(32em, calc(100vw - 32px)); padding: 16px 20px; }
.vx-dialog::backdrop { background: color-mix(in srgb, var(--ed-fg) 35%, transparent); }
.vx-dialog input:not([type="checkbox"]) { width: 100%; min-width: 0; }
.vx-dialog label.vx-inline { display: inline; font-weight: normal; }
.vx-dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.vx-secondary, .vx-dialog button.vx-secondary { background: var(--ed-bg); color: var(--ed-fg); border-color: var(--ed-border); }
@media (max-width: 600px) {
  .vx-editor { padding: 12px 12px 32px; font-size: 16px; }
  .vx-title { font-size: 24px; }
  .vx-toolbar { flex-wrap: nowrap; overflow-x: auto; gap: 6px; -webkit-overflow-scrolling: touch; }
  .vx-group { flex-wrap: nowrap; }
  .ed-main { padding: 12px; }
}
`;
