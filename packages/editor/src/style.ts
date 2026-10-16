/** The editor's stylesheet, served as `/assets/editor.css` (the CSP allows no inline styles). */
export const EDITOR_CSS = `
:root { --ed-fg: #1f2328; --ed-muted: #59636e; --ed-border: #d1d9e0; --ed-accent: #0b5cad; --ed-bg: #fff;
  --ed-soft: #f6f8fa; --ed-warn-bg: #fff8c5; --ed-warn: #7d4e00; --ed-ok: #1a7f37; --ed-err: #cf222e; }
@media (prefers-color-scheme: dark) {
  :root { --ed-fg: #e6edf3; --ed-muted: #9198a1; --ed-border: #3d444d; --ed-accent: #4493f8; --ed-bg: #0d1117;
    --ed-soft: #151b23; --ed-warn-bg: #3b2e00; --ed-warn: #e3b341; --ed-ok: #3fb950; --ed-err: #f85149; }
}
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ed-fg); background: var(--ed-bg); }
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
h1.ed-file { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 18px; }
h2 { font-size: 18px; margin: 0 0 8px; }
label { display: block; font-weight: 600; margin-bottom: 4px; }
input[type="radio"] + * { font-weight: normal; }
fieldset label { display: inline-block; font-weight: normal; margin-right: 16px; }
input:not([type="radio"]):not([type="hidden"]), select { font: inherit; padding: 6px 8px; border: 1px solid var(--ed-border); border-radius: 6px; background: var(--ed-bg); color: var(--ed-fg); min-width: 16em; }
button, .ed-button { font: inherit; padding: 6px 16px; border-radius: 6px; border: 1px solid var(--ed-accent); background: var(--ed-accent); color: #fff; cursor: pointer; text-decoration: none; display: inline-block; }
button[disabled] { opacity: .5; cursor: not-allowed; }
textarea { width: 100%; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 8px; border: 1px solid var(--ed-border); border-radius: 6px; background: var(--ed-bg); color: var(--ed-fg); tab-size: 2; }
#ed-source { min-height: 60vh; resize: vertical; }
.ed-hint { color: var(--ed-muted); font-size: 13px; font-weight: normal; }
.ed-card { border: 1px solid var(--ed-border); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
.ed-status { margin-bottom: 16px; }
.ed-alert { background: var(--ed-warn-bg); color: var(--ed-warn); padding: 8px 12px; border-radius: 6px; }
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
.ed-preview iframe { width: 100%; height: 75vh; border: 1px solid var(--ed-border); border-radius: 6px; background: #fff; }
.ed-inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.ed-inline label { display: inline; margin: 0; }
.ed-diags { padding-left: 18px; font-size: 13px; }
.ed-diag.ed-error strong { color: var(--ed-err); }
.ed-diag.ed-warning strong { color: var(--ed-warn); }
.ed-actions { display: flex; gap: 12px; align-items: center; }
.ed-signin { list-style: none; padding: 0; }
.ed-signin li { margin: 12px 0; }
.ed-conflict { border: 1px solid var(--ed-border); border-radius: 8px; margin: 0 0 16px; padding: 12px; }
.ed-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 800px) { .ed-sides { grid-template-columns: 1fr; } }
.ed-sides figure { margin: 0; min-width: 0; }
.ed-sides figcaption { font-weight: 600; }
.ed-sides pre { max-height: 50vh; overflow: auto; background: var(--ed-soft); padding: 8px; border-radius: 6px; font-size: 12px; }
table { border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid var(--ed-border); padding: 4px 8px; text-align: left; font-size: 14px; }
caption { text-align: left; font-weight: 600; }
`;
