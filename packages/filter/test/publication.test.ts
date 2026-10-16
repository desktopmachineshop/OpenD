import { describe, expect, it } from 'vitest';
import {
  element,
  text,
  type CompiledRelease,
  type NavEntry,
  type ReaderContext,
} from '@opend/model';
import { ditavalPolicy, readerPolicy, viewPublication, viewRelease } from '../src/index.js';

const reader = (ctx: Partial<ReaderContext> & { version: string }) =>
  readerPolicy({ products: [], features: [], ...ctx });

const v1Widget = reader({ products: ['widget'], version: '1.4' });
const v2Pro = reader({ products: ['widget', 'gadget'], features: ['sso'], version: '2.1' });
const internal = ditavalPolicy([{ att: 'audience', val: 'internal', action: 'exclude' }]);

const topic = (id: string, attrs: Record<string, string> = {}, gadgetText?: string) => ({
  id,
  file: `${id}.dita`,
  ditaId: id,
  type: 'topic',
  title: id,
  body: element('topic', { id, ...attrs }, [
    element('title', {}, [text(`Title ${id}`)]),
    ...(gadgetText ? [element('p', { product: 'gadget' }, [text(gadgetText)])] : []),
  ]),
});

const entry = (
  topicId: string | undefined,
  condition: Record<string, string> = {},
  children: NavEntry[] = [],
  title = '',
): NavEntry => ({
  title,
  ...(topicId ? { topicId } : {}),
  condition,
  kind: 'chapter',
  children,
});

const release: CompiledRelease = {
  schemaVersion: 1,
  release: '2.1',
  title: 'Docs',
  builtAt: '2026-10-16T00:00:00Z',
  attributes: {},
  nav: [entry('site-only'), entry('shared')],
  publications: [
    {
      file: 'maps/guide.bookmap',
      title: 'Guide',
      nav: [
        entry('shared', {}, [entry('book-only', {}, [], 'Book only')]),
        entry('sso', { feature: 'sso' }),
        entry('v2', {}, [entry('under-v2')]),
        entry(undefined, { product: 'gadget' }, [entry('gadget-child')], 'Gadget part'),
        entry('secret-root'),
      ],
    },
  ],
  topics: {
    'site-only': topic('site-only'),
    shared: topic('shared', {}, 'gadget paragraph'),
    'book-only': topic('book-only'),
    sso: topic('sso'),
    v2: topic('v2', { release: '2.0..' }),
    'under-v2': topic('under-v2'),
    'gadget-child': topic('gadget-child'),
    'secret-root': topic('secret-root', { audience: 'internal' }),
  },
  chunkUsage: {},
  assets: [],
};

const FILE = 'maps/guide.bookmap';

describe('viewPublication', () => {
  it('returns null for an unknown publication', () => {
    expect(viewPublication(release, 'maps/nope.bookmap', [])).toBeNull();
  });

  it('publishes topics only the bookmap references, which the site view never does', () => {
    expect(viewRelease(release, [v1Widget]).isVisible('book-only')).toBe(false);
    const view = viewPublication(release, FILE, [v1Widget])!;
    expect(view.publication.title).toBe('Guide');
    expect(view.topic('book-only')?.title).toBe('Title book-only');
  });

  it('applies chapter, heading, topic root and element conditions', () => {
    const view = viewPublication(release, FILE, [internal, v1Widget])!;
    // sso: chapter condition. v2: topic root condition (its child stays reachable
    // through the nav, as on the site). Gadget part: heading condition. secret-root:
    // the build policy on the topic root.
    expect(view.topicIds()).toEqual(['shared', 'book-only', 'under-v2']);
    expect(view.isVisible('sso')).toBe(false);
    expect(view.isVisible('v2')).toBe(false);
    expect(view.isVisible('gadget-child')).toBe(false);
    expect(view.isVisible('secret-root')).toBe(false);
    expect(view.nav.map((e) => e.topicId ?? e.title)).toEqual(['shared', 'v2', 'secret-root']);
    // Entries for hidden topics never take the hidden topic's title.
    expect(view.nav.map((e) => e.title)).toEqual(['Title shared', '', '']);
    expect(JSON.stringify(view.topic('shared'))).not.toContain('gadget paragraph');
  });

  it('shows entitled readers what they hold, and nothing outside the publication', () => {
    const view = viewPublication(release, FILE, [internal, v2Pro])!;
    expect(view.topicIds()).toEqual([
      'shared',
      'book-only',
      'sso',
      'v2',
      'under-v2',
      'gadget-child',
    ]);
    expect(JSON.stringify(view.topic('shared'))).toContain('gadget paragraph');
    expect(view.isVisible('site-only')).toBe(false);
    expect(view.topic('site-only')).toBeNull();
  });

  it('gives a reader with no entitlements only unconditional content', () => {
    const view = viewPublication(release, FILE, [internal, reader({ version: '0.1' })])!;
    const everything = JSON.stringify([view.nav, view.topicIds().map((id) => view.topic(id))]);
    for (const hidden of ['Title sso', 'Title v2', 'Gadget part', 'gadget', 'Title secret'])
      expect(everything).not.toContain(hidden);
  });
});
