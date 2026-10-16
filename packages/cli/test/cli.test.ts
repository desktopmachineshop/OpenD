import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  audienceFromOptions,
  createProgram,
  startPreview,
  type PreviewServer,
} from '../src/index.js';
import type { PdfRenderer } from '@opend/pdf';

const STARTER = join(import.meta.dirname, '../../../templates/docs-starter');

async function run(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let code = -1;
  const program = createProgram(
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    (c) => (code = c),
  );
  program.exitOverride();
  await program.parseAsync(['node', 'opend', ...args]);
  return { out: out.join('\n'), err: err.join('\n'), code };
}

describe('opend validate', () => {
  const broken = mkdtempSync(join(tmpdir(), 'opend-broken-'));
  afterAll(() => rmSync(broken, { recursive: true, force: true }));
  writeFileSync(
    join(broken, 'opend.config.yaml'),
    'release: "1.0"\nmap: main.ditamap\nattributes:\n  product: [widget]\n',
  );
  writeFileSync(join(broken, 'main.ditamap'), '<map>\n<topicref href="a.dita"/>\n</map>');
  writeFileSync(
    join(broken, 'a.dita'),
    '<topic id="a"><title>A</title><body>\n<p><xref href="missing.dita"/></p>\n<note conref="chunks.dita#c/none"/>\n</body></topic>',
  );

  it('passes the starter template', async () => {
    const r = await run('validate', STARTER);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 error(s), 0 warning(s)');
  });

  it('fails with file:line diagnostics on broken links and missing chunks', async () => {
    const r = await run('validate', broken);
    expect(r.code).toBe(1);
    expect(r.err).toContain('a.dita:2:4: error [broken-link] link target not found: missing.dita');
    expect(r.err).toContain(
      'a.dita:3:1: error [missing-conref] conref file not found: chunks.dita',
    );
  });

  it('emits GitHub workflow annotations', async () => {
    const r = await run('validate', broken, '--format', 'github');
    expect(r.out).toContain(
      '::error file=a.dita,line=2,col=4,title=broken-link::link target not found: missing.dita',
    );
  });
});

describe('opend build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opend-out-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the release snapshot', async () => {
    const out = join(dir, 'release.json');
    const r = await run('build', STARTER, '--out', out);
    expect(r.code).toBe(0);
    const release = JSON.parse(readFileSync(out, 'utf8'));
    expect(release).toMatchObject({ schemaVersion: 1, release: '2.1' });
    expect(Object.keys(release.topics)).toHaveLength(8);
  });
});

describe('preview server', () => {
  let preview: PreviewServer;
  let base: string;
  beforeAll(async () => {
    preview = await startPreview({
      dir: STARTER,
      audience: (p) => ({ kind: 'named', name: 'v1-basic', context: p.contexts['v1-basic']! }),
      port: 0,
      watch: false,
    });
    base = preview.url.replace(/\/$/, '');
  });
  afterAll(() => preview.close());

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(base + path, { redirect: 'manual', headers });

  it('binds to localhost and redirects to the first visible topic', async () => {
    expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await get('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/topics/overview.html');
  });

  it('serves pages filtered for the reader and 404s hidden ones', async () => {
    const install = await (await get('/topics/install.html')).text();
    expect(install).toContain('Run the legacy installer');
    expect(install).not.toContain('Run the setup wizard');
    expect(install).toContain('v1-basic: org acme');
    expect((await get('/topics/audit-log.html')).status).toBe(404);
  });

  it('serves referenced assets and the theme, and nothing else from the tree', async () => {
    const logo = await get('/_assets/images/logo.svg');
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/svg+xml');
    expect((await get('/_theme.css')).status).toBe(200);
    expect((await get('/_assets/opend.config.yaml')).status).toBe(404);
    expect((await get('/_assets/internal/escalation.dita')).status).toBe(404);
    expect((await get('/_assets/../opend.config.yaml')).status).toBe(404);
  });

  it('switches audience with ?as= and a cookie', async () => {
    const res = await get('/topics/install.html?as=v2-pro');
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('opend-as=v2-pro');
    const page = await (await get('/topics/install.html', { cookie: 'opend-as=v2-pro' })).text();
    expect(page).toContain('Run the setup wizard');
    expect(page).not.toContain('Run the legacy installer');
    const staff = await (await get('/topics/install.html', { cookie: 'opend-as=all' })).text();
    expect(staff).toContain('data-applies="release=..1.9"');
  });

  it('serves embedded help for the preview reader, and the help lab', async () => {
    const sso = await (await get('/embed/context?app=console&key=settings.sso')).text();
    expect(sso).toContain('Configure the hub'); // v1-basic has no SSO: falls back to the parent key
    expect(sso).not.toContain('single sign-on');
    const self = base;
    const framed = await (
      await get(`/embed/topics/topics/install.html?host=${encodeURIComponent(self)}`)
    ).text();
    expect(framed).toContain(`data-host-origin="${self}"`);
    const foreign = await (
      await get('/embed/topics/topics/install.html?host=https%3A%2F%2Fevil.example')
    ).text();
    expect(foreign).not.toContain('data-host-origin');
    const widget = await get('/embed/opend-help.js');
    expect(widget.headers.get('content-type')).toContain('javascript');
    expect(await widget.text()).toContain('OpenDHelp');
    const lab = await (await get('/_opend/help-lab?path=/devices/1/pair')).text();
    expect(lab).toContain('<code>settings.sso</code>');
    expect(lab).toContain('(via default: overview)');
  });

  it('searches the preview reader’s view from the header search box', async () => {
    const page = await (await get('/topics/install.html')).text();
    expect(page).toContain(
      '<form class="site-search" role="search" method="get" action="/search">',
    );
    const res = await get('/search?q=installer');
    expect(res.status).toBe(200);
    const v1 = await res.text();
    expect(v1).toContain('<a href="/topics/install.html">');
    expect(v1).toContain('value="installer"');
    const wizard = await (await get('/search?q=wizard')).text();
    expect(wizard).toContain('No topics match <q>wizard</q>.');
    const pro = await (await get('/search?q=wizard', { cookie: 'opend-as=v2-pro' })).text();
    expect(pro).toContain('<a href="/topics/install.html">');
    // Hidden content never matches, even for the staff-only escalation topic.
    expect(await (await get('/search?q=escalation')).text()).toContain('No topics match');
    const xss = await (await get('/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E')).text();
    expect(xss).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(xss).not.toContain('<script>alert(1)');
    expect(await (await get('/search')).text()).toContain('Enter one or more words');
    // Switching audience on the search page keeps the query.
    const as = await get('/search?q=wizard&as=v2-pro');
    expect(as.status).toBe(303);
    expect(as.headers.get('location')).toBe('/search?q=wizard');
    expect(wizard).toContain('<input type="hidden" name="q" value="wizard">');
  });

  it('reports diagnostics as JSON', async () => {
    const res = await get('/_opend/diagnostics.json');
    expect(await res.json()).toEqual([]);
  });
});

