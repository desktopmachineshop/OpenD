import type { HelpContext, WidgetOptions } from './protocol.js';

export interface OpenDHelpApi {
  init(options: WidgetOptions): void;
  open(context?: HelpContext): void;
  close(): void;
  toggle(context?: HelpContext): void;
  /** Tells the widget where the user is; call it on every route change. */
  setContext(context: HelpContext): void;
  isOpen(): boolean;
}

/**
 * The host-page widget: `window.OpenDHelp` and the `<opend-help-button>`
 * element. Served as a standalone script, so it must not reference anything
 * outside its own body (types are erased; no imports, no module scope).
 */
export function installWidget(win: Window & { OpenDHelp?: OpenDHelpApi }): void {
  if (win.OpenDHelp) return;
  const doc = win.document;

  let options: WidgetOptions | null = null;
  let docsOrigin = '';
  let context: HelpContext | null = null;
  let host: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  let frame: HTMLIFrameElement | null = null;
  let open = false;
  let returnFocus: HTMLElement | null = null;

  const contextUrl = (): string => {
    const base = options!.docsUrl.replace(/\/$/, '');
    const params = new URLSearchParams({ app: options!.app, host: win.location.origin });
    if (context && 'key' in context) params.set('key', context.key);
    else if (context && 'path' in context) params.set('path', context.path);
    return `${base}/embed/context?${params.toString()}`;
  };

  const build = () => {
    if (host) return;
    host = doc.createElement('div');
    host.setAttribute('data-opend-help', '');
    const root = host.attachShadow({ mode: 'open' });
    const width = options!.width ?? 380;
    const side = options!.side ?? 'right';
    const style = doc.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .panel { position: fixed; top: 0; ${side}: 0; height: 100vh; height: 100dvh; width: ${width}px; max-width: 100vw;
        z-index: ${options!.zIndex ?? 2147483000}; background: Canvas; color: CanvasText;
        box-shadow: 0 0 24px rgba(0,0,0,.18); transform: translateX(${side === 'right' ? '100%' : '-100%'});
        transition: transform .2s ease; visibility: hidden; }
      .panel.open { transform: none; visibility: visible; }
      iframe { border: 0; width: 100%; height: 100%; display: block; }
      @media (max-width: 600px) { .panel { width: 100vw; } }
      @media (prefers-reduced-motion: reduce) { .panel { transition: none; } }`;
    panel = doc.createElement('aside');
    panel.className = 'panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'Help');
    frame = doc.createElement('iframe');
    frame.title = 'Help';
    frame.setAttribute('referrerpolicy', 'strict-origin');
    panel.append(frame);
    root.append(style, panel);
    doc.body.append(host);
  };

  const send = (message: Record<string, unknown>) =>
    frame?.contentWindow?.postMessage({ protocol: 'opend-help', v: 1, ...message }, docsOrigin);

  win.addEventListener('message', (event: MessageEvent) => {
    if (!frame || event.origin !== docsOrigin || event.source !== frame.contentWindow) return;
    const msg = event.data as {
      protocol?: string;
      type?: string;
      topicId?: string;
      title?: string;
    };
    if (msg?.protocol !== 'opend-help') return;
    if (msg.type === 'opend:close') api.close();
    else if (msg.type === 'opend:navigated' && msg.topicId) {
      options?.onNavigate?.({ topicId: msg.topicId, title: msg.title ?? '' });
    } else if (msg.type === 'opend:need-token') {
      const getToken = options?.getToken;
      if (!getToken) return;
      getToken().then(
        (token) => send({ type: 'opend:token', token }),
        () => send({ type: 'opend:token', token: '' }),
      );
    }
  });

  doc.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') api.close();
  });

  const load = () => {
    if (!frame) return;
    const url = contextUrl();
    if (frame.src !== url) frame.src = url;
  };

  const api: OpenDHelpApi = {
    init(opts) {
      options = opts;
      docsOrigin = new URL(opts.docsUrl).origin;
    },
    open(next) {
      if (!options) throw new Error('OpenDHelp.init must be called first');
      if (next) context = next;
      build();
      load();
      if (!open) {
        // Look through shadow roots: focus may be on a button inside <opend-help-button>.
        let active = doc.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        returnFocus = active as HTMLElement | null;
        open = true;
        panel!.classList.add('open');
        frame!.focus();
      }
    },
    close() {
      if (!open) return;
      open = false;
      panel?.classList.remove('open');
      returnFocus?.focus?.();
      returnFocus = null;
    },
    toggle(next) {
      if (open) api.close();
      else api.open(next);
    },
    setContext(next) {
      context = next;
      if (open) load();
    },
    isOpen: () => open,
  };
  win.OpenDHelp = api;

  if (!win.customElements.get('opend-help-button')) {
    win.customElements.define(
      'opend-help-button',
      class extends HTMLElement {
        connectedCallback() {
          if (this.shadowRoot) return;
          const root = this.attachShadow({ mode: 'open' });
          const button = doc.createElement('button');
          button.type = 'button';
          button.setAttribute('part', 'button');
          button.setAttribute('aria-label', this.getAttribute('label') ?? 'Help for this page');
          button.textContent = '?';
          const style = doc.createElement('style');
          style.textContent = `button { font: 600 14px/1 system-ui, sans-serif; width: 28px; height: 28px;
            border-radius: 50%; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }`;
          button.addEventListener('click', () => {
            const key = this.getAttribute('key');
            const path = this.getAttribute('path');
            api.toggle(key ? { key } : path ? { path } : undefined);
          });
          root.append(style, button);
        }
      },
    );
  }
}
