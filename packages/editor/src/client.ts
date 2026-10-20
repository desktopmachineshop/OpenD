/**
 * The editor page's script, served as `/assets/editor.js`. It is a standalone
 * script: it must not reference anything outside its own body. Without it the
 * page still works through plain form posts; with it, the preview follows the
 * author's typing and saves happen without a reload.
 */
export function installEditor(win: Window): void {
  const doc = win.document;
  const csrf = doc.querySelector<HTMLMetaElement>('meta[name="opend-csrf"]')?.content ?? '';
  const form = doc.getElementById('ed-form') as HTMLFormElement | null;
  const source = doc.getElementById('ed-source') as HTMLTextAreaElement | null;
  if (!form || !source) return;
  const path = form.dataset.path ?? '';
  const frame = doc.getElementById('ed-preview') as HTMLIFrameElement | null;
  const list = doc.getElementById('ed-diagnostics');
  const status = doc.getElementById('ed-save-status');
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | null;
  // The Preview tab's choice of conditions applies to every preview the frame shows.
  const viewForm = doc.getElementById('ed-view') as HTMLFormElement | null;
  let previewPage = viewForm?.getAttribute('action') ?? '';
  const showPreview = (url: string) => {
    if (!frame) return;
    const next = new URL(url, win.location.href);
    previewPage = next.pathname;
    if (viewForm)
      for (const [name, value] of new FormData(viewForm))
        if (typeof value === 'string' && value) next.searchParams.set(name, value);
    frame.src = next.pathname + next.search;
  };
  viewForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    showPreview(previewPage);
  });
  doc.getElementById('ed-view-reset')?.addEventListener('click', (event) => {
    event.preventDefault();
    viewForm?.reset();
    showPreview(previewPage);
  });

  interface Diagnostic {
    severity: string;
    code: string;
    message: string;
    file?: string;
    line?: number;
  }

  const showDiagnostics = (diagnostics: Diagnostic[]) => {
    if (!list) return;
    list.textContent = '';
    if (!diagnostics.length) {
      const p = doc.createElement('p');
      p.className = 'ed-ok';
      p.textContent = 'No problems found.';
      list.append(p);
      return;
    }
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const summary = doc.createElement('p');
    summary.textContent = `${errors} error${errors === 1 ? '' : 's'}, ${diagnostics.length - errors} warning${diagnostics.length - errors === 1 ? '' : 's'}.`;
    const ul = doc.createElement('ul');
    ul.className = 'ed-diags';
    const sorted = [...diagnostics].sort(
      (a, b) =>
        Number(b.file === path) - Number(a.file === path) ||
        Number(b.severity === 'error') - Number(a.severity === 'error'),
    );
    for (const d of sorted.slice(0, 50)) {
      const li = doc.createElement('li');
      li.className = `ed-diag ed-${d.severity}`;
      const strong = doc.createElement('strong');
      strong.textContent = d.severity;
      const code = doc.createElement('code');
      code.textContent = d.code;
      li.append(
        strong,
        ` ${d.file ?? 'project'}${d.line ? `:${d.line}` : ''} `,
        code,
        ` ${d.message}`,
      );
      ul.append(li);
    }
    list.append(summary, ul);
  };

  const setStatus = (text: string, link?: { href: string; label: string }) => {
    if (!status) return;
    status.textContent = text;
    if (link) {
      const a = doc.createElement('a');
      a.href = link.href;
      a.textContent = link.label;
      status.append(' ', a);
    }
  };

  const post = (url: string, body: Record<string, string>) =>
    win.fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify(body),
    });

  let timer: number | undefined;
  let sequence = 0;
  let dirty = false;
  const refreshPreview = () => {
    const mine = ++sequence;
    void post('/api/preview', { path, content: source.value })
      .then(async (res) => {
        const data = (await res.json()) as {
          diagnostics?: Diagnostic[];
          previewUrl?: string;
          error?: string;
        };
        if (mine !== sequence) return; // a newer edit is on its way
        if (!res.ok) throw new Error(data.error ?? 'Preview failed');
        showDiagnostics(data.diagnostics ?? []);
        if (data.previewUrl) showPreview(data.previewUrl);
      })
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : 'Preview failed'));
  };

  source.addEventListener('input', () => {
    dirty = true;
    setStatus('Unsaved changes');
    win.clearTimeout(timer);
    timer = win.setTimeout(refreshPreview, 600);
  });

  const save = () => {
    setStatus('Saving…');
    const body: Record<string, string> = {
      path,
      content: source.value,
      branch: field('branch')?.value ?? '',
      expectSha: field('expectSha')?.value ?? '',
      message: field('message')?.value ?? '',
    };
    void post('/save', body)
      .then(async (res) => {
        const data = (await res.json()) as {
          sha?: string;
          branch?: string;
          fileSha?: string | null;
          sync?: string;
          diagnostics?: Diagnostic[];
          previewUrl?: string;
          error?: string;
          signInUrl?: string;
        };
        if (!res.ok) {
          if (data.diagnostics) showDiagnostics(data.diagnostics);
          if (data.signInUrl) {
            // Signed commits need GitHub sign-in; come back to this file afterwards.
            const back = `/auth/github?returnTo=${encodeURIComponent(win.location.pathname + win.location.search)}`;
            setStatus(data.error ?? 'Save failed', { href: back, label: 'Sign in with GitHub' });
            return;
          }
          throw new Error(data.error ?? 'Save failed');
        }
        dirty = false;
        const branch = field('branch');
        if (branch && data.branch) branch.value = data.branch;
        const expect = field('expectSha');
        if (expect && data.fileSha) expect.value = data.fileSha;
        const message = field('message');
        if (message) message.value = '';
        showDiagnostics(data.diagnostics ?? []);
        if (data.previewUrl) showPreview(data.previewUrl);
        if (data.sync === 'conflict')
          setStatus(
            `Saved ${String(data.sha).slice(0, 7)}, but the main branch has conflicting changes.`,
            {
              href: '/conflicts',
              label: 'Resolve them',
            },
          );
        else setStatus(`Saved as ${String(data.sha).slice(0, 7)}.`);
      })
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : 'Save failed'));
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  doc.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      save();
    }
  });
  win.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });
}

/** The editor page script. */
export function editorScript(): string {
  return `/* OpenD editor */\n"use strict";\n(${installEditor.toString()})(window);\n`;
}
