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
}

/** What the host passes to `open` and `setContext`: a context key, or its current path. */
export type HelpContext = { key: string } | { path: string };
