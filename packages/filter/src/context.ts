import type { ContextTarget, DocNode, HelpApp, HelpRoute } from '@opend/model';
import type { ReleaseView } from './view.js';

/**
 * Route patterns map host-app paths to context keys:
 *
 *   /settings/network        literal segments
 *   /projects/:id/settings   `:name` matches one segment
 *   /files/*                 `*` matches one segment
 *   /projects/:id/vv/**      `**` (last segment only) matches zero or more segments
 *
 * Query strings, fragments and trailing slashes are ignored. When several
 * patterns match, the most specific wins: more literal segments first, then
 * patterns without `**`, then longer patterns, then file order.
 */
type Segment = { kind: 'literal'; value: string } | { kind: 'one' } | { kind: 'rest' };

export interface CompiledRoute extends HelpRoute {
  segments: Segment[];
  index: number;
}

/** Parses a route pattern, or returns an error message. */
export function parseRoutePattern(pattern: string): Segment[] | string {
  if (!pattern.startsWith('/')) return 'must start with /';
  const parts = pattern.split('/').filter(Boolean);
  const segments: Segment[] = [];
  for (const [i, part] of parts.entries()) {
    if (part === '**') {
      if (i !== parts.length - 1) return '** is only allowed as the last segment';
      segments.push({ kind: 'rest' });
    } else if (part === '*' || /^:[A-Za-z_]\w*$/.test(part)) {
      segments.push({ kind: 'one' });
    } else if (/[*:?#]/.test(part)) {
      return `invalid segment "${part}"`;
    } else {
      segments.push({ kind: 'literal', value: part.toLowerCase() });
    }
  }
  return segments;
}

function specificity(r: CompiledRoute): number[] {
  const literals = r.segments.filter((s) => s.kind === 'literal').length;
  const rest = r.segments.some((s) => s.kind === 'rest') ? 0 : 1;
  return [literals, rest, r.segments.length, -r.index];
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (b[i] ?? 0) - (a[i] ?? 0);
  return 0;
}

/** Compiles routes into match order. Invalid patterns are skipped (validation reports them). */
export function compileRoutes(routes: readonly HelpRoute[]): CompiledRoute[] {
  const compiled: CompiledRoute[] = [];
  routes.forEach((route, index) => {
    const segments = parseRoutePattern(route.pattern);
    if (typeof segments !== 'string') compiled.push({ ...route, segments, index });
  });
  return compiled.sort((a, b) => compare(specificity(a), specificity(b)));
}

/** Splits a URL path into lower-cased segments, ignoring query, fragment and empty segments. */
export function pathSegments(path: string): string[] {
  const clean = path.split(/[?#]/, 1)[0] ?? '';
  return clean
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s).toLowerCase();
      } catch {
        return s.toLowerCase();
      }
    });
}

function matches(segments: Segment[], path: string[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.kind === 'rest') return true;
    const part = path[i];
    if (part === undefined) return false;
    if (seg.kind === 'literal' && seg.value !== part) return false;
  }
  return segments.length === path.length;
}

/** The key of the most specific route matching `path`, or null. */
export function matchRoute(routes: readonly CompiledRoute[], path: string): string | null {
  const parts = pathSegments(path);
  return routes.find((r) => matches(r.segments, parts))?.key ?? null;
}

/** `a.b.c` → `[a.b.c, a.b, a]`. */
export function keyAncestry(key: string): string[] {
  const parts = key.split('.');
  return parts.map((_, i) => parts.slice(0, parts.length - i).join('.'));
}

/**
 * What the host app tells OpenD about where the reader is, most specific
 * first. Every signal is a context key, except that the view may be given as a
 * path instead.
 */
export const ACTIVITY_SIGNALS = ['focus', 'action', 'pane'] as const;
export type ActivitySignal = (typeof ACTIVITY_SIGNALS)[number];

export interface ContextRequest {
  app: string;
  /** The field or control that is selected or has focus, e.g. `settings.sso.issuer`. */
  focus?: string;
  /** The button or command the reader last pressed, e.g. `settings.sso.test`. */
  action?: string;
  /** The tab or pane the reader last worked in, e.g. `settings.sso.advanced`. */
  pane?: string;
  /** The view: a context key from the host app, e.g. `settings.network`. */
  key?: string;
  /** The view as the host app's current path, mapped to a key by `help-contexts.yaml`. */
  path?: string;
}

export interface ResolvedContext {
  topicId: string;
  fragment?: string;
  /** The key that matched, after route mapping and fallback. */
  key: string;
  /** How it was found: a signal's own key, a parent of it, or the app default. */
  via: 'key' | 'parent' | 'default';
  /** Which signal the key came from; absent when the app default answered. */
  signal?: ActivitySignal | 'view';
}

