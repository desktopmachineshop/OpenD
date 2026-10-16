import { describe, expect, it } from 'vitest';
import {
  CONFLICT_MINE,
  CONFLICT_THEIRS,
  EDITOR_CSP,
  PREVIEW_CSP,
  checkEditablePath,
  docsPrefix,
  editorScript,
  elementIds,
  evaluateReview,
  hasConflictMarkers,
  loadEditorConfig,
  merge3,
  rulesFromRulesets,
  topicTemplate,
  wellFormedness,
  type Requirements,
} from '../src/index.js';

const lines = (...l: string[]) => l.join('\n');

describe('merge3', () => {
  const base = lines(
    '<topic id="t">',
    '<title>T</title>',
    '<p>one</p>',
    '<p>two</p>',
    '<p>three</p>',
    '</topic>',
  );

  it('combines edits to separate sections', () => {
    const ours = base.replace('<p>one</p>', '<p>ONE</p>');
    const theirs = base.replace('<p>three</p>', '<p>THREE</p>');
    const result = merge3(base, ours, theirs);
    expect(result).toEqual({
      clean: true,
      text: base.replace('<p>one</p>', '<p>ONE</p>').replace('<p>three</p>', '<p>THREE</p>'),
    });
  });

  it('takes the only side that changed, and identical changes once', () => {
    const ours = base.replace('two', '2');
    expect(merge3(base, ours, base)).toEqual({ clean: true, text: ours });
    expect(merge3(base, base, ours)).toEqual({ clean: true, text: ours });
    expect(merge3(base, ours, ours)).toEqual({ clean: true, text: ours });
  });

  it('marks overlapping edits as conflicts', () => {
    const result = merge3(base, base.replace('two', 'mine'), base.replace('two', 'theirs'));
    expect(result.clean).toBe(false);
    expect(result.text).toContain(
      `${CONFLICT_MINE}\n<p>mine</p>\n=======\n<p>theirs</p>\n${CONFLICT_THEIRS}`,
    );
    expect(hasConflictMarkers(result.text)).toBe(true);
    expect(result.text.startsWith('<topic id="t">\n<title>T</title>\n<p>one</p>')).toBe(true);
  });

  it('handles insertions at the same place and deletions', () => {
    const ours = base.replace('<p>three</p>', '<p>three</p>\n<p>four</p>');
    const theirs = base.replace('<p>one</p>\n', '');
    expect(merge3(base, ours, theirs)).toEqual({
      clean: true,
      text: base.replace('<p>one</p>\n', '').replace('<p>three</p>', '<p>three</p>\n<p>four</p>'),
    });
    const a = base.replace('</topic>', '<p>a</p>\n</topic>');
    const b = base.replace('</topic>', '<p>b</p>\n</topic>');
    expect(merge3(base, a, b).clean).toBe(false);
  });

  it('collects element ids', () => {
    expect([...elementIds('<a id="x"><b id=\'y\'/><c xid="no"/></a>')]).toEqual(['x', 'y']);
  });
});

describe('review rules', () => {
  const req = (over: Partial<Requirements> = {}): Requirements => ({
    known: true,
    sources: [],
    requiredApprovals: 0,
    codeOwnerReview: false,
    requiredChecks: [],
    notes: [],
    ...over,
  });

  it('allows merging when nothing is required', () => {
    expect(evaluateReview(req(), null, [], []).canMerge).toBe(true);
  });

  it('lists missing approvals, pending checks and requested changes', () => {
    const state = evaluateReview(
      req({ requiredApprovals: 2, requiredChecks: ['ci', 'lint'] }),
      null,
      [
        { user: 'carol', state: 'APPROVED', submittedAt: null },
        { user: 'dan', state: 'CHANGES_REQUESTED', submittedAt: null },
      ],
      [{ context: 'ci', state: 'failure' }],
    );
    expect(state.canMerge).toBe(false);
    expect(state.blockers).toEqual([
      'Changes requested by dan.',
      'Needs 2 approving reviews (has 1).',
      'Required check "ci" failed.',
      'Required check "lint" has not passed yet.',
    ]);
  });

  it('counts the latest decisive review per reviewer', () => {
    const state = evaluateReview(
      req({ requiredApprovals: 1 }),
      null,
      [
        { user: 'dan', state: 'CHANGES_REQUESTED', submittedAt: null },
        { user: 'dan', state: 'COMMENTED', submittedAt: null },
        { user: 'dan', state: 'APPROVED', submittedAt: null },
      ],
      [],
    );
    expect(state).toMatchObject({ approvedBy: ['dan'], changesRequestedBy: [], canMerge: true });
  });

  it('never auto-merges when the rules could not be read', () => {
    expect(evaluateReview(req({ known: false }), null, [], []).canMerge).toBe(false);
  });

  it('merges ruleset rules', () => {
    expect(
      rulesFromRulesets([
        { type: 'deletion' },
        { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
        {
          type: 'pull_request',
          parameters: { required_approving_review_count: 2, require_code_owner_review: true },
        },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'ci' }] },
        },
      ]),
    ).toEqual({ requiredApprovals: 2, codeOwnerReview: true, requiredChecks: ['ci'] });
  });
});

