import { describe, expect, it } from 'vitest';
import type { CompiledRelease, CompiledTopic, ElementNode } from '@opend/model';
import { readerPolicy, viewRelease, visibleNav } from '@opend/filter';
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
  renderVersionMenu,
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

  it('never emits script URLs from authored links and images', () => {
    const t = topic(
      'a',
      '<topic id="a"><title>A</title><body>' +
        '<p><xref href="javascript:alert(1)" scope="external">x1</xref></p>' +
        '<p><xref href=" JaVa&#9;Script:alert(2)" scope="external">x2</xref></p>' +
        '<p><xref href="data:text/html,&lt;script&gt;alert(3)&lt;/script&gt;">x3</xref></p>' +
        '<p><xref href="vbscript:msgbox(4)">x4</xref></p>' +
        '<p><image href="javascript:alert(5)" scope="external"><alt>pic</alt></image></p>' +
        '<related-links><link href="javascript:alert(6)" scope="external"><linktext>x6</linktext></link></related-links>' +
        '<p><xref href="https://example.com/ok" scope="external">ok</xref></p>' +
        '<p><xref href="mailto:help@example.com">mail</xref></p>' +
        '</body></topic>',
    );
    const html = renderTopic(viewRelease(release([t]), []), t);
    expect(html).not.toMatch(/script:|data:text/i);
    expect(html).toContain('<span class="xref xref-unavailable">x1</span>');
    expect(html).toContain('<span class="image-unavailable">pic</span>');
    expect(html).toContain('href="https://example.com/ok"');
    expect(html).toContain('href="mailto:help@example.com"');
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

  it('never shows the navtitle of a hidden topic, even when it has visible children', () => {
    const nested: CompiledRelease = {
      ...release([a, g]),
      nav: [
        {
          title: 'Gadget navtitle',
          topicId: 'g',
          condition: {},
          kind: 'topicref',
          children: [{ title: '', topicId: 'a', condition: {}, kind: 'topicref', children: [] }],
        },
      ],
    };
    const nav = renderNav(viewRelease(nested, [widgetV1]), 'a');
    expect(nav).not.toContain('Gadget navtitle');
    expect(nav).toBe('<ul><li><a href="/a.html" aria-current="page">Alpha</a></li></ul>');
    // The staff view still shows it, with its child underneath.
    expect(renderNav(viewRelease(nested, []), 'a')).toContain('Gadget navtitle');
  });

  it('returns null for pages the reader cannot see and escapes the site title', () => {
    const view = viewRelease(rel, [widgetV1]);
    expect(renderPage(view, 'a', { topicEnd: '<!--end-->' })).toContain('</article><!--end-->');
    expect(renderPage(view, 'g')).toBeNull();
    expect(renderPage(view, 'missing')).toBeNull();
    expect(renderPage(view, 'a')).toContain('<title>Alpha · Docs &lt;&amp;&gt;</title>');
  });
});