/** Longest context key or path a request may carry; longer values are ignored. */
export const MAX_CONTEXT_VALUE = 256;

/**
 * Reads a context request from query parameters (`app`, `focus`, `action`,
 * `pane`, and `key` or `path`), as the panel, the JSON API and context links
 * accept them. Empty, repeated, non-string and over-long values are ignored.
 */
export function parseContextRequest(
  query: URLSearchParams | Readonly<Record<string, unknown>>,
): ContextRequest {
  const get = (name: string): string | undefined => {
    const v =
      query instanceof URLSearchParams
        ? query.get(name)
        : Object.hasOwn(query, name)
          ? query[name]
          : undefined;
    return typeof v === 'string' && v && v.length <= MAX_CONTEXT_VALUE ? v : undefined;
  };
  const request: ContextRequest = { app: get('app') ?? '' };
  for (const signal of ACTIVITY_SIGNALS) {
    const value = get(signal);
    if (value) request[signal] = value;
  }
  const key = get('key');
  const path = get('path');
  if (key) request.key = key;
  else if (path) request.path = path;
  return request;
}

/** Whether an element with this `id` is in the tree. */
function hasElementId(node: DocNode, id: string): boolean {
  if (node.type !== 'element') return false;
  return node.attrs.id === id || node.children.some((c) => hasElementId(c, id));
}

const compiledCache = new WeakMap<HelpApp, CompiledRoute[]>();

function routesOf(app: HelpApp): CompiledRoute[] {
  let compiled = compiledCache.get(app);
  if (!compiled) {
    compiled = compileRoutes(app.routes);
    compiledCache.set(app, compiled);
  }
  return compiled;
}

/**
 * Finds the help topic for a host-app context. The signals are tried most
 * specific first: the focused field, the last action, the pane, then the view
 * (its key, or the key its path maps to), then the app default.
 *
 * Each signal falls back to its parents before the next signal is tried,
 * except parents it shares with a later signal: those wait for that signal's
 * turn, so a field's generic ancestor never beats a more specific pane.
 *
 * A target is used only when its conditions pass for this reader and its
 * topic is visible to them, so a context lookup can never reveal a hidden
 * topic: it falls back instead. A fragment is kept only when the reader's
 * filtered topic has an element with that id, so it never names a section the
 * reader cannot see.
 */
export function resolveContext(view: ReleaseView, request: ContextRequest): ResolvedContext | null {
  // Own properties only: the app and keys come from the request, and names such
  // as `__proto__` or `toString` must read as unknown, not as Object.prototype.
  const contexts = view.release.contexts;
  const app = contexts && Object.hasOwn(contexts, request.app) ? contexts[request.app] : undefined;
  if (!app) return null;
  const viewKey =
    request.key ?? (request.path !== undefined ? matchRoute(routesOf(app), request.path) : null);

  const tryKey = (key: string): ContextTarget | undefined =>
    (Object.hasOwn(app.keys, key) ? app.keys[key]! : []).find(
      (t) => view.includes(t.conditions) && view.isVisible(t.topicId),
    );

  const signals: [string, NonNullable<ResolvedContext['signal']>][] = [];
  for (const signal of ACTIVITY_SIGNALS) {
    const key = request[signal];
    if (key) signals.push([key, signal]);
  }
  if (viewKey) signals.push([viewKey, 'view']);

  type Attempt = [string, ResolvedContext['via'], ResolvedContext['signal']];
  const attempts: Attempt[] = [];
  signals.forEach(([key, signal], i) => {
    const later = new Set(signals.slice(i + 1).flatMap(([k]) => keyAncestry(k)));
    for (const [depth, k] of keyAncestry(key).entries()) {
      if (depth > 0 && later.has(k)) break;
      attempts.push([k, depth === 0 ? 'key' : 'parent', signal]);
    }
  });
  if (app.default)
    attempts.push(...keyAncestry(app.default).map((k): Attempt => [k, 'default', undefined]));

  const tried = new Set<string>();
  for (const [key, via, signal] of attempts) {
    if (tried.has(key)) continue;
    tried.add(key);
    const target = tryKey(key);
    if (target) {
      const resolved: ResolvedContext = { topicId: target.topicId, key, via };
      if (signal) resolved.signal = signal;
      const body = target.fragment ? view.topic(target.topicId)?.body : undefined;
      if (target.fragment && body && hasElementId(body, target.fragment))
        resolved.fragment = target.fragment;
      return resolved;
    }
  }
  return null;
}
