import { describe, expect, it } from 'vitest';
import type { CompiledRelease, CompiledTopic, ElementNode } from '@opend/model';
import { readerPolicy, viewRelease } from '@opend/filter';
import {
  METADATA_ELEMENTS,
  DROPPED_ELEMENTS,
  SUPPORTED_ELEMENTS,
  TOPIC_TYPES,
  parseXml,
} from '@opend/dita';
import { SPECIAL_ELEMENTS, TAGS, renderNav, renderPage, renderTopic } from '../src/index.js';

function body(xml: string): ElementNode {
  const { root, diagnostics } = parseXml(xml, 't.dita');
  if (!root) throw new Error(JSON.stringify(diagnostics));
  return root;
}

function topic(id: string, xml: string): CompiledTopic {
  return { id, file: `${id}.dita`, ditaId: id, type: 'topic', title: id, body: body(xml) };
}

function release(topics: CompiledTopic[], nav = topics.map((t) => t.id)): CompiledRelease {
  return {
    schemaVersion: 1,
    release: '2.1',
    title: 'Docs <&>',
    builtAt: '2026-10-16T00:00:00Z',
    attributes: {},
    nav: nav.map((id) => ({
      title: '',
      topicId: id,
      condition: {},
      kind: 'topicref',
      children: [],
    })),
    publications: [],
    topics: Object.fromEntries(topics.map((t) => [t.id, t])),
    chunkUsage: {},
    assets: [],
  };
}

const widgetV1 = readerPolicy({ products: ['widget'], features: [], version: '1.4' });

describe('element coverage', () => {
  it('has a rendering for every supported element', () => {
    const unhandled = [...SUPPORTED_ELEMENTS].filter(
      (name) =>
        !(name in TAGS) &&
        !SPECIAL_ELEMENTS.has(name) &&
        !TOPIC_TYPES.has(name) &&
        !METADATA_ELEMENTS.has(name) &&
        !DROPPED_ELEMENTS.has(name),
    );
    expect(unhandled).toEqual([]);
  });
});

