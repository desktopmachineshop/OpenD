import { parse as parseYaml } from 'yaml';
import {
  HELP_CONTEXTS_FILE,
  helpContextsSchema,
  walk,
  type CompiledTopic,
  type Condition,
  type ContextTarget,
  type Diagnostic,
  type HelpApp,
} from '@opend/model';
import { keyAncestry, parseRoutePattern } from '@opend/filter';
import {
  TOPIC_TYPES,
  conditionOf,
  isEmptyCondition,
  readResourceId,
  type ResourceIdRef,
} from '@opend/dita';

interface Located extends ContextTarget {
  app: string;
  key: string;
  file?: string;
  line?: number;
  column?: number;
}

/**
 * `resourceid` elements inside a compiled topic. One inside a nested topic
 * points at that topic's anchor. Conditions on the resourceid and on every
 * element around it apply; the page's own visibility is checked separately.
 */
export function topicResourceIds(topic: CompiledTopic, diagnostics: Diagnostic[]): Located[] {
  const out: Located[] = [];
  walk(topic.body, (el, ancestors) => {
    if (el.name !== 'resourceid') return;
    const parsed = readResourceId(el);
    if (typeof parsed === 'string') {
      diagnostics.push({
        severity: 'error',
        code: 'invalid-resourceid',
        message: parsed,
        file: el.loc?.file,
        line: el.loc?.line,
        column: el.loc?.column,
      });
      return;
    }
    const conditions: Condition[] = [];
    for (const node of [...ancestors.slice(1), el]) {
      const c = conditionOf(node.attrs);
      if (!isEmptyCondition(c)) conditions.push(c);
    }
    const nested = [...ancestors].reverse().find((a) => TOPIC_TYPES.has(a.name));
    const target: Located = { ...parsed, topicId: topic.id, conditions };
    if (nested && nested !== topic.body && nested.attrs.id) target.fragment = nested.attrs.id;
    if (el.loc)
      Object.assign(target, { file: el.loc.file, line: el.loc.line, column: el.loc.column });
    out.push(target);
  });
  return out;
}

function sameTarget(a: ContextTarget, b: ContextTarget): boolean {
  return a.topicId === b.topicId && a.fragment === b.fragment;
}

/**
 * Builds the per-app context index from map and topic `resourceid`s (map
 * first: maps are authoritative, as for keys) and `help-contexts.yaml`.
 */
export function buildContexts(
  mapRefs: readonly ResourceIdRef[],
  topics: readonly CompiledTopic[],
  helpContextsSource: string | undefined,
  diagnostics: Diagnostic[],
): Record<string, HelpApp> {
  const apps: Record<string, HelpApp> = {};
  const app = (name: string) => (apps[name] ??= { keys: {}, routes: [] });

  const located: Located[] = [...mapRefs];
  for (const topic of topics) located.push(...topicResourceIds(topic, diagnostics));

  for (const t of located) {
    const list = (app(t.app).keys[t.key] ??= []);
    // Two unconditional targets for one key are ambiguous: the second could never be shown.
    const clash = list.find(
      (o) => o.conditions.length === 0 && t.conditions.length === 0 && !sameTarget(o, t),
    );
    if (clash) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-context',
        message: `context ${t.app}/${t.key} already points at ${clash.topicId}; add conditions or use a different appid`,
        file: t.file,
        line: t.line,
        column: t.column,
      });
      continue;
    }
    if (
      list.some(
        (o) => sameTarget(o, t) && JSON.stringify(o.conditions) === JSON.stringify(t.conditions),
      )
    )
      continue;
    const target: ContextTarget = { topicId: t.topicId, conditions: t.conditions };
    if (t.fragment) target.fragment = t.fragment;
    list.push(target);
  }

  if (helpContextsSource !== undefined) {
    const report = (message: string) =>
      diagnostics.push({
        severity: 'error',
        code: 'invalid-help-contexts',
        message,
        file: HELP_CONTEXTS_FILE,
      });
    let raw: unknown;
    try {
      raw = parseYaml(helpContextsSource);
    } catch (err) {
      report(String(err));
      return apps;
    }
    const parsed = helpContextsSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        report(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
      return apps;
    }
    for (const [name, config] of Object.entries(parsed.data.apps)) {
      const help = app(name);
      const defined = (key: string) => keyAncestry(key).some((k) => help.keys[k]?.length);
      for (const [pattern, key] of Object.entries(config.routes)) {
        const segments = parseRoutePattern(pattern);
        if (typeof segments === 'string') {
          report(`apps.${name}.routes "${pattern}": ${segments}`);
          continue;
        }
        if (!defined(key)) {
          diagnostics.push({
            severity: 'error',
            code: 'unknown-context',
            message: `route ${pattern} maps to ${name}/${key}, but no topic has that resourceid (or a parent key)`,
            file: HELP_CONTEXTS_FILE,
          });
        }
        help.routes.push({ pattern, key });
      }
      if (config.default) {
        if (!defined(config.default)) {
          diagnostics.push({
            severity: 'error',
            code: 'unknown-context',
            message: `default for ${name} is ${config.default}, but no topic has that resourceid`,
            file: HELP_CONTEXTS_FILE,
          });
        }
        help.default = config.default;
      }
    }
  }
  return apps;
}
