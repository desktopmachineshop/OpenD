import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Storage for build artifacts such as images: a local folder or an S3-compatible bucket. */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  /** `null` when the key does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Deletes every blob in the store (a site removed from a fleet). */
  clear?(): Promise<void>;
}

/** Rejects keys that could escape the store: absolute, `..`, backslashes or empty segments. */
export function assertSafeKey(key: string): void {
  const parts = key.split('/');
  if (
    key.includes('\\') ||
    key.includes('\0') ||
    parts.some((p) => p === '' || p === '.' || p === '..')
  ) {
    throw new Error(`unsafe blob key: ${JSON.stringify(key)}`);
  }
}

export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async put(key: string, data: Buffer): Promise<void> {
    assertSafeKey(key);
    const path = join(this.root, ...key.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);
    try {
      return await readFile(join(this.root, ...key.split('/')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

/**
 * Blob key for a file of the docs tree at a commit. Keyed by commit rather than
 * release so the worker can upload before the release row exists, and a
 * rebuild of the same commit overwrites identical bytes.
 */
export function assetKey(repoId: number, sha: string, path: string): string {
  return `repos/${repoId}/${sha}/${path}`;
}