describe('renderTopic', () => {
  it('escapes text and attributes', () => {
    const t = topic(
      'a',
      '<topic id="a"><title>1 &lt; 2 &amp; "q"</title><body><p outputclass="x&quot;y">&lt;script&gt;</p></body></topic>',
    );
    const html = renderTopic(viewRelease(release([t]), []), t);
    expect(html).toContain('<h1 class="title">1 &lt; 2 &amp; &quot;q&quot;</h1>');
    expect(html).toContain('class="p x&quot;y"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('uses heading levels by nesting and captions for figures and tables', () => {
    const t = topic(
      'a',
      '<concept id="a"><title>T</title><conbody><section><title>S</title></section>' +
        '<fig><title>F</title></fig><table><title>Tb</title><tgroup cols="1"><tbody><row><entry>x</entry></row></tbody></tgroup></table>' +
        '</conbody><concept id="n"><title>N</title></concept></concept>',
    );
    const html = renderTopic(viewRelease(release([t]), []), t);
    expect(html).toMatch(/<article id="a" class="concept topic"><h1 class="title">T<\/h1>/);
    expect(html).toContain('<h2 class="title">S</h2>');
    expect(html).toContain('<figcaption class="title">F</figcaption>');
    expect(html).toContain('<caption class="title">Tb</caption>');
    expect(html).toContain('<section id="n" class="concept topic"><h2 class="title">N</h2>');
  });

  it('renders table spans', () => {
    const t = topic(
      'a',
      '<topic id="a"><title>T</title><body><table><tgroup cols="3"><colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/>' +
        '<thead><row><entry namest="c1" nameend="c2">wide</entry><entry>h</entry></row></thead>' +
        '<tbody><row><entry morerows="1">tall</entry><entry>b</entry><entry>c</entry></row></tbody></tgroup></table></body></topic>',
    );
    const html = renderTopic(viewRelease(release([t]), []), t);
    expect(html).toContain('<th class="entry" colspan="2">wide</th>');
    expect(html).toContain('<td class="entry" rowspan="2">tall</td>');
  });

  it('links to visible topics with their title and hides links to invisible ones', () => {
    const a = topic(
      'a',
      '<topic id="a"><title>A</title><body>' +
        '<p><xref href="b.dita" opend-target="b"/></p>' +
        '<p><xref href="c.dita" opend-target="c"/></p>' +
        '<p><xref href="c.dita" opend-target="c">authored text</xref></p>' +
        '<p><xref href="b.dita#b/sec" opend-target="b#sec">jump</xref></p>' +
        '</body></topic>',
    );
    const b = topic('b', '<topic id="b"><title>Bee</title></topic>');
    const c = topic(
      'c',
      '<topic id="c" product="gadget"><title>Secret gadget title</title></topic>',
    );
    const view = viewRelease(release([a, b, c]), [widgetV1]);
    const html = renderTopic(view, view.topic('a')!);
    expect(html).toContain('<a class="xref" href="/b.html">Bee</a>');
    expect(html).toContain('<a class="xref" href="/b.html#sec">jump</a>');
    expect(html).not.toContain('Secret gadget title');
    expect(html).toContain('<span class="xref xref-unavailable">authored text</span>');
    expect(html).not.toContain('/c.html');
  });

  it('marks conditions and shows every alternative only in the staff view', () => {
    const t = topic(
      'a',
      '<topic id="a"><title>A</title><body><p product="gadget">g</p>' +
        '<p><opend-choice><opend-cond feature="sso"><ph>Enterprise</ph></opend-cond><opend-cond><ph>Standard</ph></opend-cond></opend-choice></p>' +
        '</body></topic>',
    );
    const staff = viewRelease(release([t]), [], { resolveChoices: false });
    const staffHtml = renderTopic(staff, staff.topic('a')!, { showConditions: true });
    expect(staffHtml).toContain('data-applies="product=gadget"');
    expect(staffHtml).toMatch(/Enterprise.*opend-alt-sep.*Standard/);

    const reader = viewRelease(release([t]), [widgetV1]);
    const readerHtml = renderTopic(reader, reader.topic('a')!);
    expect(readerHtml).not.toContain('data-applies');
    expect(readerHtml).not.toContain('Enterprise');
    expect(readerHtml).toContain('Standard');
  });

  it('never renders metadata or draft comments', () => {
    const t = topic(
      'a',
      '<topic id="a"><title>A</title><prolog><author>x</author></prolog><body><p>ok<indexterm>idx</indexterm><draft-comment>todo</draft-comment></p></body></topic>',
    );
    const html = renderTopic(viewRelease(release([t]), []), t);
    expect(html).not.toMatch(/idx|todo|author/);
  });
});

describe('renderNav and renderPage', () => {
  const a = topic('a', '<topic id="a"><title>Alpha</title></topic>');
  const g = topic('g', '<topic id="g" product="gadget"><title>Gadget page</title></topic>');
  const rel: CompiledRelease = {
    ...release([a, g]),
    nav: [
      { title: '', topicId: 'a', condition: {}, kind: 'topicref', children: [] },
      // A navtitle on a topicref whose topic the reader cannot see must not leak.
      { title: 'Gadget navtitle', topicId: 'g', condition: {}, kind: 'topicref', children: [] },
      { title: 'Empty heading', condition: {}, kind: 'topichead', children: [] },
      {
        title: '',
        condition: {},
        kind: 'topicgroup',
        children: [
          {
            title: 'Grouped',
            topicId: 'a',
            condition: {},
            kind: 'topicref',
            children: [],
            hidden: true,
          },
        ],
      },
    ],
  };

  it('omits hidden entries, empty headings and invisible topics', () => {
    const nav = renderNav(viewRelease(rel, [widgetV1]), 'a');
    expect(nav).toBe('<ul><li><a href="/a.html" aria-current="page">Alpha</a></li></ul>');
  });

  it('returns null for pages the reader cannot see and escapes the site title', () => {
    const view = viewRelease(rel, [widgetV1]);
    expect(renderPage(view, 'g')).toBeNull();
    expect(renderPage(view, 'missing')).toBeNull();
    expect(renderPage(view, 'a')).toContain('<title>Alpha · Docs &lt;&amp;&gt;</title>');
  });
});
