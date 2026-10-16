import type { ContextTarget, HelpApp, HelpRoute } from '@opend/model';
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

export interface ContextRequest {
  app: string;
  /** A context key from the host app, e.g. `settings.network`. */
  key?: string;
  /** The host app's current path, mapped to a key by `help-contexts.yaml`. */
  path?: string;
}

export interface ResolvedContext {
  topicId: string;
  fragment?: string;
  /** The key that matched, after route mapping and fallback. */
  key: string;
  /** How it was found: the requested key, a parent key, or the app default. */
  via: 'key' | 'parent' | 'default';
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
 * Finds the help topic for a host-app context. Tries the key (or the key the
 * path maps to), then its parents, then the app default. A target is used only
 * when its conditions pass for this reader and its topic is visible to them,
 * so a context lookup can never reveal a hidden topic: it falls back instead.
 */
export function resolveContext(view: ReleaseView, request: ContextRequest): ResolvedContext | null {
  // Own properties only: the app and key come from the request, and names such
  // as `__proto__` or `toString` must read as unknown, not as Object.prototype.
  const contexts = view.release.contexts;
  const app = contexts && Object.hasOwn(contexts, request.app) ? contexts[request.app] : undefined;
  if (!app) return null;
  const requested =
    request.key ?? (request.path !== undefined ? matchRoute(routesOf(app), request.path) : null);

  const tryKey = (key: string): ContextTarget | undefined =>
    (Object.hasOwn(app.keys, key) ? app.keys[key]! : []).find(
      (t) => view.includes(t.conditions) && view.isVisible(t.topicId),
    );

  const attempts: [string, ResolvedContext['via']][] = [];
  if (requested)
    keyAncestry(requested).forEach((k, i) => attempts.push([k, i === 0 ? 'key' : 'parent']));
  if (app.default)
    attempts.push(...keyAncestry(app.default).map((k): [string, 'default'] => [k, 'default']));

  for (const [key, via] of attempts) {
    const target = tryKey(key);
    if (target) {
      const resolved: ResolvedContext = { topicId: target.topicId, key, via };
      if (target.fragment) resolved.fragment = target.fragment;
      return resolved;
    }
  }
  return null;
}
