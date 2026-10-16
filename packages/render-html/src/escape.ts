const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Encodes a docs-root-relative path for use in a URL, keeping `/` separators. */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
