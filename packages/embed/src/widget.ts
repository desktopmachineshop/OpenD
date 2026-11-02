import type { Activity, ContextQuery, HelpContext, WidgetOptions } from './protocol.js';

export interface OpenDHelpApi {
  init(options: WidgetOptions): void;
  /**
   * Opens the panel. Without a context it opens the help for what the reader
   * is doing (focus, last action, pane, then the view); with one it opens that
   * context exactly, sets it as the view, and ignores activity until closed.
   */
  open(context?: HelpContext): void;
  close(): void;
  toggle(context?: HelpContext): void;
  /** Tells the widget which view the user is on; call it on every route change. */
  setContext(context: HelpContext): void;
  /** Records focus, action or pane for apps that track them themselves. */
  setActivity(activity: Activity): void;
  /** The current signals, as query parameters for the JSON API. */
  activity(): ContextQuery;
  isOpen(): boolean;
}

/**
 * The host-page widget: `window.OpenDHelp` and the `<opend-help-button>`
 * element. Served as a standalone script, so it must not reference anything
 * outside its own body (types are erased; no imports, no module scope).
 *
 * Activity tracking reads two attributes the host app puts on its markup:
 *
 *   data-help-key="settings.sso.issuer"   a field, control or group of them:
 *                                         focus inside sets `focus`; pressing a
 *                                         button, link, tab or menu item inside
 *                                         sets `action`
 *   data-help-pane="settings.sso.advanced"  a tab panel, pane or dialog (or the
 *                                         tab that shows it): focus or a press
 *                                         inside sets `pane`
 *
 * Only those keys leave the page, never values, text or element ids. Events
 * on the help button and panel are ignored, so opening help keeps the
 * reader's place. Focus moving to an element without a key clears `focus`;
 * `action` and `pane` are kept until the view changes.
 */
