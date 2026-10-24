import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatDiagnostic } from '@opend/model';
import { buildRelease, readDirectory, readGitRef, type SourceTree } from '../src/index.js';

const STARTER = join(import.meta.dirname, '../../../templates/docs-starter');

function tree(files: Record<string, string>): SourceTree {
  return { files: new Set(Object.keys(files)), texts: new Map(Object.entries(files)) };
}

describe('buildRelease on the starter template', async () => {
  const result = buildRelease(await readDirectory(STARTER), {
    now: new Date('2026-10-16T00:00:00Z'),
  });
  const release = result.release!;

  it('builds without diagnostics', () => {
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it('compiles every published topic and drops build-time exclusions', () => {
    expect(Object.keys(release.topics).sort()).toEqual([
      'topics/audit-log',
      'topics/configure',
      'topics/configure-sso',
      'topics/gadget-pairing',
      'topics/install',
      'topics/overview',
      'topics/release-notes-1',
      'topics/release-notes-2',
    ]);
    expect(JSON.stringify(release)).not.toContain('INTERNAL:');
    expect(JSON.stringify(release)).not.toContain('escalation');
  });

  it('indexes reusable chunks by the pages that use them', () => {
    expect(release.chunkUsage).toEqual({
      'reuse/common.dita#common/power-warning': ['topics/install'],
      'reuse/common.dita#common/step-restart': ['topics/configure', 'topics/install'],
      'reuse/common.dita#common/support-contact': ['topics/overview'],
    });
  });

  it('records assets, publications and release metadata', () => {
    expect(release.assets).toEqual(['images/logo.svg']);
    expect(release.release).toBe('2.1');
    expect(release.theme).toBe('theme/site.css');
    expect(release.publications).toHaveLength(1);
    expect(release.publications[0]?.title).toBe('Widget Platform Administrator Guide');
  });
});

describe('buildRelease diagnostics', () => {
  it('rejects a missing or invalid config', () => {
    expect(buildRelease(tree({})).diagnostics[0]?.code).toBe('missing-config');
    const bad = buildRelease(
      tree({ 'opend.config.yaml': 'release: "1"\nmap: ../x.ditamap\nattributes: {release: [a]}' }),
    );
    expect(bad.release).toBeNull();
    expect(bad.diagnostics.map((d) => d.message).join('\n')).toMatch(
      /inside the docs root[\s\S]*version ranges/,
    );
  });

  it('reports broken references with file and line, and still builds what it can', () => {
    const result = buildRelease(
      tree({
        'opend.config.yaml': 'release: "1.0"\nmap: main.ditamap\n',
        'main.ditamap': '<map>\n<topicref href="a.dita"/>\n<topicref href="gone.dita"/>\n</map>',
        'a.dita': '<topic id="a"><title>A</title><body>\n<p conref="b.dita#b/x"/>\n</body></topic>',
      }),
    );
    expect(result.release?.topics['a']).toBeDefined();
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'a.dita:2:1: error [missing-conref] conref file not found: b.dita',
      'main.ditamap:3:1: error [missing-topic] topic not found: gone.dita',
    ]);
  });

  it('records the logo, and reports a missing one', () => {
    const files = {
      'main.ditamap': '<map><topicref href="a.dita"/></map>',
      'a.dita': '<topic id="a"><title>A</title></topic>',
    };
    const ok = buildRelease(
      tree({
        ...files,
        'opend.config.yaml': 'release: "1.0"\nmap: main.ditamap\nlogo: logo.svg\n',
        'logo.svg': '<svg/>',
      }),
    );
    expect(ok.diagnostics).toEqual([]);
    expect(ok.release?.logo).toBe('logo.svg');
    const missing = buildRelease(
      tree({
        ...files,
        'opend.config.yaml': 'release: "1.0"\nmap: main.ditamap\nlogo: gone.png\n',
      }),
    );
    expect(missing.diagnostics.map((d) => d.code)).toEqual(['missing-logo']);
  });

  it('records the PDF template settings, and rejects unknown ones', () => {
    const files = {
      'main.ditamap': '<map><topicref href="a.dita"/></map>',
      'a.dita': '<topic id="a"><title>A</title></topic>',
    };
    const config = 'release: "1.0"\nmap: main.ditamap\npdf:\n  template: report\n  toc: false\n';
    const ok = buildRelease(tree({ ...files, 'opend.config.yaml': config }));
    expect(ok.diagnostics).toEqual([]);
    expect(ok.release?.pdf).toEqual({ template: 'report', toc: false });
    const bad = buildRelease(
      tree({ ...files, 'opend.config.yaml': config.replace('toc: false', 'paper: A3') }),
    );
    expect(bad.diagnostics.map((d) => d.code)).toEqual(['invalid-config']);
  });
});

