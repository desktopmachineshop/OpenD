import { describe, expect, it } from 'vitest';
import { element, text, type CompiledRelease, type CompiledTopic } from '@opend/model';
import { readerPolicy, searchView, viewRelease } from '../src/index.js';

const topic = (
  id: string,
  title: string,
  body: string,
  attrs: Record<string, string> = {},
): CompiledTopic => ({
  id,
  file: `${id}.dita`,
  ditaId: id,
  type: 'topic',
  title,
  body: element('topic', { id, ...attrs }, [
    element('title', {}, [text(title)]),
    element('shortdesc', {}, [text(`About ${title.toLowerCase()}.`)]),
    element('body', {}, [
      element('p', {}, [text(body)]),
      element('p', { feature: 'sso' }, [text('Secret single sign-on step for the installer.')]),
    ]),
  ]),
});

const release: CompiledRelease = {
  schemaVersion: 1,
  release: '2.1',
  title: 'Docs',
  builtAt: '2026-10-16T00:00:00Z',
  attributes: {},
  nav: ['install', 'network', 'gadget'].map((id) => ({
    title: id,
    topicId: id,
    condition: {},
    kind: 'topicref',
    children: [],
  })),
  publications: [],
  topics: {
    install: topic(
      'install',
      'Install the hub',
      'Run the installer on your server, then restart the installer service.',
    ),
    network: topic(
      'network',
      'Network settings',
      'The installer does not change network settings.',
    ),
    gadget: topic('gadget', 'Pair a gadget', 'Hold the installer button.', { product: 'gadget' }),
  },
  chunkUsage: {},
  assets: [],
};

describe('searchView', () => {
  const basic = viewRelease(release, [
    readerPolicy({ products: ['widget'], features: [], version: '2.1' }),
  ]);

  it('ranks title matches first and requires every term', () => {
    expect(searchView(basic, 'installer').map((h) => h.topicId)).toEqual(['install', 'network']);
    expect(searchView(basic, 'install hub').map((h) => h.topicId)).toEqual(['install']);
    expect(searchView(basic, 'network installer').map((h) => h.topicId)).toEqual(['network']);
    expect(searchView(basic, 'x')).toEqual([]);
  });

  it('only searches what the reader can see, including snippets', () => {
    expect(searchView(basic, 'gadget')).toEqual([]);
    expect(searchView(basic, 'single sign-on')).toEqual([]);
    const hit = searchView(basic, 'restart')[0]!;
    expect(hit.snippet).toContain('restart the installer service');
    expect(hit.snippet).not.toContain('Secret');
    const pro = viewRelease(release, [
      readerPolicy({ products: ['gadget'], features: ['sso'], version: '2.1' }),
    ]);
    expect(
      searchView(pro, 'single sign-on')
        .map((h) => h.topicId)
        .sort(),
    ).toEqual(['gadget', 'install', 'network']);
  });
});
