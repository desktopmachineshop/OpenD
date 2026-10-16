import { describe, expect, it } from 'vitest';
import type { CompiledRelease, CompiledTopic, NavEntry } from '@opend/model';
import { readerPolicy, viewPublication, viewRelease, type FilterPolicy } from '@opend/filter';
import { parseXml } from '@opend/dita';
import {
  publicationHasContent,
  publicationImages,
  renderPage,
  renderPublication,
} from '../src/index.js';

function topic(id: string, xml: string): CompiledTopic {
  const { root, diagnostics } = parseXml(xml, `${id}.dita`);
  if (!root) throw new Error(JSON.stringify(diagnostics));
  return { id, file: `${id}.dita`, ditaId: id, type: 'topic', title: id, body: root };
}

const ref = (
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

const topics = [
  topic(
    'install',
    '<task id="install"><title>Install</title><taskbody><steps>' +
      '<step id="s1"><cmd>Read <xref href="overview.dita" opend-target="overview"/>.</cmd></step>' +
      '<step><cmd>Then <xref href="extra.dita#extra/deep" opend-target="extra#deep">jump</xref>.</cmd></step>' +
      '<step><cmd>Also <xref href="pairing.dita" opend-target="pairing">pair it</xref>.</cmd></step>' +
      '<step product="gadget"><cmd>Pair the Gadget now.</cmd></step>' +
      '</steps><result><p><image href="logo.png" opend-asset="images/logo.png"><alt>Logo</alt></image></p>' +
      '<p><image href="missing.png" opend-asset="images/missing.png"><alt>Gone</alt></image></p>' +
      '<p><xref href="sheet.pdf" opend-asset="files/sheet.pdf">data sheet</xref></p></result></taskbody></task>',
  ),
  topic(
    'extra',
    '<topic id="extra"><title>Extra &amp; more</title><body><section id="deep"><title>Deep</title></section></body></topic>',
  ),
  topic('overview', '<topic id="overview"><title>Overview</title></topic>'),
  topic(
    'sso',
    '<topic id="sso"><title>Single sign-on</title><body><p>SSO secret</p></body></topic>',
  ),
  topic(
    'pairing',
    '<topic id="pairing"><title>Pairing</title><body><p><image href="g.png" opend-asset="images/gadget.png"/></p></body></topic>',
  ),
];

const release: CompiledRelease = {
  schemaVersion: 1,
  release: '2.1',
  title: 'Widget <Docs>',
  builtAt: '2026-10-16T00:00:00Z',
  attributes: {},
  nav: [ref('overview'), ref('install'), ref('pairing', { product: 'gadget' })],
  publications: [
    {
      file: 'maps/admin.bookmap',
      title: 'Admin Guide',
      nav: [
        ref('install', {}, [ref('extra')]),
        ref('sso', { feature: 'sso' }),
        ref(undefined, { product: 'gadget' }, [ref('pairing')], 'Gadget appendix'),
      ],
    },
    { file: 'maps/empty.bookmap', title: 'Empty', nav: [ref('sso', { feature: 'sso' })] },
  ],
  topics: Object.fromEntries(topics.map((t) => [t.id, t])),
  chunkUsage: {},
  assets: [],
};

const v1 = readerPolicy({ products: ['widget'], features: [], version: '1.4' });
const pro = readerPolicy({ products: ['widget', 'gadget'], features: ['sso'], version: '2.1' });
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

async function render(
  policies: FilterPolicy[],
  extra: Parameters<typeof renderPublication>[1] = {},
) {
  const view = viewPublication(release, 'maps/admin.bookmap', policies)!;
  const requested: string[] = [];
  const html = await renderPublication(view, {
    assets: async (path) => {
      requested.push(path);
      return path === 'images/missing.png' ? null : PNG;
    },
    site: viewRelease(release, policies),
    siteBase: 'https://docs.example.com/',
    now: new Date('2026-10-16T12:00:00Z'),
    ...extra,
  });
  return { html, requested: requested.sort(), view };
}

describe('renderPublication', () => {
  it('renders a cover with the publication, site, release and date', async () => {
    const { html } = await render([v1], { orgName: 'Acme & Co' });
    expect(html).toContain('<title>Admin Guide</title>');
    expect(html).toContain('<h1>Admin Guide</h1>');
    expect(html).toContain('Widget &lt;Docs&gt;');
    expect(html).toContain('Release 2.1');
    expect(html).toContain('Generated 2026-10-16');
    expect(html).toContain('Prepared for Acme &amp; Co');
    expect((await render([v1])).html).not.toContain('Prepared for');
  });

  it('lists only visible entries in the contents, nested, linking to anchors', async () => {
    const { html } = await render([v1]);
    const toc = html.slice(html.indexOf('<nav class="pub-toc"'), html.indexOf('</nav>'));
    expect(toc).toContain(
      '<li><a href="#pub-1">Install</a><ol><li><a href="#pub-2">Extra &amp; more</a></li></ol></li>',
    );
    expect(toc).not.toContain('Single sign-on');
    expect(toc).not.toContain('Gadget appendix');
    expect(html).not.toContain('SSO secret');
    expect(html).not.toContain('Pair the Gadget now');
    expect(html).not.toContain('Pairing');
  });

  it('gives entitled readers their chapters and headings', async () => {
    const { html } = await render([pro]);
    expect(html).toContain('<a href="#pub-3">Single sign-on</a>');
    expect(html).toContain(
      '<a href="#pub-h1">Gadget appendix</a><ol><li><a href="#pub-4">Pairing</a>',
    );
    expect(html).toContain('<section class="pub-part pub-chapter" id="pub-h1">');
    expect(html).toContain('Pair the Gadget now');
    // Links into the publication stay in the document.
    expect(html).toContain('<a class="xref" href="#pub-4">pair it</a>');
  });

  it('renders topics in order with chapter breaks, unique ids and in-document links', async () => {
    const { html } = await render([v1]);
    expect(html).toContain(
      '<div class="pub-entry pub-chapter" id="pub-1"><article id="pub-1-install"',
    );
    expect(html).toContain('<div class="pub-entry" id="pub-2"><article id="pub-2-extra"');
    // Nested topics take the next heading level.
    expect(html).toContain('<h2 class="title">Extra &amp; more</h2>');
    expect(html).toContain('<li id="pub-1-s1" class="step">');
    expect(html).toContain('<a class="xref" href="#pub-2-deep">jump</a>');
    expect(html).toContain('<section id="pub-2-deep" class="section">');
  });

  it('links topics outside the publication to the docs site, or to nothing', async () => {
    const { html } = await render([v1]);
    expect(html).toContain(
      '<a class="xref" href="https://docs.example.com/overview.html">Overview</a>',
    );
    // Not in the publication for this reader, and hidden on the site too.
    expect(html).toContain('<span class="xref xref-unavailable">pair it</span>');
    expect(html).toContain(
      '<a class="xref" href="https://docs.example.com/_assets/files/sheet.pdf"',
    );
    const offline = (await render([v1], { siteBase: undefined })).html;
    expect(offline).not.toContain('docs.example.com');
    expect(offline).not.toContain('>Overview<');
  });

  it('inlines only the images of visible topics as data URIs', async () => {
    const { html, requested, view } = await render([v1]);
    expect(requested).toEqual(['images/logo.png', 'images/missing.png']);
    expect(publicationImages(view)).toEqual(requested);
    expect(html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`);
    expect(html).toContain('<span class="image-unavailable">Gone</span>');
    expect(html).not.toContain('_assets/images');
    expect((await render([pro])).requested).toContain('images/gadget.png');
  });

  it('never exposes filtering attributes or build internals', async () => {
    for (const policies of [[v1], [pro], []]) {
      const { html } = await render(policies);
      expect(html).not.toMatch(
        /data-applies=|opend-target=|opend-asset=|<opend-cond|<opend-choice/,
      );
      expect(html).not.toMatch(/\b(product|feature|release|audience)="/);
    }
  });

  it('inlines the theme after the print styles and keeps it inside its style element', async () => {
    const { html } = await render([v1], {
      themeCss: ':root { --opend-accent: red; } </style><script>x</script>',
    });
    expect(html.indexOf('--opend-accent: red')).toBeGreaterThan(html.indexOf('@page'));
    expect(html).not.toContain('</style><script>');
    expect(html.match(/<\/style>/g)).toHaveLength(3);
  });

  it('says when nothing is visible', async () => {
    const view = viewPublication(release, 'maps/empty.bookmap', [v1])!;
    expect(publicationHasContent(view)).toBe(false);
    expect(publicationHasContent(viewPublication(release, 'maps/empty.bookmap', [pro])!)).toBe(
      true,
    );
    const html = await renderPublication(view);
    expect(html).toContain('No content in this publication is available to you.');
    expect(html).not.toContain('class="pub-toc"');
  });
});

describe('page shell publication links', () => {
  it('adds a Download PDF link per publication', () => {
    const html = renderPage(viewRelease(release, [v1]), 'install', {
      publications: [{ title: 'Admin <Guide>', href: '/pdf/admin.pdf' }],
    })!;
    expect(html).toContain(
      '<a class="site-pdf" href="/pdf/admin.pdf" title="Download PDF">Admin &lt;Guide&gt; (PDF)</a>',
    );
    expect(renderPage(viewRelease(release, [v1]), 'install')).not.toContain('class="site-pdf');
  });
});
