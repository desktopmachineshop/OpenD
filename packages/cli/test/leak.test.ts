import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReaderContext } from '@opend/model';
import { readerPolicy, resolveContext, viewRelease } from '@opend/filter';
import { renderIndex, renderNotFound, renderPage } from '@opend/render-html';
import { loadProject } from '../src/index.js';
import { MARKERS } from './markers.js';

const STARTER = join(import.meta.dirname, '../../../templates/docs-starter');

describe('no content leaks to readers who are not entitled to it', async () => {
  const project = await loadProject(STARTER);
  const release = project.build.release!;
  const readers: [string, ReaderContext][] = [
    ...Object.entries(project.contexts),
    ['nobody', { products: [], features: [], version: '0.1' }],
    ['sso-only-v1', { products: ['widget'], features: ['sso'], version: '1.2' }],
  ];

  it('has preview contexts to test', () => {
    expect(readers.length).toBeGreaterThanOrEqual(5);
  });

  describe.each(readers)('%s', (_name, context) => {
    const view = viewRelease(release, [...project.build.buildPolicies, readerPolicy(context)]);
    // Everything this reader can be served: every page id in the release, the
    // landing page and the not-found page.
    const html = [
      ...Object.keys(release.topics).map((id) => renderPage(view, id) ?? ''),
      renderIndex(view),
      renderNotFound(view),
    ].join('\n');

    it.each(MARKERS)('%s', (phrase, rule) => {
      expect(html.includes(phrase)).toBe(rule(context));
    });

    it('never exposes filtering attributes or build internals', () => {
      expect(html).not.toMatch(
        /data-applies=|opend-target=|opend-asset=|<opend-cond|<opend-choice/,
      );
      expect(html).not.toMatch(/\b(product|feature|release|audience)="/);
    });

    it('resolves every help context and route to a topic this reader can see', () => {
      const app = release.contexts!['console']!;
      const requests = [
        ...Object.keys(app.keys).map((key) => ({ app: 'console', key })),
        ...app.routes.map((r) => ({
          app: 'console',
          path: r.pattern.replace(/:\w+/g, 'x').replace('/**', '/a/b'),
        })),
      ];
      for (const request of requests) {
        const resolved = resolveContext(view, request);
        expect(resolved, JSON.stringify(request)).not.toBeNull();
        expect(view.isVisible(resolved!.topicId), JSON.stringify(request)).toBe(true);
      }
      const whatsNew = resolveContext(view, { app: 'console', key: 'whats-new' })!.topicId;
      const major = context.version.split('.')[0];
      // Readers on neither release line see no notes, so the key falls back to the default.
      const expected = { '1': 'topics/release-notes-1', '2': 'topics/release-notes-2' }[
        major ?? ''
      ];
      expect(whatsNew).toBe(expected ?? 'topics/overview');
    });

    it('serves only pages reachable from its navigation', () => {
      for (const id of Object.keys(release.topics)) {
        const page = renderPage(view, id);
        if (page) expect(view.topicIds()).toContain(id);
      }
    });
  });
});
