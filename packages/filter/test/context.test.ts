import { describe, expect, it } from 'vitest';
import { element, text, type CompiledRelease, type CompiledTopic } from '@opend/model';
import {
  compileRoutes,
  keyAncestry,
  matchRoute,
  parseRoutePattern,
  pathSegments,
  readerPolicy,
  resolveContext,
  viewRelease,
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
  const topic = (id: string, attrs: Record<string, string> = {}): CompiledTopic => ({
    id,
    file: `${id}.dita`,
    ditaId: id,
    type: 'topic',
    title: id,
    body: element('topic', { id, ...attrs }, [element('title', {}, [text(id)])]),
  });
  const release: CompiledRelease = {
    schemaVersion: 1,
    release: '2.1',
    title: 'Docs',
    builtAt: '2026-10-16T00:00:00Z',
    attributes: {},
    nav: ['overview', 'settings', 'sso', 'gadget', 'notes1', 'notes2'].map((id) => ({
      title: id,
      topicId: id,
      condition: {},
      kind: 'topicref',
      children: [],
    })),
    publications: [],
    topics: {
      overview: topic('overview'),
      settings: topic('settings'),
      sso: topic('sso', { feature: 'sso' }),
      gadget: topic('gadget', { product: 'gadget' }),
      notes1: topic('notes1'),
      notes2: topic('notes2'),
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
          'settings.sso': [{ topicId: 'sso', fragment: 'setup', conditions: [] }],
          'devices.gadget': [{ topicId: 'gadget', conditions: [] }],
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
