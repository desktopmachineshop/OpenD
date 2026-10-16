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

  it('reports diagnostics as JSON', async () => {
    const res = await get('/_opend/diagnostics.json');
    expect(await res.json()).toEqual([]);
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
