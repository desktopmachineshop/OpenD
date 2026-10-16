import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReaderContext } from '@opend/model';
import { readerPolicy, viewRelease } from '@opend/filter';
import { renderIndex, renderNotFound, renderPage } from '@opend/render-html';
import { loadProject } from '../src/index.js';

const STARTER = join(import.meta.dirname, '../../../templates/docs-starter');

type Rule = (c: ReaderContext) => boolean;
const has =
  (field: 'products' | 'features', value: string): Rule =>
  (c) =>
    c[field].includes(value);
const major = (c: ReaderContext) => Number(c.version.split('.')[0]);
const v2: Rule = (c) => major(c) >= 2;
const all =
  (...rules: Rule[]): Rule =>
  (c) =>
    rules.every((r) => r(c));
const never: Rule = () => false;

/**
 * Phrases from the starter template and who may see them. Each phrase appears
 * only in content with exactly that condition.
 */
const MARKERS: [string, Rule][] = [
  ['Run the legacy installer', (c) => !v2(c)],
  ['Run the setup wizard', v2],
  ['Release notes for 1.x', (c) => major(c) === 1],
  ['Release notes for 2.x', v2],
  ['Pair the Gadget after installing', has('products', 'gadget')],
  ['Your licence includes the Gadget', has('products', 'gadget')],
  ['Pair a Gadget', has('products', 'gadget')],
  ['>Gadget<', has('products', 'gadget')],
  ['Single sign-on is available', has('features', 'sso')],
  ['Configure single sign-on', has('features', 'sso')],
  ['Enterprise Edition', has('features', 'sso')],
  ['Standard Edition', (c) => !has('features', 'sso')(c)],
  ['Just-in-time provisioning', all(has('features', 'sso'), v2)],
  ['Audit log events', all(has('features', 'audit-log'), v2)],
  ['sso.assertion', all(has('features', 'audit-log'), has('features', 'sso'), v2)],
  ['INTERNAL:', never],
  ['Escalation procedure', never],
  ['staff paging tool', never],
];

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

    it('serves only pages reachable from its navigation', () => {
      for (const id of Object.keys(release.topics)) {
        const page = renderPage(view, id);
        if (page) expect(view.topicIds()).toContain(id);
      }
    });
  });
});