describe('paths and sources', () => {
  it('accepts only DITA files inside the docs root', () => {
    expect(checkEditablePath('topics/install.dita')).toBe('topics/install.dita');
    expect(checkEditablePath('maps/user-guide.ditamap')).toBe('maps/user-guide.ditamap');
    for (const bad of [
      '../x.dita',
      '/etc/x.dita',
      'topics//x.dita',
      'opend.config.yaml',
      '.git/x.dita',
      'a\\b.dita',
      'topics/x.dita.js',
    ])
      expect(() => checkEditablePath(bad), bad).toThrow();
  });

  it('turns docs_path into a prefix', () => {
    expect(docsPrefix('.')).toBe('');
    expect(docsPrefix('docs/')).toBe('docs/');
    expect(docsPrefix('./site/docs')).toBe('site/docs/');
    expect(() => docsPrefix('../x')).toThrow();
  });

  it('checks well-formedness and leftover conflict markers', () => {
    expect(wellFormedness('a.dita', '<topic id="a"><title>A</title></topic>')).toEqual([]);
    expect(wellFormedness('a.dita', '<topic><title>A</topic>')[0]).toMatchObject({
      code: 'xml-syntax',
    });
    expect(wellFormedness('a.dita', `<topic>\n${CONFLICT_MINE}\n</topic>`)[0]).toMatchObject({
      code: 'conflict-markers',
    });
  });

  it('makes templates that are well-formed and escape the title', () => {
    for (const type of ['concept', 'task', 'reference', 'topic'] as const) {
      const source = topicTemplate(type, 'new-one', 'Fish & <chips>');
      expect(wellFormedness('t.dita', source)).toEqual([]);
      expect(source).toContain('<title>Fish &amp; &lt;chips&gt;</title>');
    }
  });
});

describe('config', () => {
  const env = {
    DATABASE_URL: 'postgres://x/y',
    EDITOR_PUBLIC_URL: 'https://edit.example.com/',
    EDITOR_SESSION_SECRET: 'x'.repeat(32),
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'key',
    GITHUB_OAUTH_CLIENT_ID: 'id',
    GITHUB_OAUTH_CLIENT_SECRET: 'secret',
  };

  it('loads a minimal configuration', () => {
    const config = loadEditorConfig(env);
    expect(config).toMatchObject({
      publicUrl: 'https://edit.example.com',
      baseBranch: 'main',
      port: 3001,
    });
    expect(config.githubOAuth?.webUrl).toBe('https://github.com');
    expect(loadEditorConfig({ ...env, OPEND_SITE_REPO: 'acme/docs' }).repo).toBe('acme/docs');
    expect(
      loadEditorConfig({ ...env, EDITOR_REPO: 'acme/x', OPEND_SITE_REPO: 'acme/docs' }).repo,
    ).toBe('acme/x');
  });

  it('requires the GitHub App, a long secret and a sign-in method', () => {
    expect(() => loadEditorConfig({ ...env, GITHUB_APP_ID: undefined })).toThrow(/GITHUB_APP_ID/);
    expect(() => loadEditorConfig({ ...env, EDITOR_SESSION_SECRET: 'short' })).toThrow(/32/);
    expect(() =>
      loadEditorConfig({
        ...env,
        GITHUB_OAUTH_CLIENT_ID: undefined,
        GITHUB_OAUTH_CLIENT_SECRET: undefined,
      }),
    ).toThrow(/at least one sign-in/);
    expect(() =>
      loadEditorConfig({ ...env, EDITOR_OIDC_ISSUER: 'https://idp.example.com' }),
    ).toThrow(/EDITOR_OIDC_CLIENT_ID/);
  });

  it('refuses to share the docs site host', () => {
    expect(() => loadEditorConfig({ ...env, PUBLIC_URL: 'https://edit.example.com' })).toThrow(
      /own host/,
    );
    expect(() =>
      loadEditorConfig({
        ...env,
        NODE_ENV: 'production',
        EDITOR_PUBLIC_URL: 'https://docs.example.com:8443',
        PUBLIC_URL: 'https://docs.example.com',
      }),
    ).toThrow(/own host/);
    expect(loadEditorConfig({ ...env, PUBLIC_URL: 'https://docs.example.com' }).publicUrl).toBe(
      'https://edit.example.com',
    );
  });
});

describe('content security', () => {
  it('allows no inline script anywhere', () => {
    const scriptSrc = /script-src ([^;]*)/.exec(EDITOR_CSP)?.[1];
    expect(scriptSrc).toBe("'self'");
    expect(EDITOR_CSP).toContain("frame-ancestors 'none'");
    expect(PREVIEW_CSP).not.toContain('script-src');
    expect(PREVIEW_CSP).toContain("default-src 'none'");
  });

  it('serves a self-contained editor script', () => {
    const script = editorScript();
    // Parses as a standalone script and references nothing from module scope.
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toMatch(/\bimport\b|\brequire\(/);
  });
});
