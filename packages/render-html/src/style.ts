/**
 * Base layout and typography. Brand themes override the `--opend-*` variables
 * (and anything else) in their own stylesheet, which loads after this one.
 */
export const DEFAULT_CSS = `
:root {
  --opend-accent: #2f6fde;
  --opend-text: #1d2433;
  --opend-muted: #5b6475;
  --opend-surface: #ffffff;
  --opend-surface-alt: #f4f6fa;
  --opend-border: #dfe3ea;
  --opend-warn: #b45309;
  --opend-cond: #7c3aed;
  --opend-font: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --opend-mono: ui-monospace, 'SFMono-Regular', Menlo, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --opend-accent: #7aa7ff;
    --opend-text: #e6e9ef;
    --opend-muted: #a3abba;
    --opend-surface: #14171d;
    --opend-surface-alt: #1d2129;
    --opend-border: #2c313b;
    --opend-warn: #f59e0b;
    --opend-cond: #a78bfa;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.6 var(--opend-font); color: var(--opend-text); background: var(--opend-surface); }
a { color: var(--opend-accent); }
.site-header { display: flex; gap: 12px; align-items: baseline; padding: 12px 16px; border-bottom: 1px solid var(--opend-border); }
.site-title { font-weight: 600; text-decoration: none; color: inherit; }
.site-release { color: var(--opend-muted); font-size: 14px; }
.site-pdfs { margin-left: auto; display: flex; gap: 12px; font-size: 14px; }
.layout { display: grid; grid-template-columns: minmax(200px, 260px) minmax(0, 1fr); max-width: 1200px; margin: 0 auto; }
.toc { padding: 16px; border-right: 1px solid var(--opend-border); font-size: 15px; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc ul ul { padding-left: 14px; }
.toc li { margin: 4px 0; }
.toc a { text-decoration: none; }
.toc a[aria-current="page"] { font-weight: 600; }
.toc .nav-heading { display: block; margin-top: 12px; font-weight: 600; color: var(--opend-muted); font-size: 13px; text-transform: uppercase; letter-spacing: .04em; }
main { padding: 16px 32px 64px; min-width: 0; }
article { max-width: 760px; }
h1 { font-size: 30px; line-height: 1.25; margin: 8px 0 12px; }
h2 { font-size: 21px; margin: 28px 0 8px; }
.shortdesc { font-size: 18px; color: var(--opend-muted); }
code, pre, kbd, samp { font-family: var(--opend-mono); font-size: .92em; }
pre { background: var(--opend-surface-alt); padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
.lines { white-space: pre-line; }
.note { display: block; border-left: 4px solid var(--opend-accent); background: var(--opend-surface-alt); padding: 10px 14px; margin: 16px 0; border-radius: 0 6px 6px 0; }
.note-warning, .note-danger, .note-caution { border-left-color: var(--opend-warn); }
.note-label { font-weight: 600; }
.steps > li, .substeps > li { margin: 8px 0; }
.cmd { display: block; }
.uicontrol { font-weight: 600; }
.table-wrap { overflow-x: auto; margin: 16px 0; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--opend-border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--opend-surface-alt); }
img { max-width: 100%; height: auto; }
.xref-unavailable { color: var(--opend-muted); }
.opend-conditional { outline: 1px dashed var(--opend-cond); outline-offset: 2px; }
.opend-conditional::before { content: attr(data-applies); display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 4px; font: 11px/1.6 var(--opend-mono); color: #fff; background: var(--opend-cond); }
opend-cond { display: contents; }
.opend-alt-sep { color: var(--opend-cond); }
.opend-badge { font: 11px/1.6 var(--opend-mono); color: var(--opend-cond); }
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; }
  .toc { border-right: 0; border-bottom: 1px solid var(--opend-border); }
  main { padding: 16px; }
}
`;
