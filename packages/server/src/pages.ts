import { DEFAULT_CSS, escapeHtml } from '@opend/render-html';

/** A minimal page for sign-in, errors and notices. `body` is trusted HTML. */
export function simplePage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${DEFAULT_CSS}
.opend-simple { max-width: 560px; margin: 64px auto; padding: 0 16px; }
.opend-simple button { font: inherit; padding: 6px 14px; cursor: pointer; }
.opend-simple li { margin: 8px 0; }
</style>
</head>
<body><main class="opend-simple">${body}</main></body>
</html>
`;
}

export function messagePage(title: string, message: string): string {
  return simplePage(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

/** Marker in cached pages, replaced per request with the signed-in reader's bar. */
export const USER_BAR_MARKER = '<!--opend-user-bar-->';

export function userBar(email: string): string {
  return `<div class="opend-user-bar">
<span>Signed in as ${escapeHtml(email)}</span>
<form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>
</div>`;
}
