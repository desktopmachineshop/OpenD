import { FsBlobStore, type BlobStore } from './blobs.js';
import { S3BlobStore, type S3BlobStoreOptions } from './s3.js';

/** Where blobs live: a local folder, or a bucket that every replica and the worker can reach. */
export type BlobStoreConfig = { kind: 'fs'; dir: string } | ({ kind: 's3' } & S3BlobStoreOptions);

export function createBlobStore(config: BlobStoreConfig): BlobStore {
  if (config.kind === 'fs') return new FsBlobStore(config.dir);
  const { kind, ...options } = config;
  void kind;
  return new S3BlobStore(options);
}
