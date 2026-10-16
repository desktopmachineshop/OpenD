import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textContent, walk, type ElementNode, type ReaderContext } from '@opend/model';
// Not a dependency of the CLI; imported by path, like the shared leak markers.
import { SUPPORTED_ELEMENTS } from '../../dita/src/elements.js';
import {
  readerPolicy,
  resolveContext,
  viewPublication,
  viewRelease,
  type FilterPolicy,
} from '@opend/filter';
import { renderIndex, renderNotFound, renderPage, renderPublication } from '@opend/render-html';
import { loadProject, startPreview, type PreviewServer } from '../src/index.js';

// OpenD's own documentation (site/) is a real docs project. These tests keep it
// building cleanly, rendering for every reader, and in step with the code it
// documents.

const ROOT = join(import.meta.dirname, '../../..');
const SITE = join(ROOT, 'site');

/** Every TypeScript source file of the packages. */
function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    const dir = join(ROOT, 'packages', pkg, 'src');
    let entries: string[];
    try {
      entries = readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.ts'))
        out.push({ file: entry, text: readFileSync(join(dir, entry), 'utf8') });
    }
  }
  return out;
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

describe('the OpenD documentation site', async () => {
  const project = await loadProject(SITE);
  const release = project.build.release!;
  const build = project.build.buildPolicies;

  /** A compiled topic's body, by page id. */
  const body = (id: string): ElementNode => {
    const topic = release.topics[id];
    if (!topic) throw new Error(`no topic ${id}`);
    return topic.body;
  };
  /** Elements in a topic matching a predicate. */
  const find = (id: string, match: (el: ElementNode) => boolean): ElementNode[] => {
    const found: ElementNode[] = [];
    walk(body(id), (el) => {
      if (match(el)) found.push(el);
    });
    return found;
  };

  it('builds and validates with no errors or warnings', () => {
    expect([...project.diagnostics, ...project.contextDiagnostics]).toEqual([]);
    expect(release.release).toBe('0.1');
    expect(Object.keys(release.topics).length).toBeGreaterThanOrEqual(50);
  });

  it('documents the release of the packages', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version.split('.').slice(0, 2).join('.')).toBe(release.release);
  });

  it('removes maintainer notes at build time', () => {
    expect(release.topics['internal/maintainers']).toBeUndefined();
    expect(JSON.stringify(release)).not.toContain('audience="internal"');
  });

  describe('reference topics stay in step with the code', () => {
    const all = sources();

    it('lists every supported DITA element', () => {
      const listed = find('topics/authoring/dita-subset', (el) => el.name === 'strow').map((row) =>
        textContent(row.children.find((c): c is ElementNode => c.type === 'element')!),
      );
      expect(sorted(listed)).toEqual(sorted(SUPPORTED_ELEMENTS));
      expect(listed.length).toBe(SUPPORTED_ELEMENTS.size);
    });

    it('explains every diagnostic code the packages emit', () => {
      const emitted = new Set<string>();
      for (const { text } of all) {
        for (const m of text.matchAll(/\bcode: '([a-z-]+)'/g)) emitted.add(m[1]!);
        for (const m of text.matchAll(
          /\b(?:diag|report)\(\s*[\w.]+,\s*(?:[\w.]+,\s*)?'(?:error|warning)',\s*'([a-z-]+)'/g,
        ))
          emitted.add(m[1]!);
      }
      const documented = find(
        'topics/authoring/diagnostics',
        (el) => el.name === 'strow' && Boolean(el.attrs.id),
      ).map((row) => row.attrs.id!);
      expect(emitted.size).toBeGreaterThan(25);
      expect(sorted(documented)).toEqual(sorted(emitted));
    });

    it('lists every environment variable the server and the PDF renderer read', () => {
      const config = readFileSync(join(ROOT, 'packages/server/src/config.ts'), 'utf8');
      const schema = config.slice(
        config.indexOf('const envSchema'),
        config.indexOf('export interface'),
      );
      const read = new Set([...schema.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!));
      // Test helpers (testing.ts) read TEST_DATABASE_URL and CI; servers never do.
      for (const { text } of all.filter((s) => !s.file.endsWith('testing.ts')))
        for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) read.add(m[1]!);
      const documented = find('topics/hosting/env-vars', (el) => el.name === 'property').map(
        (p) => p.attrs.id!,
      );
      expect(read.size).toBeGreaterThan(25);
      expect(sorted(documented)).toEqual(sorted(read));
    });

    it('lists every environment variable the web editor reads', () => {
      const config = readFileSync(join(ROOT, 'packages/editor/src/config.ts'), 'utf8');
      const schema = config.slice(config.indexOf('const envSchema'), config.indexOf('.refine('));
      const read = new Set([...schema.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!));
      const documented = find('topics/hosting/editor', (el) => el.name === 'property').map(
        (p) => p.attrs.id!,
      );
      expect(read.size).toBeGreaterThan(15);
      expect(sorted(documented)).toEqual(sorted(read));
    });

    it('lists every admin API route', () => {
      const admin = readFileSync(join(ROOT, 'packages/server/src/admin.ts'), 'utf8');
      const routes = [...admin.matchAll(/scope\.(get|post|put|delete)\('([^']+)'/g)].map(
        (m) => `${m[1]!.toUpperCase()} /admin/api${m[2]!}`,
      );
      const documented = find('topics/hosting/admin-api', (el) => el.name === 'codeph')
        .map((el) => textContent(el))
        .filter((t) => /^(GET|POST|PUT|DELETE) \/admin\/api/.test(t));
      expect(routes.length).toBeGreaterThan(10);
      expect(sorted(documented)).toEqual(sorted(routes));
    });
  });

  const readers: [string, ReaderContext | null][] = [
    ['staff', null],
    ...Object.entries(project.contexts),
  ];

  it('has a preview reader for each kind of reader the docs gate for', () => {
    expect(Object.keys(project.contexts)).toEqual(
      expect.arrayContaining(['author', 'admin', 'developer', 'self-hoster', 'managed-customer']),
    );
  });

  describe.each(readers)('as %s', (name, context) => {
    const policies: FilterPolicy[] = [...build, ...(context ? [readerPolicy(context)] : [])];
    const view = viewRelease(release, policies, { resolveChoices: context !== null });
    const pages = Object.keys(release.topics)
      .map((id) => [id, renderPage(view, id, { showConditions: context === null })] as const)
      .filter((p): p is readonly [string, string] => p[1] !== null);
    const html = [...pages.map((p) => p[1]), renderIndex(view), renderNotFound(view)].join('\n');

    it('renders every page it can see, and only those', () => {
      expect(pages.length).toBeGreaterThan(25);
      expect(sorted(pages.map((p) => p[0]))).toEqual(sorted(view.topicIds()));
      for (const [, page] of pages) expect(page).toMatch(/<h1 class="title">/);
    });

    it.runIf(context !== null)('never exposes filtering attributes or build internals', () => {
      expect(html).not.toMatch(
        /data-applies=|opend-target=|opend-asset=|<opend-cond|<opend-choice/,
      );
      expect(html).not.toMatch(/\b(product|feature|release|audience)="/);
    });

    it('resolves every help key and route to a topic this reader can see', () => {
      const app = release.contexts!['opend-console']!;
      const requests = [
        ...Object.keys(app.keys).map((key) => ({ app: 'opend-console', key })),
        ...app.routes.map((r) => ({
          app: 'opend-console',
          path: r.pattern.replace(/:\w+/g, 'x').replace('/**', '/a/b'),
        })),
      ];
      for (const request of requests) {
        const resolved = resolveContext(view, request);
        expect(resolved, JSON.stringify(request)).not.toBeNull();
        expect(view.isVisible(resolved!.topicId)).toBe(true);
      }
    });

    describe.each(release.publications.map((p) => [p.title, p.file] as const))(
      'PDF publication %s',
      (_title, file) => {
        const publication = viewPublication(release, file, policies, {
          resolveChoices: context !== null,
        })!;
        let print = '';
        beforeAll(async () => {
          print = await renderPublication(publication, {
            site: view,
            siteBase: 'https://docs.example.com/',
            assets: async (path) => readFileSync(join(SITE, path)),
            themeCss: readFileSync(join(SITE, release.theme!), 'utf8'),
          });
        });

        it('renders its print HTML with a cover, contents and the theme', () => {
          expect(publication.topicIds().length).toBeGreaterThan(0);
          expect(print).toContain(`<h1>${publication.publication.title}</h1>`);
          expect(print).toContain('<nav class="pub-toc"');
          expect(print).toContain('--opend-brand');
          for (const id of publication.topicIds()) expect(view.isVisible(id)).toBe(true);
        });

        it('has working in-document links and embedded images', () => {
          const ids = new Set([...print.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
          for (const [, target] of print.matchAll(/href="#([^"]+)"/g))
            expect(ids.has(target), target).toBe(true);
          expect(print).not.toMatch(/<img[^>]+src="(?!data:)/);
        });

        it.runIf(context !== null)('never exposes filtering attributes', () => {
          expect(print).not.toMatch(/\b(product|feature|release|audience)="/);
        });
      },
    );
  });

  it('gates sections by product and feature', () => {
    const visible = (name: string) => {
      const view = viewRelease(release, [...build, readerPolicy(project.contexts[name]!)]);
      return (id: string) => view.isVisible(id);
    };
    const selfHoster = visible('self-hoster');
    expect(selfHoster('topics/hosting/env-vars')).toBe(true);
    expect(selfHoster('topics/help/widget')).toBe(false);
    expect(selfHoster('topics/hosting/managed-site')).toBe(false);
    const managed = visible('managed-customer');
    expect(managed('topics/help/widget')).toBe(true);
    expect(managed('topics/hosting/managed-site')).toBe(true);
    expect(managed('topics/hosting/docker-compose')).toBe(false);
    expect(managed('topics/start/install-cli')).toBe(true);
    expect(visible('admin')('topics/next/console')).toBe(true);
    expect(visible('developer')('topics/next/console')).toBe(false);
    // The web editor: authors on either product, its hosting guide for self-hosters only.
    expect(visible('author')('topics/editor/editor')).toBe(true);
    expect(visible('author')('topics/hosting/editor')).toBe(false);
    expect(visible('self-hoster')('topics/hosting/editor')).toBe(true);
  });

  it('drops the self-hosting chapter from a managed customer’s Administrator Guide', () => {
    const titles = (name: string) =>
      viewPublication(release, 'maps/admin-guide.bookmap', [
        ...build,
        readerPolicy(project.contexts[name]!),
      ])!.nav.map((e) => e.title);
    expect(titles('self-hoster')).toContain('Self-hosting');
    expect(titles('managed-customer')).not.toContain('Self-hosting');
  });

  describe('in the previewer', () => {
    let preview: PreviewServer;
    beforeAll(async () => {
      preview = await startPreview({
        dir: SITE,
        audience: { kind: 'named', name: 'admin', context: project.contexts['admin']! },
        port: 0,
        watch: false,
        pdf: { render: async () => Buffer.from('%PDF-'), close: async () => {} },
      });
    });
    afterAll(() => preview?.close());
    const get = (path: string) => fetch(new URL(path, preview.url), { redirect: 'manual' });

    it('serves pages, the theme and the diagrams', async () => {
      expect((await get('/topics/overview.html')).status).toBe(200);
      expect(await (await get('/_theme.css')).text()).toContain('--opend-brand');
      const svg = await get('/_assets/images/architecture.svg');
      expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    });

    it('lists both publications and serves their print HTML', async () => {
      const index = await (await get('/_opend/publications')).text();
      expect(index).toContain('OpenD Administrator Guide');
      expect(index).toContain('OpenD Author Guide');
      const print = await get('/pdf/author-guide.html');
      expect(print.status).toBe(200);
      expect(await print.text()).toContain('data:image/svg+xml;base64,');
    });

    it('opens a help key that names a section at its anchor', async () => {
      const res = await get('/embed/context?app=opend-console&key=builds');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(
        '/embed/topics/topics/hosting/admin-api.html?app=opend-console#builds',
      );
      const lab = await (await get('/_opend/help-lab')).text();
      expect(lab).toContain('href="/topics/hosting/admin-api.html#builds"');
    });
  });
});
