/**
 * Messages between the host page (widget) and the help iframe. Both sides
 * check `event.origin` and `event.source`, and send with an explicit target
 * origin, never `*`.
 */
export const PROTOCOL = 'opend-help';
export const PROTOCOL_VERSION = 1;

export type HostToFrame = { type: 'opend:token'; token: string };

export type FrameToHost =
  | { type: 'opend:ready' }
  | { type: 'opend:need-token' }
  | { type: 'opend:navigated'; topicId: string; title: string }
  | { type: 'opend:close' }
  | { type: 'opend:error'; message: string };

export type Envelope<T> = T & { protocol: typeof PROTOCOL; v: typeof PROTOCOL_VERSION };

export interface WidgetOptions {
  /** Base URL of the OpenD docs site, e.g. https://docs.example.com */
  docsUrl: string;
  /** Host app name, as used in `resourceid appname` and help-contexts.yaml. */
  app: string;
  /**
   * Returns a fresh embed token from the host app's backend. Called when the
   * help frame has no session. Omit for previews or public docs.
   */
  getToken?: () => Promise<string>;
  /** Drawer width in pixels on wide screens. Default 380. */
  width?: number;
  side?: 'right' | 'left';
  zIndex?: number;
  /** Called when the reader navigates inside the help panel. */
  onNavigate?: (topic: { topicId: string; title: string }) => void;
  /**
   * Watch focus and clicks for `data-help-key` and `data-help-pane` attributes,
   * and send what they say with every help request. Default true; elements
   * without those attributes are never reported.
   */
  activity?: boolean;
  /**
   * While the panel is open, move it to the help for the reader's new focus,
   * action or pane, until the reader navigates inside the panel. Default true.
   */
  follow?: boolean;
}

/** What the host passes to `open` and `setContext`: the view, as a context key or its current path. */
export type HelpContext = { key: string } | { path: string };

/**
 * What the reader is doing inside the view, most specific first. Each is a
 * context key; `null` clears it.
 */
export interface Activity {
  /** The field or control that is selected or has focus. */
  focus?: string | null;
  /** The button or command the reader last pressed. */
  action?: string | null;
  /** The tab or pane the reader last worked in. */
  pane?: string | null;
}

/** Everything a help request carries, as query parameters for `/embed/context` or the JSON API. */
export interface ContextQuery {
  focus?: string;
  action?: string;
  pane?: string;
  key?: string;
  path?: string;
}
