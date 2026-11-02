import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  audienceFromOptions,
  createProgram,
  startPreview,
  zipFiles,
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

/** The files in a zip archive, by path; enough of the format to check `zipFiles`. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    at += 46 + nameLength;
  }
  return files;
}

describe('opend package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opend-package-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses to guess who the package is for', async () => {
    const r = await run('package', STARTER, '--out', join(dir, 'none.zip'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('choose who the package is for');
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes a reader's docs as a zip of a static site with relative links", async () => {
    const out = join(dir, 'widget-docs.zip');
    const r = await run('package', STARTER, '--as', 'v2-basic', '--out', out);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Packaged for v2-basic');
    const files = unzip(readFileSync(out));
    const paths = [...files.keys()];
    expect(paths.every((p) => p.startsWith('widget-docs/'))).toBe(true);
    expect(paths).toContain('widget-docs/index.html');
    expect(paths).toContain('widget-docs/_theme.css');
    expect(paths).toContain('widget-docs/_assets/images/logo.svg');
    const page = files.get('widget-docs/topics/overview.html')!.toString('utf8');
    expect(page).toContain('href="../_theme.css"');
    expect(page).toContain('src="../_assets/images/logo.svg"');
    expect(page).toContain('class="site-title" href="../index.html"');
    for (const [path, data] of files) {
      if (!path.endsWith('.html')) continue;
      const html = data.toString('utf8');
      // Nothing that needs a server: no root-relative URLs, no search form, no scripts.
      expect(html, path).not.toMatch(/(?:href|src|action)="\//);
      expect(html, path).not.toContain('role="search"');
      expect(html, path).not.toContain('<script');
    }
  });

  it('leaves out topics and images the reader cannot see', async () => {
    const project = join(dir, 'gated');
    mkdirSync(join(project, 'images'), { recursive: true });
    writeFileSync(
      join(project, 'opend.config.yaml'),
      'release: "1.0"\ntitle: Gated\nmap: main.ditamap\nattributes:\n  product: [free, paid]\n',
    );
    writeFileSync(
      join(project, 'main.ditamap'),
      '<map><topicref href="a.dita"/><topicref href="secret.dita" product="paid"/></map>',
    );
    writeFileSync(join(project, 'a.dita'), '<topic id="a"><title>Open</title><body/></topic>');
    writeFileSync(
      join(project, 'secret.dita'),
      '<topic id="s"><title>Secret plan</title><body><image href="images/plan.svg"/></body></topic>',
    );
    writeFileSync(join(project, 'images/plan.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const free = join(dir, 'free');
    expect((await run('package', project, '--product', 'free', '--out', free)).code).toBe(0);
    expect(readdirSync(free).sort()).toEqual(['a.html', 'index.html']);
    expect(readFileSync(join(free, 'index.html'), 'utf8')).not.toContain('Secret plan');

    const paid = join(dir, 'paid');
    expect((await run('package', project, '--product', 'paid', '--out', paid)).code).toBe(0);
    expect(readdirSync(paid).sort()).toEqual(['_assets', 'a.html', 'index.html', 'secret.html']);

    // An existing folder with files in it is never written into.
    await expect(run('package', project, '--product', 'paid', '--out', paid)).rejects.toThrow(
      'is not empty',
    );
  });
});

describe('zipFiles', () => {
  it('round-trips stored and deflated entries with UTF-8 names', () => {
    const files = new Map([
      ['a/ä.html', Buffer.from('<p>'.repeat(500))],
      ['b.bin', Buffer.from([1, 2, 3])],
    ]);
    expect(unzip(zipFiles(files))).toEqual(files);
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
