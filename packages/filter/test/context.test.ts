import { describe, expect, it } from 'vitest';
import { element, text, type CompiledRelease, type CompiledTopic } from '@opend/model';
import {
  compileRoutes,
  keyAncestry,
  matchRoute,
  parseRoutePattern,
  pathSegments,
  readerPolicy,
  MAX_CONTEXT_VALUE,
  parseContextRequest,
  resolveContext,
  viewRelease,
  type ContextRequest,
} from '../src/index.js';

describe('route patterns', () => {
  it.each([
    ['settings', 'must start with /'],
    ['/a/**/b', '** is only allowed as the last segment'],
    ['/a/b*', 'invalid segment "b*"'],
    ['/a/:1x', 'invalid segment ":1x"'],
  ])('rejects %s', (pattern, message) => {
    expect(parseRoutePattern(pattern)).toBe(message);
  });

  const routes = compileRoutes([
    { pattern: '/projects/**', key: 'projects' },
    { pattern: '/projects/:id/settings', key: 'settings' },
    { pattern: '/projects/:id/settings/network', key: 'settings.network' },
    { pattern: '/projects/:id/*', key: 'project-page' },
    { pattern: '/', key: 'home' },
    { pattern: '/bad/**/x', key: 'never' },
  ]);

  it.each([
    ['/', 'home'],
    ['/projects/42/settings/network', 'settings.network'],
    ['/projects/42/settings/', 'settings'],
    ['/Projects/42/Settings?tab=1#x', 'settings'],
    ['/projects/42/board', 'project-page'],
    ['/projects/42/vv/runs/7', 'projects'],
    ['/projects', 'projects'],
    ['/elsewhere', null],
  ])('%s → %s', (path, key) => {
    expect(matchRoute(routes, path)).toBe(key);
  });

  it('normalises paths and builds key ancestry', () => {
    expect(pathSegments('/a%20b//C/?q#h')).toEqual(['a b', 'c']);
    expect(keyAncestry('settings.network.proxy')).toEqual([
      'settings.network.proxy',
      'settings.network',
      'settings',
    ]);
  });
});

