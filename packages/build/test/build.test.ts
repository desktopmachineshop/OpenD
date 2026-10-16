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
