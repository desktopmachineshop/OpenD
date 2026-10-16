/**
 * Runs inside the help iframe. It is served as a standalone script, so it must
 * not reference anything outside its own body (no imports, no module scope).
 *
 * Configuration comes from the script tag's data attributes:
 *   data-host-origin  the embedding page's origin (already checked server-side
 *                     against the allowed origins); without it the page runs
 *                     standalone and sends no messages
 *   data-need-token   "1" when the frame has no session yet
 *   data-next         where to go once a session exists
 *   data-topic-id, data-topic-title   the topic being shown
 */
export function installFrame(win: Window): void {
  const doc = win.document;
  const script = doc.currentScript as HTMLScriptElement | null;
  const data = script?.dataset ?? {};
  const hostOrigin = data.hostOrigin;
  if (!hostOrigin || win.parent === win) return;
  doc.documentElement.setAttribute('data-opend-embedded', '1');

  const post = (message: Record<string, unknown>) =>
    win.parent.postMessage({ protocol: 'opend-help', v: 1, ...message }, hostOrigin);

  const showError = (text: string) => {
    const el = doc.querySelector('[data-opend-status]');
    if (el) el.textContent = text;
  };

  win.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== hostOrigin || event.source !== win.parent) return;
    const msg = event.data as { protocol?: string; type?: string; token?: unknown };
    if (
      msg?.protocol !== 'opend-help' ||
      msg.type !== 'opend:token' ||
      typeof msg.token !== 'string'
    )
      return;
    void win
      .fetch('/embed/session', {
        method: 'POST',
        headers: { authorization: `Bearer ${msg.token}` },
        credentials: 'same-origin',
      })
      .then((res) => {
        if (!res.ok)
          throw new Error(
            res.status === 403 ? 'You do not have access to this help.' : 'Sign-in failed.',
          );
        win.location.replace(data.next || '/embed/context');
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Sign-in failed.';
        showError(message);
        post({ type: 'opend:error', message });
      });
  });

  doc.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (target?.closest('[data-opend-close]')) {
      event.preventDefault();
      post({ type: 'opend:close' });
    }
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') post({ type: 'opend:close' });
  });

  if (data.needToken === '1') {
    post({ type: 'opend:need-token' });
    return;
  }
  post({ type: 'opend:ready' });
  if (data.topicId)
    post({ type: 'opend:navigated', topicId: data.topicId, title: data.topicTitle ?? '' });
}
