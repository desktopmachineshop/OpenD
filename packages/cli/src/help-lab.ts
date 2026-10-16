import { resolveContext, type ReleaseView } from '@opend/filter';
import { escapeHtml } from '@opend/render-html';
import { describeAudience, type PreviewAudience } from './project.js';

/**
 * The previewer's help lab: every host app, context key and route, what each
 * resolves to for the current preview reader, and the real widget to click
 * through them. Authors check context-sensitive help here before publishing.
 */
export function helpLab(
  view: ReleaseView,
  audience: PreviewAudience,
  origin: string,
  testPath: string,
): string {
  const apps = Object.entries(view.release.contexts ?? {});
  const resolvedCell = (r: ReturnType<typeof resolveContext>) =>
    r
      ? `<a href="/${escapeHtml(r.topicId)}.html">${escapeHtml(view.topic(r.topicId)?.title ?? r.topicId)}</a>${r.via === 'key' ? '' : ` <small>(via ${r.via}: ${escapeHtml(r.key)})</small>`}`
      : '<em>nothing visible</em>';
  const openButton = (app: string, attr: string, value: string) =>
    `<button type="button" data-app="${escapeHtml(app)}" ${attr}="${escapeHtml(value)}">Open in widget</button>`;

  const sections = apps
    .map(([app, help]) => {
      const keys = Object.keys(help.keys)
        .sort()
        .map(
          (key) =>
            `<tr><td><code>${escapeHtml(key)}</code></td><td>${resolvedCell(resolveContext(view, { app, key }))}</td><td>${openButton(app, 'data-key', key)}</td></tr>`,
        )
        .join('');
      const routes = help.routes
        .map(
          (r) =>
            `<tr><td><code>${escapeHtml(r.pattern)}</code></td><td><code>${escapeHtml(r.key)}</code></td></tr>`,
        )
        .join('');
      const tested = testPath
        ? `<p>Path <code>${escapeHtml(testPath)}</code> resolves to ${resolvedCell(resolveContext(view, { app, path: testPath }))} ${openButton(app, 'data-path', testPath)}</p>`
        : '';
      return `<section><h2>App <code>${escapeHtml(app)}</code></h2>
<p>Default: <code>${escapeHtml(help.default ?? '(none)')}</code></p>
<h3>Context keys</h3><table><thead><tr><th>Key</th><th>Resolves to for this reader</th><th></th></tr></thead><tbody>${keys}</tbody></table>
<h3>Routes</h3>${routes ? `<table><thead><tr><th>Pattern</th><th>Key</th></tr></thead><tbody>${routes}</tbody></table>` : '<p>No routes in help-contexts.yaml.</p>'}
<form method="get" action="/_opend/help-lab"><label>Try a host-app path <input name="path" value="${escapeHtml(testPath)}" placeholder="/settings/sso"></label> <button>Resolve</button></form>
${tested}</section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Help lab</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; margin: 24px; max-width: 900px; }
table { border-collapse: collapse; margin: 8px 0 16px; } td, th { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
code { font-size: 13px; }
</style></head>
<body>
<h1>Help lab</h1>
<p>Previewing as ${escapeHtml(describeAudience(audience))}. <a href="/">Back to the docs</a> · switch reader from the banner on any docs page.</p>
${sections || '<p>No context-sensitive help yet. Add <code>&lt;resourceid appname="..." appid="..."/&gt;</code> to topics.</p>'}
<script src="/embed/opend-help.js"></script>
<script>
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-app]');
  if (!b) return;
  OpenDHelp.init({ docsUrl: ${JSON.stringify(origin)}, app: b.dataset.app });
  OpenDHelp.open(b.dataset.key ? { key: b.dataset.key } : { path: b.dataset.path });
});
</script>
</body></html>
`;
}