describe('collapsible navigation', () => {
  const a = topic('a', '<topic id="a"><title>Alpha</title></topic>');
  const b = topic('b', '<topic id="b"><title>Beta</title></topic>');
  const c = topic('c', '<topic id="c"><title>Gamma</title></topic>');
  const g = topic('g', '<topic id="g" product="gadget"><title>Gadget page</title></topic>');
  const g2 = topic('g2', '<topic id="g2" product="gadget"><title>Gadget child</title></topic>');
  const ref = (id: string, children: CompiledRelease['nav'] = [], title = '') => ({
    title,
    topicId: id,
    condition: {},
    kind: 'topicref' as const,
    children,
  });
  const head = (title: string, children: CompiledRelease['nav']) => ({
    title,
    condition: {},
    kind: 'topichead' as const,
    children,
  });
  const rel: CompiledRelease = {
    ...release([a, b, c, g, g2]),
    nav: [
      head('Start', [ref('a', [ref('b')])]),
      head('More', [ref('c')]),
      // Only hidden topics under it: the heading must vanish for widget readers.
      head('Gadget heading', [ref('g', [ref('g2')], 'Gadget navtitle')]),
      // A hidden topic with a navtitle and visible children: the children are lifted.
      ref('g', [ref('c')], 'Secret navtitle'),
    ],
  };
  const view = viewRelease(rel, [widgetV1]);

  it('opens the groups on the path to the current page and closes the others', () => {
    const nav = renderNav(view, 'b');
    expect(nav).toContain(
      '<li class="nav-group"><details open><summary class="nav-heading">Start</summary>',
    );
    expect(nav).toContain(
      '<li class="nav-group nav-group-link"><a href="/a.html">Alpha</a><details open><summary class="nav-toggle"><span class="opend-visually-hidden">Subtopics of Alpha</span></summary><ul><li><a href="/b.html" aria-current="page">Beta</a></li></ul></details></li>',
    );
    expect(nav).toContain('<details><summary class="nav-heading">More</summary>');
    expect(nav.match(/aria-current/g)).toHaveLength(1);
    // A topic with children is open on its own page too.
    expect(renderNav(view, 'a')).toContain(
      '<a href="/a.html" aria-current="page">Alpha</a><details open>',
    );
    // Pages outside the tree (index, search) start with every group closed.
    expect(renderNav(view, null)).not.toContain('<details open');
  });

  it('never puts a hidden topic in a group label, toggle or heading', () => {
    for (const current of ['a', 'b', 'c', null]) {
      const nav = renderNav(view, current);
      expect(nav).not.toMatch(/Gadget|Secret|g2|g\.html/);
      const page = current
        ? renderPage(view, current, { search: { action: '/search' } })!
        : renderIndex(view);
      expect(page).not.toMatch(/Gadget|Secret|g2\.html|\/g\.html/);
    }
    // The lifted child of the hidden topic is still listed, as a plain entry.
    expect(renderNav(view, 'c').match(/href="\/c\.html"/g)).toHaveLength(2);
    // The staff view shows every group.
    const staff = renderNav(viewRelease(rel, []), 'g2');
    expect(staff).toContain('<summary class="nav-heading">Gadget heading</summary>');
    expect(staff).toContain('Subtopics of Gadget navtitle');
    expect(staff).toContain('<a href="/g2.html" aria-current="page">');
  });

  it('lists the same entries in visibleNav, which the API and help nav use', () => {
    const nav = visibleNav(view);
    expect(JSON.stringify(nav)).not.toMatch(/Gadget|Secret|"g2"|"g"/);
    expect(nav.map((e) => [e.title, e.topicId])).toEqual([
      ['Start', undefined],
      ['More', undefined],
      ['Gamma', 'c'],
    ]);
    expect(nav[0]!.children[0]).toMatchObject({ topicId: 'a', children: [{ topicId: 'b' }] });
  });

  it('puts a Menu control for the contents in the header, and the logo when there is one', () => {
    const page = renderPage(view, 'a', { logoHref: '/_logo.svg' })!;
    const header = /<header class="site-header">.*<\/header>/.exec(page)![0];
    expect(header).toContain(
      '<details class="site-menu"><summary aria-controls="opend-menu-panel"><span class="site-menu-button">',
    );
    expect(header).toContain('<span>Menu</span></span></summary>');
    expect(header).toContain('<img class="site-logo" src="/_logo.svg" alt="">');
    expect(page).toContain('<nav class="toc opend-nav" id="opend-toc" aria-label="Contents">');
    expect(page).toContain('<a class="opend-skip" href="#opend-main">');
    expect(page).toContain('<main id="opend-main">');
    expect(page).not.toMatch(/<script|onclick|onchange/);
    expect(renderPage(view, 'a')).not.toContain('<img class="site-logo"');
    // No contents, no menu.
    const empty = viewRelease({ ...rel, nav: [] }, [widgetV1]);
    expect(renderIndex(empty)).not.toContain('<details class="site-menu"');
    // Search alone still gets a menu on narrow screens.
    expect(renderIndex(empty, { search: { action: '/search' } })).toContain(
      '<details class="site-menu">',
    );
  });

  it('copies search, the contents and the PDF links into the menu panel, with unique ids', () => {
    const page = renderPage(view, 'b', {
      search: { action: '/search', query: 'q<' },
      publications: [{ title: 'Guide <&>', href: '/pdf/guide.pdf' }],
    })!;
    const panel = /<div class="site-menu-panel" id="opend-menu-panel">(.*?)<\/div><\/details>/.exec(
      page,
    )![1]!;
    // Search comes first, then the contents, then the publications.
    expect(panel.startsWith('<form class="site-menu-search" role="search"')).toBe(true);
    expect(panel).toContain('<label class="opend-visually-hidden" for="opend-menu-search-q">');
    expect(panel).toContain('id="opend-menu-search-q" name="q" value="q&lt;"');
    expect(panel).toContain(
      '<nav class="opend-nav site-menu-nav" aria-label="Contents"><ul><li class="nav-group"><details open>',
    );
    expect(panel).toContain('<a href="/b.html" aria-current="page">Beta</a>');
    expect(panel).toMatch(
      /<nav class="site-menu-pdfs" aria-label="Download PDF"><p class="site-menu-heading">Publications<\/p><ul><li><a href="\/pdf\/guide\.pdf">Guide &lt;&amp;&gt; \(PDF\)<\/a><\/li><\/ul><\/nav>$/,
    );
    // Each copy exists exactly twice: the wide layout's and the menu's, one hidden by CSS at each width.
    expect(page.match(/role="search"/g)).toHaveLength(2);
    expect(page.match(/href="\/pdf\/guide\.pdf"/g)).toHaveLength(2);
    expect(page.match(/ aria-current="page"/g)).toHaveLength(2);
    const ids = [...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    // The menu copy never shows more than the sidebar.
    expect(panel).not.toMatch(/Gadget|Secret/);
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

describe('version menu', () => {
  const items = [
    { line: '0.23', labels: ['latest'], href: '/v/0.23/a.html' },
    { line: '0.21', labels: ['stable'], href: '/v/0.21/' },
    { line: '0.20', labels: [], href: '/v/0.20/<x>' },
  ];

  it('lists the lines as plain links in a <details>, marking the current one', () => {
    const menu = renderVersionMenu({ line: '0.23', labels: ['latest'] }, items);
    expect(menu).toMatch(/^<details class="site-versions"><summary>/);
    expect(menu).toContain(
      '<a href="/v/0.23/a.html" aria-current="page">0.23 <span class="site-versions-label">(latest)</span></a>',
    );
    expect(menu).toContain(
      '<a href="/v/0.21/">0.21 <span class="site-versions-label">(stable)</span></a>',
    );
    expect(menu).toContain('<a href="/v/0.20/&lt;x&gt;">0.20</a>');
    expect(menu).not.toMatch(/<script|style=|onclick/);
    expect(menu.match(/aria-current/g)).toHaveLength(1);
  });

  it('renders nothing without lines, and sits after the release in the header', () => {
    expect(renderVersionMenu({ line: '1', labels: [] }, [])).toBe('');
    const view = viewRelease(release([topic('a', '<topic id="a"><title>A</title></topic>')]), []);
    const page = renderPage(view, 'a', {
      versions: '<!--v-->',
      head: '<link rel="canonical" href="/a.html">',
    })!;
    expect(page).toContain('<span class="site-release">Release 2.1</span><!--v-->');
    expect(page).toMatch(/<link rel="canonical" href="\/a.html">\n<\/head>/);
  });
});