export function installWidget(win: Window & { OpenDHelp?: OpenDHelpApi }): void {
  if (win.OpenDHelp) return;
  const doc = win.document;
  const KEY = 'data-help-key';
  const PANE = 'data-help-pane';
  const PRESSABLE =
    'button, a[href], summary, input[type=button], input[type=submit], input[type=reset], input[type=image], input[type=checkbox], input[type=radio], [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=switch], [role=checkbox], [role=radio]';
  const MAX = 256;

  let options: WidgetOptions | null = null;
  let docsOrigin = '';
  let context: HelpContext | null = null;
  const signals: { focus: string | null; action: string | null; pane: string | null } = {
    focus: null,
    action: null,
    pane: null,
  };
  let host: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  let frame: HTMLIFrameElement | null = null;
  let open = false;
  let returnFocus: HTMLElement | null = null;
  // Opened on an explicit context: activity is ignored until the panel closes.
  let explicit = false;
  // The reader navigated inside the panel: stop following activity until reopened.
  let pinned = false;
  // The next `opend:ready` is the page this widget asked for.
  let expectReady = false;
  let followTimer: ReturnType<typeof setTimeout> | undefined;

  const clean = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() && value.length <= MAX ? value.trim() : null;

  const isElement = (n: Node | null | undefined): n is Element => n?.nodeType === 1;
  /** The parent node, or the host of a shadow root, so walks cross into the light DOM. */
  const parentOf = (n: Node): Node | null =>
    n.parentNode ?? (n.nodeType === 11 && 'host' in n ? (n as ShadowRoot).host : null);

  /** Walks up from `node` to the nearest element with `attr`, crossing shadow roots. */
  const findUp = (node: Node | null, attr: string): Element | null => {
    for (let n = node; n; n = parentOf(n)) if (isElement(n) && n.hasAttribute(attr)) return n;
    return null;
  };

  /** Whether the node belongs to the help UI itself. */
  const isHelpUi = (node: Node | null): boolean => {
    for (let n = node; n; n = parentOf(n))
      if (
        isElement(n) &&
        (n.hasAttribute('data-opend-help') || n.localName === 'opend-help-button')
      )
        return true;
    return false;
  };

  const deepActive = (): Element | null => {
    let active = doc.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };

  const query = (withActivity: boolean): ContextQuery => {
    const q: ContextQuery = {};
    if (withActivity) {
      if (signals.focus) q.focus = signals.focus;
      if (signals.action) q.action = signals.action;
      if (signals.pane) q.pane = signals.pane;
    }
    if (context && 'key' in context) q.key = context.key;
    else if (context && 'path' in context) q.path = context.path;
    return q;
  };

  const contextUrl = (): string => {
    const base = options!.docsUrl.replace(/\/$/, '');
    const params = new URLSearchParams({ app: options!.app, host: win.location.origin });
    for (const [k, v] of Object.entries(query(!explicit))) params.set(k, v as string);
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
    else if (msg.type === 'opend:ready') {
      if (expectReady) expectReady = false;
      else pinned = true;
    } else if (msg.type === 'opend:navigated' && msg.topicId) {
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
    if (frame.src !== url) {
      expectReady = true;
      frame.src = url;
    }
  };

  /** After activity changes: move an open panel along, unless the reader has taken over. */
  const follow = () => {
    if (!open || explicit || pinned || options?.follow === false) return;
    clearTimeout(followTimer);
    followTimer = setTimeout(load, 250);
  };

  const tracking = () => options !== null && options.activity !== false;

  /** Focus and pane from `target`; the help UI never counts, so opening help keeps them. */
  const readFocus = (target: Node | null) => {
    if (isHelpUi(target)) return;
    signals.focus = clean(findUp(target, KEY)?.getAttribute(KEY));
    const pane = clean(findUp(target, PANE)?.getAttribute(PANE));
    if (pane) signals.pane = pane;
  };

  doc.addEventListener(
    'focusin',
    (event) => {
      const target = (event.composedPath()[0] as Node | undefined) ?? null;
      if (!tracking()) return;
      const before = `${signals.focus}|${signals.pane}`;
      readFocus(target);
      if (`${signals.focus}|${signals.pane}` !== before) follow();
    },
    true,
  );

  doc.addEventListener(
    'click',
    (event) => {
      const target = (event.composedPath()[0] as Node | undefined) ?? null;
      if (!tracking() || isHelpUi(target)) return;
      const before = `${signals.action}|${signals.pane}`;
      const element = isElement(target) ? target : target?.parentElement;
      const pressed = element?.closest(PRESSABLE) ?? null;
      if (pressed) {
        const action = clean(findUp(pressed, KEY)?.getAttribute(KEY));
        if (action) signals.action = action;
      }
      const pane = clean(findUp(target, PANE)?.getAttribute(PANE));
      if (pane) signals.pane = pane;
      if (`${signals.action}|${signals.pane}` !== before) follow();
    },
    true,
  );

  const sameContext = (a: HelpContext | null, b: HelpContext | null): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  const api: OpenDHelpApi = {
    init(opts) {
      options = opts;
      docsOrigin = new URL(opts.docsUrl).origin;
      if (tracking()) readFocus(deepActive());
    },
    open(next) {
      if (!options) throw new Error('OpenDHelp.init must be called first');
      if (!open) pinned = false;
      if (next) {
        explicit = true;
        context = next;
      }
      build();
      load();
      if (!open) {
        // Look through shadow roots: focus may be on a button inside <opend-help-button>.
        returnFocus = deepActive() as HTMLElement | null;
        open = true;
        panel!.classList.add('open');
        frame!.focus();
      }
    },
    close() {
      if (!open) return;
      open = false;
      explicit = false;
      clearTimeout(followTimer);
      panel?.classList.remove('open');
      returnFocus?.focus?.();
      returnFocus = null;
    },
    toggle(next) {
      if (open) api.close();
      else api.open(next);
    },
    setContext(next) {
      if (!sameContext(context, next)) {
        // A new view: the last action and pane belonged to the old one.
        signals.action = null;
        signals.pane = null;
        if (tracking()) readFocus(deepActive());
      }
      context = next;
      if (open) load();
    },
    setActivity(next) {
      for (const signal of ['focus', 'action', 'pane'] as const) {
        if (next[signal] !== undefined) signals[signal] = clean(next[signal]);
      }
      follow();
    },
    activity: () => query(true),
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
