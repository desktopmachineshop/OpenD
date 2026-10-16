import { describe, expect, it } from 'vitest';
import { ASSET_ATTR, TARGET_ATTR, textContent, walk, type ElementNode } from '@opend/model';
import { filterTree, readerPolicy } from '@opend/filter';
import {
  Workspace,
  findTopic,
  loadMap,
  parseDitaval,
  parseRef,
  parseXml,
  resolveTopic,
  type ResolveContext,
} from '../src/index.js';

function workspace(files: Record<string, string>, extra: string[] = []): Workspace {
  return new Workspace(new Map(Object.entries(files)), new Set([...Object.keys(files), ...extra]));
}

function resolve(ws: Workspace, mapFile: string, topicFile: string) {
  const map = loadMap(ws, mapFile);
  const usage: string[] = [];
  const assets: string[] = [];
  const ctx: ResolveContext = {
    ws,
    keys: map.keys,
    diagnostics: [...map.diagnostics],
    onChunkUse: (id) => usage.push(id),
    onAsset: (p) => assets.push(p),
  };
  const doc = ws.document(topicFile);
  if (!doc) throw new Error(`cannot parse ${topicFile}: ${JSON.stringify(ws.diagnostics)}`);
  const topic = resolveTopic(findTopic(doc)!, topicFile, ctx);
  return { map, topic, usage, assets, diagnostics: [...ws.diagnostics, ...ctx.diagnostics] };
}

const find = (root: ElementNode, pred: (e: ElementNode) => boolean): ElementNode[] => {
  const out: ElementNode[] = [];
  walk(root, (e) => {
    if (pred(e)) out.push(e);
  });
  return out;
};

describe('parseXml', () => {
  it('keeps element positions', () => {
    const { root } = parseXml('<topic id="t">\n  <title>Hi</title>\n</topic>', 'a.dita');
    const title = root?.children.find((c) => c.type === 'element');
    expect(title).toMatchObject({ name: 'title', loc: { file: 'a.dita', line: 2 } });
  });

  it('reports syntax errors with a location and returns no root', () => {
    const { root, diagnostics } = parseXml('<topic id="t">\n<p>unclosed\n</topic>', 'bad.dita');
    expect(root).toBeNull();
    expect(diagnostics[0]).toMatchObject({
      severity: 'error',
      code: 'xml-syntax',
      file: 'bad.dita',
    });
    expect(diagnostics[0]?.line).toBeGreaterThan(1);
  });

  it('accepts a DOCTYPE and common named entities', () => {
    const src =
      '<?xml version="1.0"?>\n<!DOCTYPE concept PUBLIC "-//OASIS//DTD DITA Concept//EN" "concept.dtd">\n<concept id="c"><title>A&nbsp;&mdash;B</title></concept>';
    const { root, diagnostics } = parseXml(src, 'c.dita');
    expect(diagnostics).toEqual([]);
    expect(textContent(root!)).toBe('A —B');
  });
});

describe('parseRef', () => {
  it('resolves relative paths and fragments', () => {
    expect(parseRef('../reuse/common.dita#common/warn', 'topics/install.dita')).toEqual({
      file: 'reuse/common.dita',
      topicId: 'common',
      elementId: 'warn',
    });
    expect(parseRef('#self/p1', 'topics/a.dita')).toEqual({
      file: 'topics/a.dita',
      topicId: 'self',
      elementId: 'p1',
    });
    expect(parseRef('../../outside.dita', 'topics/a.dita')).toBeNull();
  });
});

