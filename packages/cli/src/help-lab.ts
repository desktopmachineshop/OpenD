import {
  ACTIVITY_SIGNALS,
  resolveContext,
  type ContextRequest,
  type ReleaseView,
} from '@opend/filter';
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
  test: Omit<ContextRequest, 'app'>,
): string {
  const apps = Object.entries(view.release.contexts ?? {});
  const resolvedCell = (r: ReturnType<typeof resolveContext>) =>
    r
      ? `<a href="/${escapeHtml(r.topicId)}.html${r.fragment ? `#${escapeHtml(encodeURIComponent(r.fragment))}` : ''}">${escapeHtml(view.topic(r.topicId)?.title ?? r.topicId)}</a>${via(r)}`
      : '<em>nothing visible</em>';
  const via = (r: NonNullable<ReturnType<typeof resolveContext>>) => {
    const from = r.signal && r.signal !== 'view' ? ` of ${r.signal}` : '';
    if (r.via === 'key')
      return from ? ` <small>(via ${r.signal}: ${escapeHtml(r.key)})</small>` : '';
    return ` <small>(via ${r.via}${from}: ${escapeHtml(r.key)})</small>`;
  };
  const openButton = (app: string, attrs: Record<string, string | undefined>) =>
    `<button type="button" data-app="${escapeHtml(app)}"${Object.entries(attrs)
      .filter((e): e is [string, string] => Boolean(e[1]))
      .map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`)
      .join('')}>Open in widget</button>`;
  const testing = ACTIVITY_SIGNALS.some((s) => test[s]) || Boolean(test.path);
  const field = (name: string, label: string, placeholder: string) =>
    `<label>${label} <input name="${name}" value="${escapeHtml((test as Record<string, string | undefined>)[name] ?? '')}" placeholder="${placeholder}"></label>`;

  const sections = apps
    .map(([app, help]) => {
      const keys = Object.keys(help.keys)
        .sort()
        .map(
          (key) =>
            `<tr><td><code>${escapeHtml(key)}</code></td><td>${resolvedCell(resolveContext(view, { app, key }))}</td><td>${openButton(app, { key })}</td></tr>`,
        )
        .join('');
      const routes = help.routes
        .map(
          (r) =>
            `<tr><td><code>${escapeHtml(r.pattern)}</code></td><td><code>${escapeHtml(r.key)}</code></td></tr>`,
        )
        .join('');
      const tested = testing
        ? `<p>${describeTest(test)} resolves to ${resolvedCell(resolveContext(view, { ...test, app }))} ${openButton(app, { ...test })}</p>`
        : '';
      return `<section><h2>App <code>${escapeHtml(app)}</code></h2>
<p>Default: <code>${escapeHtml(help.default ?? '(none)')}</code></p>
<h3>Context keys</h3><table><thead><tr><th>Key</th><th>Resolves to for this reader</th><th></th></tr></thead><tbody>${keys}</tbody></table>
<h3>Routes</h3>${routes ? `<table><thead><tr><th>Pattern</th><th>Key</th></tr></thead><tbody>${routes}</tbody></table>` : '<p>No routes in help-contexts.yaml.</p>'}
<form method="get" action="/_opend/help-lab"><fieldset><legend>Try what a reader is doing</legend>
${field('focus', 'Focused field', 'settings.sso.issuer')}
${field('action', 'Last pressed', 'settings.sso.test')}
${field('pane', 'Tab or pane', 'settings.sso.advanced')}
${field('path', 'Host-app path', '/settings/sso')}
<button>Resolve</button></fieldset></form>
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
fieldset { display: grid; gap: 6px; max-width: 480px; } label { display: grid; grid-template-columns: 9em 1fr; gap: 8px; } fieldset button { justify-self: start; }
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
  if (b.dataset.key) return OpenDHelp.open({ key: b.dataset.key });
  OpenDHelp.setContext({ path: b.dataset.path || '/' });
  OpenDHelp.setActivity({ focus: b.dataset.focus || null, action: b.dataset.action || null, pane: b.dataset.pane || null });
  OpenDHelp.open();
});
</script>
</body></html>
`;
}

function describeTest(test: Omit<ContextRequest, 'app'>): string {
  const parts = [
    ...ACTIVITY_SIGNALS.filter((s) => test[s]).map(
      (s) => `${s} <code>${escapeHtml(test[s]!)}</code>`,
    ),
    ...(test.path ? [`path <code>${escapeHtml(test.path)}</code>`] : []),
  ];
  return parts.join(', ').replace(/^./, (c) => c.toUpperCase());
}
