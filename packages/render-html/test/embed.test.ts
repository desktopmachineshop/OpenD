import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readerPolicy, viewRelease } from '@opend/filter';
import { buildRelease, readDirectory } from '@opend/build';
import { handleEmbedRequest, navNeighbours, renderEmbed, type EmbedOptions } from '../src/index.js';

const STARTER = join(import.meta.dirname, '../../../templates/docs-starter');

describe('embedded help pages', async () => {
  const release = buildRelease(await readDirectory(STARTER)).release!;
  const v1 = viewRelease(release, [
    readerPolicy({ products: ['widget'], features: [], version: '1.4' }),
  ]);
  const pro = viewRelease(release, [
    readerPolicy({
      products: ['widget', 'gadget'],
      features: ['sso', 'audit-log'],
      version: '2.1',
    }),
  ]);
  const o: EmbedOptions = {
    hostOrigin: 'https://app.example',
    app: 'console',
    fullDocsBase: 'https://docs.example/',
  };
  const get = (view: typeof v1, path: string, query: string) =>
    handleEmbedRequest(view, path, new URLSearchParams(query), o);

  it('renders a compact panel whose links stay in the panel', () => {
    const html = renderEmbed(pro, 'topics/install', o)!;
    expect(html).toContain(
      '<h1 class="title">Install the <span class="keyword">Widget Platform</span></h1>',
    );
    expect(html).toContain(
      'href="/embed/topics/topics/configure.html?host=https%3A%2F%2Fapp.example&amp;app=console"',
    );
    expect(html).toContain('href="https://docs.example/topics/install.html" target="_blank"');
    expect(html).toContain('data-host-origin="https://app.example"');
    expect(html).not.toContain('class="toc"');
    expect(html).not.toMatch(/<script>/);
  });

  it('lists only visible neighbours in the section', () => {
    const titles = (view: typeof v1, id: string) => navNeighbours(view, id).map((e) => e.title);
    expect(titles(pro, 'topics/configure-sso')).toEqual(['Audit log events']);
    expect(titles(v1, 'topics/install')).toEqual(['Configure the hub']);
  });

  it('resolves contexts per reader through the shared handler', () => {
    expect(get(pro, '/embed/context', 'app=console&key=settings.sso').html).toContain(
      'Configure single sign-on',
    );
    const fallback = get(v1, '/embed/context', 'app=console&key=settings.sso');
    expect(fallback.status).toBe(200);
    expect(fallback.html).toContain('Configure the hub');
    expect(fallback.html).not.toContain('single sign-on');
    expect(get(v1, '/embed/context', 'app=console&path=/whats-new').html).toContain(
      'Release notes for 1.x',
    );
    expect(get(pro, '/embed/context', 'app=nope&key=x').status).toBe(404);
  });

  it('opens a context that points at a section of a page at its anchor', () => {
    const texts = new Map([
      ['opend.config.yaml', 'release: "1.0"\nmap: m.ditamap\n'],
      ['m.ditamap', '<map><topicref href="api.dita"/></map>'],
      [
        'api.dita',
        `<reference id="api"><title>API</title><refbody><p>Intro</p></refbody>
          <reference id="builds"><title>Builds</title>
            <prolog><resourceid appname="console" appid="builds"/></prolog>
            <refbody><p>Build routes</p></refbody>
          </reference>
        </reference>`,
      ],
    ]);
    const built = buildRelease({ files: new Set(texts.keys()), texts }).release!;
    const res = handleEmbedRequest(
      viewRelease(built, []),
      '/embed/context',
      new URLSearchParams('app=console&key=builds'),
      o,
    );
    expect(res.status).toBe(303);
    expect(res.location).toBe(
      '/embed/topics/api.html?host=https%3A%2F%2Fapp.example&app=console#builds',
    );
  });

  it('serves topics by id and hides ones the reader cannot see', () => {
    expect(get(pro, '/embed/topics/topics/gadget-pairing.html', '').status).toBe(200);
    const hidden = get(v1, '/embed/topics/topics/gadget-pairing.html', '');
    expect(hidden.status).toBe(404);
    expect(hidden.html).not.toContain('Pair a Gadget');
  });

  it('searches only the reader’s topics', () => {
    expect(get(pro, '/embed/search', 'q=pair').html).toContain('Pair a Gadget');
    expect(get(v1, '/embed/search', 'q=pair').html).toContain('No help topics match');
  });

  it('runs standalone without a host origin', () => {
    const html = renderEmbed(pro, 'topics/install', { app: 'console' })!;
    expect(html).not.toContain('data-host-origin');
  });
});
