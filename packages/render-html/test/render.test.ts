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
import {
  MAX_SEARCH_QUERY,
  SPECIAL_ELEMENTS,
  TAGS,
  renderIndex,
  renderNav,
  renderNotFound,
  renderPage,
  renderSearch,
  renderTopic,
  siteSearchQuery,
} from '../src/index.js';

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
    expect(renderPage(view, 'a', { topicEnd: '<!--end-->' })).toContain('</article><!--end-->');
    expect(renderPage(view, 'g')).toBeNull();
    expect(renderPage(view, 'missing')).toBeNull();
    expect(renderPage(view, 'a')).toContain('<title>Alpha · Docs &lt;&amp;&gt;</title>');
  });
});

describe('site search', () => {
  const a = topic('a', '<topic id="a"><title>Alpha</title></topic>');
  const view = viewRelease(release([a]), [widgetV1]);
  const search = { action: '/search' };
  const XSS = '"><script>alert(1)</script><img src=x onerror=alert(2)>';

  it('puts a labelled GET search form in the header of every page, when asked', () => {
    for (const html of [
      renderPage(view, 'a', { search })!,
      renderIndex(view, { search }),
      renderNotFound(view, { search }),
    ]) {
      const header = /<header class="site-header">.*<\/header>/.exec(html)![0];
      expect(header).toContain(
        '<form class="site-search" role="search" method="get" action="/search">',
      );
      expect(header).toContain('<label class="opend-visually-hidden" for="opend-search-q">');
      expect(header).toContain('id="opend-search-q" name="q" value=""');
      expect(header).toContain(`maxlength="${MAX_SEARCH_QUERY}"`);
    }
    expect(renderPage(view, 'a')).not.toContain('class="site-search"');
    expect(renderPage(view, 'a', { search, base: '/x/' })).toContain('action="/search"');
  });

  it('lists hits with links and snippets, and echoes the query escaped', () => {
    const html = renderSearch(
      view,
      XSS,
      [{ topicId: 'a', title: 'Alpha <b>', snippet: `…${XSS}…`, score: 1 }],
      { search, base: '/docs/' },
    );
    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain('1 result for <q>&quot;&gt;&lt;script&gt;');
    expect(html).toContain('<a href="/docs/a.html">Alpha &lt;b&gt;</a>');
    expect(html).toContain('<p class="search-snippet">…&quot;&gt;&lt;script&gt;');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)');
    expect(html).toContain('<title>Search: &quot;&gt;&lt;script&gt;');
  });

  it('says when nothing matched, when nothing was asked, and when results are capped', () => {
    expect(renderSearch(view, 'zebra', [], { search })).toContain('No topics match <q>zebra</q>.');
    const empty = renderSearch(view, '', [], { search });
    expect(empty).toContain('Enter one or more words');
    expect(empty).toContain('<title>Search · Docs');
    const hit = { topicId: 'a', title: 'Alpha', snippet: '', score: 1 };
    expect(renderSearch(view, 'a', [hit, hit], { limit: 2 })).toContain('Top 2 results for');
    expect(renderSearch(view, 'a', [hit, hit], { limit: 3 })).toContain('>2 results for');
    expect(renderSearch(view, 'a', [hit])).not.toContain('class="search-snippet"');
  });

  it('takes the first q, trimmed and cut to 200 characters', () => {
    expect(siteSearchQuery('  wizard  ')).toBe('wizard');
    expect(siteSearchQuery(['one', 'two'])).toBe('one');
    expect(siteSearchQuery(undefined)).toBe('');
    expect(siteSearchQuery({ q: 1 })).toBe('');
    expect(siteSearchQuery('x'.repeat(500))).toHaveLength(MAX_SEARCH_QUERY);
    // Cut by character, never through a surrogate pair.
    expect(siteSearchQuery('😀'.repeat(300))).toBe('😀'.repeat(MAX_SEARCH_QUERY));
  });
});