describe('resolveContext', () => {
  const topic = (
    id: string,
    attrs: Record<string, string> = {},
    sections: Record<string, string>[] = [],
  ): CompiledTopic => ({
    id,
    file: `${id}.dita`,
    ditaId: id,
    type: 'topic',
    title: id,
    body: element('topic', { id, ...attrs }, [
      element('title', {}, [text(id)]),
      element(
        'body',
        {},
        sections.map((a) => element('section', a, [text(a.id ?? '')])),
      ),
    ]),
  });
  const release: CompiledRelease = {
    schemaVersion: 1,
    release: '2.1',
    title: 'Docs',
    builtAt: '2026-10-16T00:00:00Z',
    attributes: {},
    nav: [
      'overview',
      'settings',
      'sso',
      'gadget',
      'notes1',
      'notes2',
      'issuer',
      'advanced',
      'export',
      'secret',
    ].map((id) => ({
      title: id,
      topicId: id,
      condition: {},
      kind: 'topicref',
      children: [],
    })),
    publications: [],
    topics: {
      overview: topic('overview'),
      settings: topic('settings', {}, [{ id: 'audit-retention', feature: 'audit-log' }]),
      sso: topic('sso', { feature: 'sso' }, [{ id: 'setup' }]),
      gadget: topic('gadget', { product: 'gadget' }),
      notes1: topic('notes1'),
      notes2: topic('notes2'),
      issuer: topic('issuer'),
      advanced: topic('advanced'),
      export: topic('export'),
      secret: topic('secret', { feature: 'secret' }),
    },
    chunkUsage: {},
    assets: [],
    contexts: {
      console: {
        default: 'overview',
        routes: [
          { pattern: '/settings/**', key: 'settings' },
          { pattern: '/settings/sso', key: 'settings.sso' },
          { pattern: '/devices/:id/pair', key: 'devices.gadget' },
        ],
        keys: {
          overview: [{ topicId: 'overview', conditions: [] }],
          settings: [{ topicId: 'settings', conditions: [] }],
          'settings.retention': [
            { topicId: 'settings', fragment: 'audit-retention', conditions: [] },
          ],
          'settings.missing': [{ topicId: 'settings', fragment: 'no-such-id', conditions: [] }],
          'settings.sso': [{ topicId: 'sso', fragment: 'setup', conditions: [] }],
          'devices.gadget': [{ topicId: 'gadget', conditions: [] }],
          'settings.sso.issuer': [{ topicId: 'issuer', conditions: [] }],
          'settings.sso.advanced': [{ topicId: 'advanced', conditions: [] }],
          'settings.sso.secret': [{ topicId: 'secret', conditions: [] }],
          'export.csv': [{ topicId: 'export', conditions: [] }],
          'whats-new': [
            { topicId: 'notes1', conditions: [{ release: '1' }] },
            { topicId: 'notes2', conditions: [{ release: '2' }] },
          ],
        },
      },
    },
  };

  const view = (products: string[], features: string[], version: string) =>
    viewRelease(release, [readerPolicy({ products, features, version })]);
  const pro = view(['widget', 'gadget'], ['sso'], '2.1');
  const basicV1 = view(['widget'], [], '1.4');

  it('resolves keys and paths for a reader who can see the target', () => {
    expect(resolveContext(pro, { app: 'console', key: 'settings.sso' })).toEqual({
      topicId: 'sso',
      fragment: 'setup',
      key: 'settings.sso',
      via: 'key',
      signal: 'view',
    });
    expect(resolveContext(pro, { app: 'console', path: '/devices/7/pair' })).toMatchObject({
      topicId: 'gadget',
    });
    expect(resolveContext(pro, { app: 'console', path: '/settings/sso' })).toMatchObject({
      topicId: 'sso',
    });
  });

  it('falls back to a parent key, then the default, when the reader cannot see the target', () => {
    expect(resolveContext(basicV1, { app: 'console', key: 'settings.sso' })).toEqual({
      topicId: 'settings',
      key: 'settings',
      via: 'parent',
      signal: 'view',
    });
    expect(resolveContext(basicV1, { app: 'console', path: '/devices/7/pair' })).toEqual({
      topicId: 'overview',
      key: 'overview',
      via: 'default',
    });
    expect(resolveContext(basicV1, { app: 'console', key: 'unknown.key' })).toMatchObject({
      via: 'default',
    });
    expect(resolveContext(basicV1, { app: 'console', path: '/nowhere' })).toMatchObject({
      topicId: 'overview',
    });
  });

  it('picks the target whose conditions pass for this reader', () => {
    expect(resolveContext(basicV1, { app: 'console', key: 'whats-new' })?.topicId).toBe('notes1');
    expect(resolveContext(pro, { app: 'console', key: 'whats-new' })?.topicId).toBe('notes2');
  });

  it('keeps a fragment only when the reader sees an element with that id', () => {
    const audit = view(['widget'], ['audit-log'], '2.1');
    expect(resolveContext(audit, { app: 'console', key: 'settings.retention' })).toEqual({
      topicId: 'settings',
      fragment: 'audit-retention',
      key: 'settings.retention',
      via: 'key',
      signal: 'view',
    });
    // The section is filtered out for this reader, so its id must not leak.
    expect(resolveContext(pro, { app: 'console', key: 'settings.retention' })).toEqual({
      topicId: 'settings',
      key: 'settings.retention',
      via: 'key',
      signal: 'view',
    });
    expect(resolveContext(audit, { app: 'console', key: 'settings.missing' })).toEqual({
      topicId: 'settings',
      key: 'settings.missing',
      via: 'key',
      signal: 'view',
    });
  });

  describe('activity signals', () => {
    const resolve = (request: Omit<ContextRequest, 'app'>, v = pro) =>
      resolveContext(v, { app: 'console', ...request });

    it('prefers focus, then the last action, then the pane, then the view', () => {
      const all = {
        focus: 'settings.sso.issuer',
        action: 'export.csv',
        pane: 'settings.sso.advanced',
        key: 'settings',
      };
      expect(resolve(all)).toEqual({
        topicId: 'issuer',
        key: all.focus,
        via: 'key',
        signal: 'focus',
      });
      const { focus: _f, ...noFocus } = all;
      expect(resolve(noFocus)).toMatchObject({ topicId: 'export', signal: 'action' });
      const { action: _a, ...paneAndView } = noFocus;
      expect(resolve(paneAndView)).toMatchObject({ topicId: 'advanced', signal: 'pane' });
      expect(resolve({ key: 'settings' })).toMatchObject({ topicId: 'settings', signal: 'view' });
    });

    it('falls back to a signal’s parents before the next signal', () => {
      expect(
        resolve({ focus: 'settings.sso.issuer.hint', action: 'export.csv', key: 'overview' }),
      ).toEqual({ topicId: 'issuer', key: 'settings.sso.issuer', via: 'parent', signal: 'focus' });
      // settings.sso is the field's own section: it beats an unrelated action.
      expect(
        resolve({ focus: 'settings.sso.nofield', action: 'export.csv', key: 'overview' }),
      ).toMatchObject({ topicId: 'sso', key: 'settings.sso', via: 'parent', signal: 'focus' });
    });

    it('leaves a parent shared with a later signal to that signal', () => {
      // settings.sso is also the pane's parent, so the more specific pane wins first.
      expect(resolve({ focus: 'settings.sso.nofield', pane: 'settings.sso.advanced' })).toEqual({
        topicId: 'advanced',
        key: 'settings.sso.advanced',
        via: 'key',
        signal: 'pane',
      });
      expect(resolve({ focus: 'settings.sso.nofield', key: 'settings.sso' })).toMatchObject({
        key: 'settings.sso',
        via: 'key',
        signal: 'view',
      });
    });

    it('maps a path view under the signals, and ends at the default', () => {
      expect(resolve({ focus: 'nope', path: '/devices/7/pair' })).toMatchObject({
        topicId: 'gadget',
        signal: 'view',
      });
      expect(resolve({ focus: 'nope', action: 'also.nope' })).toEqual({
        topicId: 'overview',
        key: 'overview',
        via: 'default',
      });
    });

    it('never opens a hidden topic for a signal: it falls back', () => {
      expect(
        resolve({ focus: 'settings.sso.secret', pane: 'settings.sso.advanced' }),
      ).toMatchObject({ topicId: 'advanced', signal: 'pane' });
      expect(resolve({ action: 'settings.sso.secret' })).toMatchObject({
        topicId: 'sso',
        via: 'parent',
      });
      const insider = view(['widget'], ['sso', 'secret'], '2.1');
      expect(resolve({ action: 'settings.sso.secret' }, insider)).toMatchObject({
        topicId: 'secret',
        signal: 'action',
      });
    });
  });

  describe('parseContextRequest', () => {
    it('reads the signals and the view from query parameters', () => {
      expect(
        parseContextRequest(
          new URLSearchParams('app=console&focus=a.b&action=c&pane=d&key=e&path=/f'),
        ),
      ).toEqual({ app: 'console', focus: 'a.b', action: 'c', pane: 'd', key: 'e' });
      expect(parseContextRequest({ app: 'console', path: '/f' })).toEqual({
        app: 'console',
        path: '/f',
      });
    });

    it('ignores empty, repeated, non-string and over-long values', () => {
      expect(
        parseContextRequest({
          app: ['a', 'b'],
          focus: '',
          action: 'x'.repeat(MAX_CONTEXT_VALUE + 1),
          pane: { toString: () => 'p' },
          key: 'ok',
        }),
      ).toEqual({ app: '', key: 'ok' });
      expect(parseContextRequest(JSON.parse('{"__proto__": {"focus": "x"}}'))).toEqual({ app: '' });
    });
  });

  it('treats Object.prototype names as unknown apps and keys', () => {
    for (const app of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(resolveContext(pro, { app, key: 'overview' }), app).toBeNull();
    }
    for (const key of ['__proto__', 'constructor', 'toString', 'valueOf.x']) {
      expect(resolveContext(pro, { app: 'console', key }), key).toEqual({
        topicId: 'overview',
        key: 'overview',
        via: 'default',
      });
    }
  });

  it('returns null for unknown apps, or when nothing is visible', () => {
    expect(resolveContext(pro, { app: 'other', key: 'overview' })).toBeNull();
    const noDefault = {
      ...release,
      contexts: { console: { ...release.contexts!.console!, default: undefined } },
    };
    delete noDefault.contexts.console.default;
    const v = viewRelease(noDefault as CompiledRelease, [
      readerPolicy({ products: [], features: [], version: '2.0' }),
    ]);
    expect(resolveContext(v, { app: 'console', key: 'devices.gadget' })).toBeNull();
  });
});