describe('preview PDF publications', () => {
  let preview: PreviewServer;
  let base: string;
  const printed: string[] = [];
  const pdf: PdfRenderer = {
    render: async (html) => {
      printed.push(html);
      return Buffer.from('%PDF-1.7 fake');
    },
    close: async () => {},
  };
  beforeAll(async () => {
    preview = await startPreview({
      dir: STARTER,
      audience: (p) => ({ kind: 'named', name: 'v1-basic', context: p.contexts['v1-basic']! }),
      port: 0,
      watch: false,
      pdf,
    });
    base = preview.url.replace(/\/$/, '');
  });
  afterAll(() => preview.close());

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(base + path, { redirect: 'manual', headers });

  it('prints the publication for the preview reader', async () => {
    const res = await get('/pdf/admin-guide.pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="admin-guide.pdf"');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.7 fake');
    const html = printed.at(-1)!;
    expect(html).toContain('<h1>Widget Platform Administrator Guide</h1>');
    expect(html).toContain('Prepared for acme');
    expect(html).toContain('Run the legacy installer');
    expect(html).not.toContain('Configure single sign-on');
    expect(html).not.toContain('Audit log events');
    // Links to site topics point at the previewer; the theme is inlined.
    expect(html).toContain(`href="${base}/topics/configure.html"`);
    expect(html).toContain('--opend-accent');
  });

  it('follows the audience cookie and serves print HTML', async () => {
    const html = await (await get('/pdf/admin-guide.html', { cookie: 'opend-as=v2-pro' })).text();
    expect(html).toContain('Configure single sign-on');
    expect(html).toContain('Audit log events');
    expect(html).not.toContain('Run the legacy installer');
    expect(html).not.toContain('data-applies=');
  });

  it('404s unknown publications', async () => {
    expect((await get('/pdf/user-guide.pdf')).status).toBe(404);
    expect((await get('/pdf/../opend.config.pdf')).status).toBe(404);
  });

  it('lists publications and links them from pages', async () => {
    const index = await (await get('/_opend/publications')).text();
    expect(index).toContain('Widget Platform Administrator Guide');
    expect(index).toContain('href="/pdf/admin-guide.pdf"');
    const page = await (await get('/topics/install.html')).text();
    expect(page).toContain('href="/pdf/admin-guide.pdf"');
    expect(page).toContain('href="/_opend/publications"');
  });
});

describe('audienceFromOptions', () => {
  const contexts = { pro: { products: ['widget'], features: ['sso'], version: '2.1' } };

  it('defaults to the staff view', () => {
    expect(audienceFromOptions({}, contexts, '2.1')).toEqual({ kind: 'all' });
  });

  it('uses a named context or inline options, defaulting the version to the release', () => {
    expect(audienceFromOptions({ as: 'pro' }, contexts, '2.1')).toMatchObject({
      kind: 'named',
      name: 'pro',
    });
    expect(audienceFromOptions({ product: ['widget'] }, contexts, '2.1')).toEqual({
      kind: 'inline',
      context: { products: ['widget'], features: [], version: '2.1' },
    });
  });

  it('rejects unknown context names', () => {
    expect(() => audienceFromOptions({ as: 'nope' }, contexts, '2.1')).toThrow(
      /unknown preview context "nope" \(known: pro\)/,
    );
  });
});
