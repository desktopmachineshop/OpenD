import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Storage for build artifacts such as images. Local folder now; S3-compatible later. */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  /** `null` when the key does not exist. */
  get(key: string): Promise<Buffer | null>;
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
}

/** Blob key for a release asset. */
export function assetKey(releaseId: number, path: string): string {
  return `releases/${releaseId}/${path}`;
}
