import { escapeHtml as h } from '@opend/render-html';
import type { Diagnostic } from '@opend/model';
import type { EditorUser } from '@opend/store';

export { h };

/** The editor's own pages: no inline script or style, so the CSP can forbid both. */
export const EDITOR_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Draft previews, framed by the editor. Rendered DITA uses inline styles but
 * never scripts: there is no script-src, so `default-src 'none'` forbids them.
 */
export const PREVIEW_CSP =
  "default-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; form-action 'none'; frame-ancestors 'self'; base-uri 'none'";

export const PAGE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': EDITOR_CSP,
};

export const PREVIEW_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': PREVIEW_CSP,
};

/** Author-supplied files (SVG can carry script) are sandboxed. */
export const ASSET_HEADERS = {
  'cache-control': 'private, max-age=60',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

export interface Shell {
  title: string;
  user?: EditorUser | null;
  csrf?: string;
  /** Which nav item is current. */
  current?: 'files' | 'publish' | 'activity' | 'conflicts';
  repo?: string;
  base?: string;
}

/** The page frame. `body` is trusted HTML built with `h()` for every value. */
export function layout(shell: Shell, body: string): string {
  const nav = shell.user
    ? `<nav class="ed-nav" aria-label="Editor">
<a href="/"${shell.current === 'files' ? ' aria-current="page"' : ''}>Files</a>
<a href="/publish"${shell.current === 'publish' ? ' aria-current="page"' : ''}>Publish</a>
<a href="/activity"${shell.current === 'activity' ? ' aria-current="page"' : ''}>Activity</a>
</nav>
<div class="ed-user"><span>${h(shell.user.name || shell.user.email)}</span>
<form method="post" action="/auth/logout"><input type="hidden" name="_csrf" value="${h(shell.csrf ?? '')}"><button type="submit" class="ed-link">Sign out</button></form></div>`
    : '';
  const where = shell.repo
    ? `<span class="ed-repo">${h(shell.repo)}${shell.base ? ` · ${h(shell.base)}` : ''}</span>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${shell.csrf ? `<meta name="opend-csrf" content="${h(shell.csrf)}">` : ''}
<title>${h(shell.title)} · OpenD editor</title>
<link rel="stylesheet" href="/assets/editor.css">
<script src="/assets/editor.js" defer></script>
</head>
<body>
<a class="ed-skip" href="#main">Skip to content</a>
<header class="ed-header"><a class="ed-brand" href="/">OpenD editor</a>${where}${nav}</header>
<main id="main" class="ed-main">
${body}
</main>
</body>
</html>
`;
}

export function messagePage(title: string, message: string, shell: Partial<Shell> = {}): string {
  return layout({ ...shell, title }, `<h1>${h(title)}</h1><p>${h(message)}</p>`);
}

export function diagnosticsList(diagnostics: readonly Diagnostic[], currentFile?: string): string {
  if (!diagnostics.length) return '<p class="ed-ok">No problems found.</p>';
  const sorted = [...diagnostics].sort(
    (a, b) =>
      Number(b.file === currentFile) - Number(a.file === currentFile) ||
      Number(b.severity === 'error') - Number(a.severity === 'error'),
  );
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const items = sorted
    .slice(0, 50)
    .map(
      (d) =>
        `<li class="ed-diag ed-${d.severity}"><strong>${d.severity}</strong> ${h(d.file ?? 'project')}${d.line ? `:${d.line}` : ''} <code>${h(d.code)}</code> ${h(d.message)}</li>`,
    )
    .join('');
  return `<p>${errors} error${errors === 1 ? '' : 's'}, ${diagnostics.length - errors} warning${diagnostics.length - errors === 1 ? '' : 's'}.</p><ul class="ed-diags">${items}</ul>`;
}

/** A nested list of files, directories first. */
export function fileTree(paths: string[], current: string | null, edited: Set<string>): string {
  interface Dir {
    dirs: Map<string, Dir>;
    files: string[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) dir.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      dir = next;
    }
    dir.files.push(path);
  }
  const render = (dir: Dir): string => {
    const dirs = [...dir.dirs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, sub]) => `<li><span class="ed-dir">${h(name)}/</span><ul>${render(sub)}</ul></li>`,
      )
      .join('');
    const files = dir.files
      .sort()
      .map((path) => {
        const name = path.split('/').pop()!;
        const mark = edited.has(path) ? ' <span class="ed-badge">changed</span>' : '';
        return `<li><a href="/edit?path=${encodeURIComponent(path)}"${path === current ? ' aria-current="page"' : ''}>${h(name)}</a>${mark}</li>`;
      })
      .join('');
    return dirs + files;
  };
  return `<nav class="ed-tree" aria-label="Files"><ul>${render(root)}</ul></nav>`;
}

export function csrfField(csrf: string): string {
  return `<input type="hidden" name="_csrf" value="${h(csrf)}">`;
}
