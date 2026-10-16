import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DocsRepo {
  /** Path usable as a repo's `source_url`. */
  dir: string;
  head(): string;
  /** Writes files (or deletes them with `null`), commits, and returns the new sha. */
  commit(files: Record<string, string | null>, message?: string): string;
  /** Creates or moves a branch to the current head. */
  branch(name: string): void;
  checkout(ref: string): void;
  remove(): void;
}

/** A throwaway git repository seeded from a docs folder. For tests and local demos. */
export function createDocsRepo(seedDir: string): DocsRepo {
  const dir = mkdtempSync(join(tmpdir(), 'opend-docs-repo-'));
  cpSync(seedDir, dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  return {
    dir,
    head: () => git('rev-parse', 'HEAD'),
    commit(files, message = 'change') {
      for (const [path, content] of Object.entries(files)) {
        if (content === null) rmSync(join(dir, path), { force: true });
        else writeFileSync(join(dir, path), content);
      }
      git('add', '-A');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD');
    },
    branch: (name) => void git('branch', '-f', name),
    checkout: (ref) => void git('checkout', '-q', ref),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