describe('readGitRef', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opend-git-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the docs tree at a ref, relative to a subdirectory', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/a.dita'), '<topic id="a"><title>v1</title></topic>');
    writeFileSync(join(dir, 'docs/logo.png'), 'png');
    git('add', '.');
    git('commit', '-q', '-m', 'v1');
    git('tag', 'v1');
    writeFileSync(join(dir, 'docs/a.dita'), '<topic id="a"><title>v2</title></topic>');

    const t = await readGitRef(join(dir, 'docs'), 'v1');
    expect([...t.files].sort()).toEqual(['a.dita', 'logo.png']);
    expect(t.texts.get('a.dita')).toContain('v1');
    expect(t.texts.has('logo.png')).toBe(false);
    expect(t.ref).toBe('v1');
  });
});

describe('context-sensitive help', () => {
  const base = {
    'opend.config.yaml': 'release: "1.0"\nmap: m.ditamap\nattributes:\n  product: [gadget]\n',
    'a.dita':
      '<topic id="a"><title>A</title><prolog><resourceid appname="app" appid="settings"/></prolog></topic>',
    'b.dita':
      '<topic id="b"><title>B</title><prolog><resourceid appname="app" appid="settings"/></prolog>\n<body><p>x</p></body></topic>',
  };

  it('indexes map and topic resourceids, map first', () => {
    const result = buildRelease(
      tree({
        ...base,
        'b.dita': '<topic id="b"><title>B</title></topic>',
        'm.ditamap':
          '<map><topicref href="b.dita"><topicmeta><resourceid appname="app" appid="settings" product="gadget"/></topicmeta></topicref><topicref href="a.dita"/></map>',
        'help-contexts.yaml':
          'apps:\n  app:\n    default: settings\n    routes:\n      /settings/**: settings.network\n',
      }),
    );
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([]);
    expect(result.release?.contexts).toEqual({
      app: {
        default: 'settings',
        routes: [{ pattern: '/settings/**', key: 'settings.network' }],
        keys: {
          settings: [
            { topicId: 'b', conditions: [{ product: 'gadget' }] },
            { topicId: 'a', conditions: [] },
          ],
        },
      },
    });
  });

  it('reports ambiguous keys, incomplete resourceids and bad help-contexts.yaml', () => {
    const result = buildRelease(
      tree({
        ...base,
        'c.dita':
          '<topic id="c"><title>C</title><prolog><resourceid appid="orphan"/></prolog></topic>',
        'm.ditamap':
          '<map><topicref href="a.dita"/><topicref href="b.dita"/><topicref href="c.dita"/></map>',
        'help-contexts.yaml':
          'apps:\n  app:\n    default: missing\n    routes:\n      /x/**/y: settings\n      /ok: nothing.here\n      relative: settings\n',
      }),
    );
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'b.dita:1:39: error [duplicate-context] context app/settings already points at a; add conditions or use a different appid',
      'c.dita:1:39: error [invalid-resourceid] resourceid needs both appname (the host app) and appid (the context key)',
      'help-contexts.yaml: error [invalid-help-contexts] apps.app.routes "/x/**/y": ** is only allowed as the last segment',
      'help-contexts.yaml: error [invalid-help-contexts] apps.app.routes "relative": must start with /',
      'help-contexts.yaml: error [unknown-context] route /ok maps to app/nothing.here, but no topic has that resourceid (or a parent key)',
      'help-contexts.yaml: error [unknown-context] default for app is missing, but no topic has that resourceid',
    ]);
  });

  it('rejects a malformed help-contexts.yaml', () => {
    const result = buildRelease(
      tree({
        ...base,
        'm.ditamap': '<map><topicref href="a.dita"/></map>',
        'help-contexts.yaml': 'apps:\n  bad name:\n    routes: {}\n',
      }),
    );
    expect(result.diagnostics.map((d) => d.code)).toContain('invalid-help-contexts');
  });
});
