import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Files the build reads as text. Everything else is only checked for existence. */
const TEXT_EXTENSIONS = new Set([
  '.dita',
  '.ditamap',
  '.bookmap',
  '.ditaval',
  '.xml',
  '.yaml',
  '.yml',
]);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.opend', 'dist']);

/** The input of a build: every file in a docs source tree, with text files read. */
export interface SourceTree {
  /** Every file, docs-root-relative with `/` separators. */
  files: Set<string>;
  /** Contents of DITA, DITAVAL and YAML files. */
  texts: Map<string, string>;
  /** Set when the tree was read from a git ref rather than the working tree. */
  ref?: string;
}

function isText(file: string): boolean {
  return TEXT_EXTENSIONS.has(posix.extname(file).toLowerCase());
}

/** Reads a working tree from disk. */
export async function readDirectory(root: string): Promise<SourceTree> {
  const files = new Set<string>();
  const texts = new Map<string, string>();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    const rel = relative(root, abs).split(sep).join('/');
    if (rel.split('/').some((part) => IGNORED_DIRS.has(part))) continue;
    files.add(rel);
    if (isText(rel)) texts.set(rel, await readFile(abs, 'utf8'));
  }
  return { files, texts };
}

/**
 * Reads the docs tree as it is at a git ref (a release branch or tag), without
 * touching the working tree. `root` may be a subdirectory of the repository.
 */
export async function readGitRef(root: string, ref: string): Promise<SourceTree> {
  const git = async (args: string[]) =>
    (await run('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' })).stdout;
  // Paths are printed relative to `root` because git runs there.
  const listing = await git(['ls-tree', '-r', '--name-only', '-z', ref, '--', '.']);
  const files = new Set<string>();
  const texts = new Map<string, string>();
  for (const rel of listing.split('\0').filter(Boolean)) {
    if (rel.split('/').some((part) => IGNORED_DIRS.has(part))) continue;
    files.add(rel);
    if (isText(rel)) texts.set(rel, await git(['show', `${ref}:./${rel}`]));
  }
  return { files, texts, ref };
}

/** Reads one file's bytes from the working tree or, with `ref`, from git. */
export async function readSourceFile(root: string, path: string, ref?: string): Promise<Buffer> {
  if (ref === undefined) return readFile(join(root, ...path.split('/')));
  const { stdout } = await run('git', ['show', `${ref}:./${path}`], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'buffer',
  });
  return stdout;
}
