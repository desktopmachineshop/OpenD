import { describe, expect, it } from 'vitest';
import { SYNTHETIC, element, text, type ReaderContext } from '@opend/model';
import {
  filterTree,
  gatesPass,
  readerPolicy,
  searchSegments,
  searchText,
  type FilterPolicy,
} from '../src/index.js';

const body = element('task', { id: 't', audience: 'admin internal' }, [
  element('title', {}, [
    text('Pair '),
    element('ph', { product: 'gadget' }, [text('the Gadget')]),
    element('ph', { product: 'widget' }, [text('the Widget')]),
  ]),
  element('shortdesc', {}, [text('Connect a device.')]),
  element('taskbody', {}, [
    element('p', {}, [text('Common step.')]),
    element('section', { feature: 'sso' }, [
      element('p', {}, [text('Sign-on step.')]),
      element('p', { release: '2.0..' }, [text('Provisioning step.')]),
    ]),
    element(SYNTHETIC.choice, {}, [
      element(SYNTHETIC.cond, { product: 'gadget' }, [text('Gadget restart.')]),
      element(SYNTHETIC.cond, { product: 'widget' }, [text('Widget restart.')]),
      element(SYNTHETIC.cond, {}, [text('Generic restart.')]),
    ]),
    element('p', {}, [text('Closing words.')]),
  ]),
]);

const readers: ReaderContext[] = [
  { products: [], features: [], version: '1.0' },
  { products: ['widget'], features: [], version: '1.4' },
  { products: ['gadget'], features: ['sso'], version: '1.4' },
  { products: ['widget', 'gadget'], features: ['sso'], version: '2.1' },
  { products: ['widget'], features: ['sso'], version: '2.1' },
];

const words = (s: string) => s.split(/\s+/).filter(Boolean);

describe('searchSegments', () => {
  it('splits text by condition and weight', () => {
    const segments = searchSegments(body);
    expect(segments.map((s) => [s.weight, s.text])).toEqual([
      ['A', 'Pair'],
      ['A', 'the Gadget'],
      ['A', 'the Widget'],
      ['B', 'Connect a device.'],
      ['C', 'Common step.'],
      ['C', 'Sign-on step.'],
      ['C', 'Provisioning step.'],
      ['C', 'Gadget restart.'],
      ['C', 'Widget restart.'],
      ['C', 'Generic restart.'],
      ['C', 'Closing words.'],
    ]);
    // The topic root's own conditions apply to everything.
    expect(segments[0]!.gates).toEqual([{ attrs: { audience: 'admin internal' } }]);
    expect(segments[6]!.gates).toEqual([
      { attrs: { audience: 'admin internal' } },
      { attrs: { feature: 'sso' } },
      { attrs: { release: '2.0..' } },
    ]);
    expect(segments[9]!.gates.at(-1)).toEqual({
      choice: [{ product: 'gadget' }, { product: 'widget' }, {}],
    });
  });

  it('separates text at element boundaries', () => {
    const tight = element('topic', {}, [
      element('title', {}, [text('Limits')]),
      element('body', {}, [element('p', {}, [text('one')]), element('p', {}, [text('two')])]),
    ]);
    expect(searchText(tight)).toEqual({ title: 'Limits', shortdesc: '', body: 'one two' });
  });

  // The index decides with gates what filterTree decides with the tree: the
  // segments a reader passes are exactly the text of their filtered topic.
  it.each(readers)('agrees with filterTree for %j', (reader) => {
    const policies: FilterPolicy[] = [readerPolicy(reader)];
    // audience is not an entitlement attribute, so the reader policy keeps the root.
    const filtered = filterTree(body, policies)!;
    const passed = searchSegments(body).filter((s) => gatesPass(s.gates, policies));
    const expected = searchSegments(filtered);
    expect(passed.map((s) => [s.weight, s.text])).toEqual(expected.map((s) => [s.weight, s.text]));
    expect(words(passed.map((s) => s.text).join(' '))).toEqual(
      words(Object.values(searchText(filtered)).join(' ')),
    );
  });

  it('keeps only the first surviving alternative, unless choices are left unresolved', () => {
    const gadget = [readerPolicy({ products: ['gadget', 'widget'], features: [], version: '2.1' })];
    const gates = searchSegments(body).map((s) => s.gates);
    const restarts = gates.slice(7, 10);
    expect(restarts.map((g) => gatesPass(g, gadget))).toEqual([true, false, false]);
    expect(restarts.map((g) => gatesPass(g, gadget, { resolveChoices: false }))).toEqual([
      true,
      true,
      true,
    ]);
    const nobody = [readerPolicy({ products: [], features: [], version: '2.1' })];
    expect(restarts.map((g) => gatesPass(g, nobody))).toEqual([false, false, true]);
  });
});