describe('loadMap', () => {
  const ws = workspace({
    'maps/main.ditamap': `<map><title>Guide</title>
      <keydef keys="product-name" product="gadget"><topicmeta><keywords><keyword>Gadget</keyword></keywords></topicmeta></keydef>
      <keydef keys="product-name"><topicmeta><keywords><keyword>Widget</keyword></keywords></topicmeta></keydef>
      <topicref href="../topics/a.dita"/>
      <topichead navtitle="Gadget" product="gadget">
        <topicref href="../topics/b.dita" toc="no"/>
      </topichead>
      <mapref href="sub.ditamap" release="2.0.."/>
      <topicref href="../topics/missing.dita"/>
    </map>`,
    'maps/sub.ditamap': `<map><keydef keys="product-name"><topicmeta><keywords><keyword>Sub</keyword></keywords></topicmeta></keydef>
      <topicref href="../topics/c.dita"/></map>`,
    'topics/a.dita': '<topic id="a"><title>A</title></topic>',
    'topics/b.dita': '<topic id="b"><title>B</title></topic>',
    'topics/c.dita': '<topic id="c"><title>C</title></topic>',
  });
  const map = loadMap(ws, 'maps/main.ditamap');

  it('builds navigation with conditions and submaps', () => {
    expect(map.title).toBe('Guide');
    expect(map.nav.map((e) => [e.kind, e.topicId ?? e.title])).toEqual([
      ['topicref', 'topics/a'],
      ['topichead', 'Gadget'],
      ['mapref', ''],
      ['topicref', ''],
    ]);
    expect(map.nav[1]).toMatchObject({ condition: { product: 'gadget' } });
    expect(map.nav[1]?.children[0]).toMatchObject({ topicId: 'topics/b', hidden: true });
    expect(map.nav[2]).toMatchObject({ condition: { release: '2.0..' } });
    expect(map.nav[2]?.children[0]?.topicId).toBe('topics/c');
  });

  it('reports missing topics', () => {
    expect(map.diagnostics).toEqual([
      expect.objectContaining({ code: 'missing-topic', file: 'maps/main.ditamap', line: 9 }),
    ]);
  });

  it('orders key definitions: parent map first, then submaps, with ancestor conditions', () => {
    const defs = map.keys.get('product-name') ?? [];
    expect(
      defs.map((d) =>
        textContent({ type: 'element', name: 'x', attrs: {}, children: d.text ?? [] }),
      ),
    ).toEqual(['Gadget', 'Widget', 'Sub']);
    expect(defs[0]?.conditions).toEqual([{ product: 'gadget' }]);
    expect(defs[2]?.conditions).toEqual([{ release: '2.0..' }]);
  });
});

