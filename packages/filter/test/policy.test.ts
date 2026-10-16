import { describe, expect, it } from 'vitest';
import { element, text, type CompiledRelease, type ReaderContext } from '@opend/model';
import {
  ditavalPolicy,
  filterTree,
  isIncluded,
  readerPolicy,
  viewRelease,
  type FilterPolicy,
} from '../src/index.js';

const reader = (ctx: Partial<ReaderContext> & { version: string }) =>
  readerPolicy({ products: [], features: [], ...ctx });

const v1Widget = reader({ products: ['widget'], version: '1.4' });
const v2Pro = reader({ products: ['widget', 'gadget'], features: ['sso'], version: '2.1' });

describe('isIncluded with a reader policy', () => {
  it.each<[string, Record<string, string>, FilterPolicy, boolean]>([
    ['no filtering attributes', { id: 'x', outputclass: 'y' }, v1Widget, true],
    ['held product', { product: 'widget' }, v1Widget, true],
    ['unheld product', { product: 'gadget' }, v1Widget, false],
    ['OR within an attribute', { product: 'gadget widget' }, v1Widget, true],
    ['AND across attributes: one fails', { product: 'widget', feature: 'sso' }, v1Widget, false],
    ['AND across attributes: both pass', { product: 'widget', feature: 'sso' }, v2Pro, true],
    ['release in range', { release: '1.2..1.9' }, v1Widget, true],
    ['release out of range', { release: '2.0..' }, v1Widget, false],
    ['release OR of tokens', { release: '1.0 1.4' }, v1Widget, true],
    ['fail-closed: undeclared product', { product: 'typo-widget' }, v2Pro, false],
    ['fail-closed: unparseable release', { release: 'next' }, v2Pro, false],
    ['empty attribute value is ignored', { product: '  ' }, v1Widget, true],
    ['build-time attributes are not governed by readers', { audience: 'admin' }, v1Widget, true],
  ])('%s', (_label, attrs, policy, expected) => {
    expect(isIncluded(attrs, [policy])).toBe(expected);
  });

  it('fails closed when the reader version is unparseable', () => {
    expect(isIncluded({ release: '1' }, [reader({ version: 'latest' })])).toBe(false);
    expect(
      isIncluded({ product: 'widget' }, [reader({ products: ['widget'], version: 'latest' })]),
    ).toBe(true);
  });
});

describe('ditavalPolicy', () => {
  it('applies the most specific rule', () => {
    const p = ditavalPolicy([
      { action: 'exclude' },
      { att: 'audience', action: 'include' },
      { att: 'audience', val: 'internal', action: 'exclude' },
      { att: 'platform', val: 'linux', action: 'flag' },
    ]);
    expect(p.decide('audience', 'internal')).toBe('exclude');
    expect(p.decide('audience', 'admin')).toBe('include');
    expect(p.decide('platform', 'linux')).toBe('include');
    expect(p.decide('platform', 'windows')).toBe('exclude');
  });

  it('combines with a reader policy: every policy must include', () => {
    const build = ditavalPolicy([{ att: 'audience', val: 'internal', action: 'exclude' }]);
    expect(isIncluded({ audience: 'internal', product: 'widget' }, [build, v1Widget])).toBe(false);
    expect(isIncluded({ audience: 'admin', product: 'widget' }, [build, v1Widget])).toBe(true);
    expect(isIncluded({ audience: 'admin', product: 'gadget' }, [build, v1Widget])).toBe(false);
  });
});

describe('filterTree', () => {
  const tree = element('topic', { id: 't' }, [
    element('p', {}, [text('everyone')]),
    element('section', { product: 'gadget' }, [
      element('p', {}, [text('gadget only')]),
      element('p', { product: 'widget' }, [text('nested widget')]),
    ]),
    element('p', { release: '2.0..' }, [text('v2 only')]),
  ]);

  it('removes excluded elements and their descendants', () => {
    const out = filterTree(tree, [v1Widget]);
    expect(JSON.stringify(out)).toContain('everyone');
    expect(JSON.stringify(out)).not.toContain('gadget only');
    // Ancestor exclusion wins even when the descendant's own condition passes.
    expect(JSON.stringify(out)).not.toContain('nested widget');
    expect(JSON.stringify(out)).not.toContain('v2 only');
  });

  it('returns null when the root is excluded', () => {
    expect(filterTree(element('topic', { feature: 'sso' }), [v1Widget])).toBeNull();
  });

  it('keeps everything with no policies', () => {
    expect(filterTree(tree, [])).toEqual(tree);
  });

  it('keeps only the first surviving alternative of a choice', () => {
    const choice = element('opend-choice', {}, [
      element('opend-cond', { product: 'gadget' }, [text('Gadget')]),
      element('opend-cond', { product: 'widget' }, [text('Widget')]),
      element('opend-cond', {}, [text('Fallback')]),
    ]);
    expect(JSON.stringify(filterTree(choice, [v1Widget]))).toContain('Widget');
    expect(JSON.stringify(filterTree(choice, [v1Widget]))).not.toContain('Fallback');
    expect(JSON.stringify(filterTree(choice, [reader({ version: '1' })]))).toContain('Fallback');
  });

  it('can keep every surviving alternative, for build-time filtering', () => {
    const choice = element('opend-choice', {}, [
      element('opend-cond', { audience: 'internal' }, [text('Internal')]),
      element('opend-cond', { feature: 'sso' }, [text('Enterprise')]),
      element('opend-cond', {}, [text('Standard')]),
    ]);
    const build = ditavalPolicy([{ att: 'audience', val: 'internal', action: 'exclude' }]);
    const out = filterTree(choice, [build], { resolveChoices: false });
    expect(out?.children.map((c) => JSON.stringify(c))).toEqual([
      expect.stringContaining('Enterprise'),
      expect.stringContaining('Standard'),
    ]);
  });
});

describe('viewRelease', () => {
  const topic = (id: string, attrs: Record<string, string> = {}) => ({
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
    nav: [
      { title: 'a', topicId: 'a', condition: {}, kind: 'topicref', children: [] },
      {
        title: 'gadget',
        condition: { product: 'gadget' },
        kind: 'topichead',
        children: [{ title: 'b', topicId: 'b', condition: {}, kind: 'topicref', children: [] }],
      },
      { title: 'c', topicId: 'c', condition: {}, kind: 'topicref', children: [] },
    ],
    publications: [],
    topics: {
      a: topic('a'),
      b: topic('b'),
      c: topic('c', { release: '2.0..' }),
      orphan: topic('orphan'),
    },
    chunkUsage: {},
    assets: [],
  };

  it('filters navigation and pages with the same policy', () => {
    const view = viewRelease(release, [v1Widget]);
    expect(view.nav.map((e) => e.title)).toEqual(['a', 'c']);
    expect(view.isVisible('b')).toBe(false); // under an excluded topichead
    expect(view.isVisible('c')).toBe(false); // topic root excluded
    expect(view.topicIds()).toEqual(['a']);
  });

  it('never publishes topics that are not in the navigation', () => {
    expect(viewRelease(release, []).isVisible('orphan')).toBe(false);
    expect(viewRelease(release, []).topicIds()).toEqual(['a', 'b', 'c']);
  });
});