describe('resolveTopic', () => {
  const files = {
    'maps/main.ditamap': `<map>
      <keydef keys="product-name" product="gadget"><topicmeta><keywords><keyword>Gadget</keyword></keywords></topicmeta></keydef>
      <keydef keys="product-name" product="widget"><topicmeta><keywords><keyword>Widget</keyword></keywords></topicmeta></keydef>
      <keydef keys="vendor"><topicmeta><keywords><keyword>Acme</keyword></keywords></topicmeta></keydef>
      <keydef keys="common" href="../reuse/common.dita"/>
      <keydef keys="site" href="https://example.com" scope="external"><topicmeta><linktext>Site</linktext></topicmeta></keydef>
      <topicref href="../topics/install.dita"/>
      <topicref href="../topics/other.dita"/>
    </map>`,
    'reuse/common.dita': `<topic id="common"><title>Chunks</title><body>
      <note id="power" type="warning">Disconnect power. See <xref href="../topics/other.dita#other/details"/>.</note>
      <ph id="nested"><ph conref="#common/vendor-ph"/> inside</ph>
      <ph id="vendor-ph"><keyword keyref="vendor"/></ph>
      <p id="loop-a" conref="#common/loop-b"/>
      <p id="loop-b" conref="#common/loop-a"/>
      <draft-comment>internal only</draft-comment>
    </body></topic>`,
    'topics/install.dita': `<task id="install"><title>Install <ph keyref="product-name"/></title><taskbody>
      <context><note conref="../reuse/common.dita#common/power" release="2.0.."/></context>
      <steps>
        <step><cmd>Made by <keyword keyref="vendor"/></cmd></step>
        <step><cmd><ph conkeyref="common/nested"/></cmd></step>
        <step><cmd>Open <xref keyref="site"/> and <xref href="other.dita"/></cmd></step>
        <step><cmd><image href="../images/shot.png"/></cmd></step>
      </steps>
      <draft-comment>do not publish</draft-comment>
      <p conref="../reuse/common.dita#common/loop-a"/>
      <p conref="../reuse/common.dita#common/nope"/>
      <p><xref href="nowhere.dita"/></p>
      <p><ph keyref="undefined-key">fallback text</ph></p>
    </taskbody></task>`,
    'topics/other.dita': `<topic id="other"><title>Other</title><body><section id="details"/></body></topic>`,
  };
  const r = resolve(
    workspace(files, ['images/shot.png']),
    'maps/main.ditamap',
    'topics/install.dita',
  );
  const json = JSON.stringify(r.topic);

  it('inlines conref content and keeps the referencing element’s conditions', () => {
    const conds = find(r.topic, (e) => e.name === 'opend-cond' && e.attrs.release === '2.0..');
    expect(conds).toHaveLength(1);
    expect(textContent(conds[0]!)).toContain('Disconnect power');
  });

  it('resolves links inside pulled chunks against the chunk’s own file', () => {
    const link = find(
      r.topic,
      (e) => e.name === 'xref' && e.attrs.href === '../topics/other.dita#other/details',
    );
    expect(link[0]?.attrs[TARGET_ATTR]).toBe('topics/other#details');
  });

  it('resolves nested conrefs, conkeyref and unconditional keyref text', () => {
    expect(json).toContain('Made by');
    expect(textContent(r.topic)).toContain('Acme inside');
  });

  it('turns conditional key definitions into a per-reader choice', () => {
    const title = find(r.topic, (e) => e.name === 'title')[0]!;
    const widgetReader = readerPolicy({ products: ['widget'], features: [], version: '1.0' });
    const neither = readerPolicy({ products: [], features: [], version: '1.0' });
    expect(textContent(filterTree(title, [widgetReader])!)).toBe('Install Widget');
    expect(textContent(filterTree(title, [neither])!)).toBe('Install');
  });

  it('resolves external keys and local links', () => {
    const site = find(r.topic, (e) => e.name === 'xref' && e.attrs.href === 'https://example.com');
    expect(textContent(site[0]!)).toBe('Site');
    const other = find(r.topic, (e) => e.name === 'xref' && e.attrs.href === 'other.dita');
    expect(other[0]?.attrs[TARGET_ATTR]).toBe('topics/other');
  });

  it('records chunk usage and assets', () => {
    expect(r.usage).toContain('reuse/common.dita#common/power');
    expect(r.usage).toContain('reuse/common.dita#common/nested');
    expect(r.assets).toEqual(['images/shot.png']);
    expect(find(r.topic, (e) => e.name === 'image')[0]?.attrs[ASSET_ATTR]).toBe('images/shot.png');
  });

  it('drops draft comments, including from pulled chunks', () => {
    expect(json).not.toContain('do not publish');
    expect(json).not.toContain('internal only');
  });

  it('reports cycles, missing chunks, broken links and undefined keys', () => {
    const codes = r.diagnostics.map((d) => d.code).sort();
    expect(codes).toEqual(['broken-link', 'conref-cycle', 'missing-conref', 'unresolved-key']);
    expect(r.diagnostics.find((d) => d.code === 'missing-conref')).toMatchObject({
      file: 'topics/install.dita',
      line: 11,
    });
    expect(textContent(r.topic)).toContain('fallback text');
  });
});

describe('parseDitaval', () => {
  it('reads prop rules', () => {
    const { rules, diagnostics } = parseDitaval(
      '<val><prop att="audience" val="internal" action="exclude"/><prop action="include"/><prop att="x" action="bogus"/></val>',
      'f.ditaval',
    );
    expect(rules).toEqual([
      { att: 'audience', val: 'internal', action: 'exclude' },
      { action: 'include' },
    ]);
    expect(diagnostics).toHaveLength(1);
  });
});
